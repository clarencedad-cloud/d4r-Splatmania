import { WebPCodec } from '@playcanvas/splat-transform';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, path, Quat, RenderTarget, Vec3 } from 'playcanvas';

import type { CutFade } from './camera-poses';
import { ElementType } from './element';
import { EquirectRenderer } from './equirect-renderer';
import { Events } from './events';
import { encodeExr } from './exr-writer';
import { MovPngWriter } from './mov-writer';
import { OdsRenderer } from './ods-renderer';
import { encodePng } from './png-writer';
import { Scene } from './scene';
import { SequenceWriter } from './sequence-writer';
import { injectGPanoJpeg, injectGPanoPng, injectSphericalMetadata } from './spherical-metadata';
import { Splat } from './splat';
import { i18n } from './ui/localization';
import { buildVideoEncoderConfig, getVideoCodecType, VideoSettings } from './video-config';

const nullClr = new Color(0, 0, 0, 0);

// half float -> float
const halfF32 = new Float32Array(1);
const halfU32 = new Uint32Array(halfF32.buffer);
const halfToFloat = (h: number) => {
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    const sign = h & 0x8000 ? -1 : 1;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 31) return mant ? NaN : sign * Infinity;
    halfU32[0] = ((h & 0x8000) << 16) | ((exp + 112) << 23) | (mant << 13);
    return halfF32[0];
};

// Lookup maps for video output format and codec configuration
const FORMAT_CONFIG: Record<string, { create: (streaming: boolean) => Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat; extension: string }> = {
    mp4: { create: streaming => new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mp4' },
    webm: { create: () => new WebMOutputFormat(), extension: 'webm' },
    mov: { create: streaming => new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mov' },
    mkv: { create: () => new MkvOutputFormat(), extension: 'mkv' }
};

// backpressure high-water mark for the encoder queue and pending muxer writes
const MAX_QUEUE_SIZE = 5;

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'png' | 'jpeg' | 'webp' | 'exr';
    quality?: number;           // 0..1, jpeg only
    // exr: add a Z channel (camera depth), standard projection only
    depth?: boolean;
    // 'stereo': omnidirectional stereo, top-bottom (left eye on top), 1:1
    projection?: 'standard' | 'equirect' | 'stereo';
    levelHorizon?: boolean;
    stereo?: StereoSettings;
    // where the panorama is taken from (360 only); default: the current view
    source?: PanoramaSource;
    // set per job by the export flow (see render.panoramaJobs)
    job?: PanoramaJob;
    // download filename (without extension) when no file stream is given
    filename?: string;
};

type StereoSettings = {
    // eye separation in scene units (6.4 cm in a metric scene)
    ipd: number;
    // elevation (deg) where the stereo fades into mono towards the poles
    poleStart: number;
    // azimuth strips per eye
    segments: number;
};

type PanoramaSource = {
    mode: 'view' | 'camera' | 'cameraKeys' | 'allCameras' | 'allCameraKeys',
    cameraId?: number,
    // panorama centre faces world -z instead of the camera's view direction
    north?: boolean
};

// one panorama to render: capture position and heading (deg, like camera azim)
type PanoramaJob = {
    position: [number, number, number],
    yaw: number,
    // file name suffix, e.g. "_Kamera 1_f30"
    suffix: string
};

const DEFAULT_STEREO: StereoSettings = { ipd: 0.064, poleStart: 50, segments: 112 };

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const isInvalidFilenameChar = (char: string) => {
    return /[<>:"/\\|?*]/.test(char) || char.charCodeAt(0) < 32;
};

const sanitizeFilename = (filename: string) => {
    const sanitized = Array.from(filename, char => (isInvalidFilenameChar(char) ? '_' : char)).join('').trim();
    return sanitized.length > 0 ? sanitized : 'splatmania';
};

// extract a plain filename from url-style names (e.g. splats imported via ?load=)
const getImportedFilename = (filename: string) => {
    const trimmed = filename.split(/[?#]/)[0];

    if (trimmed.includes('://') || trimmed.startsWith('blob:')) {
        try {
            return path.getBasename(new URL(trimmed).pathname);
        } catch {
            // fall through to the raw filename below
        }
    }

    return path.getBasename(trimmed);
};

// sorting is submitted on the GPU immediately before each render
const sortSplatsAndWait = (_scene: Scene, _splats: Splat[]) => Promise.resolve();

const downloadFile = (data: ArrayBuffer | Uint8Array<ArrayBuffer> | Blob, filename: string, type = 'application/octet-stream') => {
    const blob = new Blob([data], { type });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let webpCodec: WebPCodec;

    // default base filename for rendered output: the project document name if
    // set, otherwise the first visible splat's name
    const baseFilename = () => {
        const docName = events.invoke('doc.name');
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const source = docName || (splats[0]?.name ?? 'splatmania');
        return sanitizeFilename(removeExtension(getImportedFilename(source)));
    };

    events.function('render.baseFilename', baseFilename);

    // largest render target dimension the device supports; used by the render
    // dialogs to disable resolutions the gpu cannot produce
    events.function('render.maxTextureSize', () => scene.graphicsDevice.maxTextureSize);

    // wait for postrender to fire
    const postRender = () => {
        return new Promise<boolean>((resolve, reject) => {
            const handle = scene.events.on('postrender', () => {
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    // camera depth per pixel (rows top-down) of the current offscreen frame,
    // for the EXR Z channel: the picker's depth pass per visible layer, the
    // nearest wins. Empty pixels get 1e10 (as Blender writes them). Uses the
    // camera colour target, so call it after the colour has been read
    const EMPTY_DEPTH = 1e10;
    const captureDepth = async (width: number, height: number) => {
        const depth = new Float32Array(width * height).fill(EMPTY_DEPTH);
        const halves = new Uint16Array(width * height * 4);
        const { camera } = scene;
        const near = camera.near;
        const far = camera.far;
        const target = camera.colorTarget;
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        for (const splat of splats) {
            scene.projectedSplatRenderer.renderSortedForPick();
            camera.picker.prepareDepth(splat);
            await target.colorBuffer.read(0, 0, width, height, { renderTarget: target, data: halves, immediate: true });
            for (let i = 0; i < depth.length; i++) {
                const alpha = 1 - halfToFloat(halves[i * 4 + 3]);
                if (alpha < 0.02) continue;
                const d = halfToFloat(halves[i * 4]) / alpha * (far - near) + near;
                if (d < depth[i]) depth[i] = d;
            }
        }
        return depth;
    };

    // premultiplied -> straight alpha (png, webm alpha)
    const unpremultiply = (src: Uint8Array, dst: Uint8Array) => {
        for (let i = 0; i < src.length; i += 4) {
            const a = src[i + 3];
            if (a === 0 || a === 255) {
                dst[i] = src[i];
                dst[i + 1] = src[i + 1];
                dst[i + 2] = src[i + 2];
            } else {
                const k = 255 / a;
                dst[i] = Math.min(255, src[i] * k + 0.5);
                dst[i + 1] = Math.min(255, src[i + 1] * k + 0.5);
                dst[i + 2] = Math.min(255, src[i + 2] * k + 0.5);
            }
            dst[i + 3] = a;
        }
        return dst;
    };

    // direction-independent clipping planes around a capture point, shared
    // by all faces / strips so near-plane culling cannot differ at a seam
    const panoramaClip = (position: Vec3, margin = 0) => {
        const boundRadius = scene.bound.halfExtents.length() + margin;
        const dist = new Vec3().sub2(scene.bound.center, position).length();
        const far = dist + boundRadius;
        const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);
        return { near, far };
    };

    const qWorld = new Quat();
    const qStrip = new Quat();
    const eyeRight = new Vec3();
    const eyePos = new Vec3();

    // capture a 360 panorama at position with the capture-space rotation
    // into data: mono (equirect, 6 cube faces) or omnidirectional stereo
    // (ods: 6 mono faces for the poles plus 2 x N strips, top-bottom output)
    // the look (src/look/look.ts) runs on the finished equirect image, not
    // per cube face or strip, so its glow and grain have no seams
    const lookPanorama = (target: RenderTarget) => {
        if (events.functions.has('look.applyPanorama')) events.invoke('look.applyPanorama', target);
    };

    const capturePanoramaImpl = async (p: {
        position: Vec3,
        rotation: Quat,
        equirect: EquirectRenderer | null,
        ods: OdsRenderer | null,
        faceSize: number,
        data: Uint8Array,
        render: () => Promise<void>,
        cancelled: () => boolean,
        progress: (fraction: number) => void
    }) => {
        const { position, rotation, equirect, ods, data } = p;
        const { near, far } = panoramaClip(position, ods ? ods.options.ipd : 0);
        const steps = 6 + (ods ? 2 * ods.segments : 0);
        let done = 0;

        // six cube faces: the mono panorama (for stereo the pole fill)
        const faces = ods ? ods.mono.faceTargets : equirect.faceTargets;
        if (ods) scene.camera.startOffscreenMode(p.faceSize, p.faceSize);
        for (let face = 0; face < 6; face++) {
            if (p.cancelled()) return false;
            qWorld.mul2(rotation, EquirectRenderer.faceRotations[face]);
            scene.camera.setPoseOverride({ position, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });
            await p.render();
            scene.dataProcessor.copyRt(scene.camera.mainTarget, faces[face]);
            p.progress(++done / steps);
        }

        if (!ods) {
            equirect.project();
            lookPanorama(equirect.equirectTarget);
            await equirect.read(data);
            return true;
        }

        ods.projectMono();

        // strips: per eye and azimuth a narrow perspective view from the eye
        // point tangent to the ipd circle, yaw only (pitch 0)
        scene.camera.startOffscreenMode(ods.stripWidth, ods.stripHeight);
        ods.clearEyes();
        for (let eye = 0; eye < 2; eye++) {
            for (let k = 0; k < ods.segments; k++) {
                if (p.cancelled()) return false;
                const azimuth = ods.azimuth(k);
                qStrip.setFromEulerAngles(0, -azimuth * 180 / Math.PI, 0);
                qWorld.mul2(rotation, qStrip);
                // the strip camera's right axis in capture space, then world
                eyeRight.set(Math.cos(azimuth), 0, Math.sin(azimuth));
                rotation.transformVector(eyeRight, eyeRight);
                eyePos.copy(position).addScaled(eyeRight, ods.eyeOffset(eye));
                scene.camera.setPoseOverride({ position: eyePos, rotation: qWorld, fov: ods.stripFov, near, far });
                await p.render();
                scene.dataProcessor.copyRt(scene.camera.mainTarget, ods.stripTarget);
                ods.compositeStrip(eye, k);
                p.progress(++done / steps);
            }
        }

        ods.eyeTargets.forEach(lookPanorama);

        // top: left eye, bottom: right eye
        const half = ods.eyeWidth * ods.eyeHeight * 4;
        await ods.read(0, data.subarray(0, half));
        await ods.read(1, data.subarray(half, 2 * half));
        return true;
    };

    const capturePanorama = async (p: {
        position: Vec3,
        rotation: Quat,
        equirect: EquirectRenderer | null,
        ods: OdsRenderer | null,
        faceSize: number,
        data: Uint8Array,
        // trigger a render and wait for it
        render: () => Promise<void>,
        cancelled: () => boolean,
        progress: (fraction: number) => void
    }) => {
        const suppress = events.functions.has('look.suppress');
        if (suppress) events.invoke('look.suppress', true);
        try {
            return await capturePanoramaImpl(p);
        } finally {
            if (suppress) events.invoke('look.suppress', false);
        }
    };

    // live viewport preview of a 360 camera (src/ui/panorama-preview.ts): a
    // small mono equirect at position, level, centred on heading yaw (deg).
    // Exports wait for a running preview; a preview skips while exporting.
    // previewing is the offscreen lock shared by render.panoramaPreview,
    // render.posePreview and render.offscreen
    let exporting = false;
    let previewing = false;
    let previewEquirect: EquirectRenderer | null = null;
    events.function('render.exporting', () => exporting);

    const beginExport = async () => {
        exporting = true;
        // the flag is cleared by the running preview's finally block
        // eslint-disable-next-line no-unmodified-loop-condition
        while (previewing) await postRender();
    };

    events.function('render.panoramaPreview', async (position: Vec3, yaw: number, width: number): Promise<Uint8Array | null> => {
        if (exporting || previewing || !scene.bound) return null;
        previewing = true;
        const height = Math.floor(width / 2);
        const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);
        if (!previewEquirect || previewEquirect.equirectTarget.width !== width) {
            previewEquirect?.destroy();
            previewEquirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
        }
        const savedFov = scene.camera.fov;
        const savedOrtho = scene.camera.ortho;
        const data = new Uint8Array(width * height * 4);
        try {
            scene.camera.startOffscreenMode(faceSize, faceSize);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            scene.centersLayer.enabled = false;
            scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            scene.camera.ortho = false;
            scene.lockedRenderMode = true;
            const ok = await capturePanorama({
                position,
                rotation: new Quat().setFromEulerAngles(0, yaw, 0),
                equirect: previewEquirect,
                ods: null,
                faceSize,
                data,
                render: async () => {
                    scene.lockedRender = true;
                    await postRender();
                },
                cancelled: () => false,
                progress: () => {}
            });
            return ok ? data : null;
        } finally {
            scene.camera.setPoseOverride(null);
            scene.camera.fov = savedFov;
            scene.camera.ortho = savedOrtho;
            scene.lockedRenderMode = false;
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.centersLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.forceRender = true;
            previewing = false;
        }
    });

    const sleep = (ms: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

    // resolves once the page is visible: the browser stops
    // requestAnimationFrame in a hidden tab, so no frame (and no postrender)
    // comes until then. false when aborted first
    const whenVisible = (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        if (!document.hidden) {
            resolve(true);
            return;
        }
        const cleanup: (() => void)[] = [];
        const done = (value: boolean) => {
            cleanup.forEach(fn => fn());
            resolve(value);
        };
        const onChange = () => {
            if (!document.hidden) done(true);
        };
        const onAbort = () => done(false);
        document.addEventListener('visibilitychange', onChange);
        signal?.addEventListener('abort', onAbort);
        cleanup.push(
            () => document.removeEventListener('visibilitychange', onChange),
            () => signal?.removeEventListener('abort', onAbort)
        );
    });

    // the next rendered frame like postRender, but false (and no dangling
    // listener) when aborted first
    const renderedFrame = (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        const cleanup: (() => void)[] = [];
        const done = (value: boolean) => {
            cleanup.forEach(fn => fn());
            resolve(value);
        };
        const onAbort = () => done(false);
        const handle = scene.events.on('postrender', () => done(true));
        signal?.addEventListener('abort', onAbort);
        cleanup.push(
            () => handle.off(),
            () => signal?.removeEventListener('abort', onAbort)
        );
    });

    // a still of an arbitrary camera pose (shot suggestions, src/ai-shots)
    // without moving the viewport: fov is the longer image axis like a shot
    // camera, focus / aperture override the rendered lens for this frame.
    // Waits for a hidden tab to become visible and briefly for another
    // offscreen user (360 preview, flood selection); null when busy,
    // exporting or aborted (signal)
    const previewPos = new Vec3();
    const previewFwd = new Vec3();
    const previewRot = new Quat();
    events.function('render.posePreview', async (pose: { position: Vec3, target: Vec3, fov: number, focus?: number, aperture?: number }, width: number, height: number, signal?: AbortSignal): Promise<HTMLCanvasElement | null> => {
        // not while hidden: the lock would be held until the tab shows again
        if (!await whenVisible(signal)) return null;
        const deadline = performance.now() + 2000;
        // eslint-disable-next-line no-unmodified-loop-condition
        while (previewing && !exporting && performance.now() < deadline) {
            if (signal?.aborted) return null;
            await sleep(16);
        }
        if (signal?.aborted || exporting || previewing || scene.suspendRender || !scene.bound) return null;

        const maxSize = scene.graphicsDevice.maxTextureSize;
        const w = Math.max(1, Math.min(maxSize, Math.round(width)));
        const h = Math.max(1, Math.min(maxSize, Math.round(height)));
        previewPos.set(pose.position.x, pose.position.y, pose.position.z);
        previewFwd.set(pose.target.x - previewPos.x, pose.target.y - previewPos.y, pose.target.z - previewPos.z);
        const l = previewFwd.length();
        if (!(l > 1e-9) || !(pose.fov > 0)) return null;
        previewFwd.mulScalar(1 / l);
        const azim = Math.atan2(-previewFwd.x, -previewFwd.z) * 180 / Math.PI;
        const elev = Math.asin(Math.max(-1, Math.min(1, previewFwd.y))) * 180 / Math.PI;
        previewRot.setFromEulerAngles(elev, azim, 0);

        // clipping planes as the viewport fits them (camera.fitClippingPlanes)
        const bound = scene.bound;
        const boundRadius = bound.halfExtents.length();
        const dist = new Vec3().sub2(bound.center, previewPos).dot(previewFwd);
        const far = Math.max(dist + boundRadius, 1e-2);
        const near = Math.min(1, Math.max(dist - boundRadius, far / (1024 * 16)));

        previewing = true;
        const savedFov = scene.camera.fov;
        const savedOrtho = scene.camera.ortho;
        const dof = events.functions.has('dof.state') ? events.invoke('dof.state') : null;
        const savedLens = dof ? { focus: dof.focus as number, aperture: dof.aperture as number } : null;
        const lensChanged = savedLens && (pose.focus !== undefined || pose.aperture !== undefined);

        // The camera rig may change the viewport lens while this still
        // renders (timeline playback, a focus slider, camera.setPose): restore
        // only what this preview changed itself and keep what the rig set in
        // the meantime. Its changes arrive as camera.fov / camera.ortho /
        // dof.lens events. Re-running the rig (camera.applyView) instead would
        // snap the viewport onto the followed camera and so throw away a
        // navigation in progress while looking through it.
        let rigFov: number | null = null;
        let rigOrtho: boolean | null = null;
        let rigLens = false;
        let ownLens = false;
        const fireLens = (value: { focus: number, aperture: number }) => {
            ownLens = true;
            try {
                events.fire('dof.lens', value);
            } finally {
                ownLens = false;
            }
        };
        const handles: { off: () => void }[] = [
            events.on('camera.fov', (value: number) => {
                rigFov = value;
            }),
            events.on('dof.lens', () => {
                if (!ownLens) rigLens = true;
            })
        ];
        try {
            if (lensChanged) {
                fireLens({
                    focus: pose.focus !== undefined ? Math.max(0.01, pose.focus) : savedLens.focus,
                    aperture: pose.aperture !== undefined ? Math.max(0, pose.aperture) : savedLens.aperture
                });
            }
            scene.camera.startOffscreenMode(w, h);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            scene.centersLayer.enabled = false;
            scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            scene.camera.ortho = false;
            handles.push(events.on('camera.ortho', (value: boolean) => {
                rigOrtho = value;
            }));
            scene.lockedRenderMode = true;

            // two frames, the first one discarded: the first frame after the
            // switch to the small offscreen target and the jump to the
            // override pose may still carry per-frame state of the viewport
            // (renderer caches sized and keyed on the previous frame, the
            // projection / view matrices the camera system only re-evaluates
            // in its prerender). The second frame is fully settled. Both get
            // the override applied right before (setPoseOverride runs
            // camera.onUpdate, which refreshes the projection)
            for (let pass = 0; pass < 2; pass++) {
                scene.camera.setPoseOverride({ position: previewPos, rotation: previewRot, fov: pose.fov, near, far });
                scene.lockedRender = true;
                // a tab hidden meanwhile renders nothing until it shows again;
                // the signal (cancel) still ends the wait
                if (!await renderedFrame(signal)) return null;
            }

            const data = new Uint8Array(w * h * 4);
            const { mainTarget, workTarget } = scene.camera;
            scene.dataProcessor.copyRt(mainTarget, workTarget);
            // immediate: see render.offscreen
            await workTarget.colorBuffer.read(0, 0, w, h, { renderTarget: workTarget, data, immediate: true });
            for (let i = 3; i < data.length; i += 4) data[i] = 255;

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w, h), 0, 0);
            return canvas;
        } finally {
            handles.forEach(handle => handle.off());
            scene.camera.setPoseOverride(null);
            // the override wrote its fov each frame over whatever the rig set
            scene.camera.fov = rigFov ?? savedFov;
            scene.camera.ortho = rigOrtho ?? savedOrtho;
            scene.lockedRender = false;
            scene.lockedRenderMode = false;
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.centersLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            // a lens the rig pushed meanwhile is already the current one
            if (lensChanged && !rigLens) fireLens(savedLens);
            scene.forceRender = true;
            previewing = false;
        }
    });

    // the panoramas a source asks for: capture point and heading per camera
    // (or key); the horizon is always level, only the camera's yaw is used
    events.function('render.panoramaJobs', (source: PanoramaSource | undefined): PanoramaJob[] => {
        if (!source || source.mode === 'view') return [];
        const cameras = (events.invoke('shotCameras.list') ?? []) as { id: number, name: string, track: any }[];
        const frame = Math.round(events.invoke('timeline.frame') ?? 0);
        const safe = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');
        const jobs: PanoramaJob[] = [];
        const add = (camera: { name: string, track: any }, f: number) => {
            const pose = camera.track.getPoseAt(f);
            if (!pose) return;
            const dx = pose.target.x - pose.position.x;
            const dz = pose.target.z - pose.position.z;
            // camera azim convention: yaw 0 looks down -z, positive turns left
            const yaw = source.north || (dx === 0 && dz === 0) ? 0 : Math.atan2(-dx, -dz) * 180 / Math.PI;
            jobs.push({ position: [pose.position.x, pose.position.y, pose.position.z], yaw, suffix: `_${safe(camera.name)}_f${f}` });
        };
        const keysOf = (camera: { track: any }) => [...camera.track.keys].sort((a: number, b: number) => a - b);
        if (source.mode === 'allCameras') {
            cameras.forEach(camera => add(camera, frame));
        } else if (source.mode === 'allCameraKeys') {
            cameras.forEach(camera => keysOf(camera).forEach((f: number) => add(camera, f)));
        } else {
            const camera = cameras.find(c => c.id === source.cameraId);
            if (camera && source.mode === 'camera') add(camera, frame);
            if (camera && source.mode === 'cameraKeys') {
                keysOf(camera).forEach((f: number) => add(camera, f));
            }
        }
        return jobs;
    });

    // the viewport camera into an offscreen buffer (flood selection). Shares
    // the offscreen lock (previewing) with the pose / 360 previews: the
    // camera has one target size override and one pose override, so it waits
    // for a running preview (a few frames) and then holds the lock itself,
    // which makes previews skip / wait and exports wait in turn
    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        // eslint-disable-next-line no-unmodified-loop-condition
        while (previewing) await sleep(16);
        previewing = true;
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            scene.centersLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame. the read must be immediate: nothing
            // submits the shared command encoder outside the frame, so a
            // deferred read maps the staging buffer before the copy above has
            // run and returns zeros.
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

            // rows are read back top-down (0,0 at the top)
            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.centersLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
            scene.forceRender = true;       // repaint the viewport with normal rendering
            previewing = false;
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings, fileStream?: FileSystemWritableFileStream) => {
        await beginExport();
        const isStereo = imageSettings.projection === 'stereo';

        // stereo renders take a while: progress with cancel instead of the spinner
        let cancelled = false;
        const cancelHandler = isStereo ? events.on('progressCancel', () => {
            cancelled = true;
        }) : null;
        if (isStereo) {
            events.fire('progressStart', i18n.t('sm.render.stereo-progress'), true);
        } else {
            events.fire('startSpinner');
        }

        let equirect: EquirectRenderer | null = null;
        let ods: OdsRenderer | null = null;
        let savedFov = 0;
        let savedOrtho = false;

        try {
            const { width, height, transparentBg, showDebug, format, quality, projection, levelHorizon, job, depth: withDepth } = imageSettings;
            let depthData: Float32Array | null = null;
            const is360 = projection === 'equirect' || isStereo;

            // stereo output is top-bottom: each eye is width x height / 2
            const eyeHeight = isStereo ? Math.floor(height / 2) : height;

            // in 360 mode the offscreen target is a square cube face; the
            // equirect target holds the output-sized frame
            const faceSize = Math.min(eyeHeight, scene.graphicsDevice.maxTextureSize);

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
            scene.camera.renderOverlays = is360 ? false : showDebug;
            scene.gizmoLayer.enabled = false;
            scene.centersLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            if (is360) {
                savedFov = scene.camera.fov;
                savedOrtho = scene.camera.ortho;
                if (isStereo) {
                    ods = new OdsRenderer(scene.graphicsDevice, width, eyeHeight, { ...DEFAULT_STEREO, ...imageSettings.stereo });
                } else {
                    equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                }
                scene.camera.ortho = false;
                // captures always take the clean sorted path: with the
                // camera jumping between faces / strips the adaptive
                // stochastic mode would otherwise kick in (noise, smears)
                scene.lockedRenderMode = true;

                // capture pose: a camera / key job (level, its yaw), or a
                // snapshot of the current view. supersplat cameras never
                // roll, so with level horizon the capture frame is the
                // camera yaw, otherwise yaw and pitch
                const camPos = new Vec3();
                const qCapture = new Quat();
                if (job) {
                    camPos.set(job.position[0], job.position[1], job.position[2]);
                    qCapture.setFromEulerAngles(0, job.yaw, 0);
                } else {
                    camPos.copy(scene.camera.position);
                    if (levelHorizon ?? true) {
                        qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }
                }

                const ok = await capturePanorama({
                    position: camPos,
                    rotation: qCapture,
                    equirect,
                    ods,
                    faceSize,
                    data,
                    render: async () => {
                        scene.lockedRender = true;
                        await postRender();
                    },
                    cancelled: () => cancelled,
                    progress: (fraction) => {
                        if (isStereo) {
                            events.fire('progressUpdate', { text: i18n.t('panel.render.rendering', { ellipsis: true }), progress: 100 * fraction });
                        }
                    }
                });
                if (!ok) {
                    if (fileStream) {
                        await fileStream.close();
                    }
                    return false;
                }
            } else {
                // render the next frame
                scene.forceRender = true;

                // for render to finish
                await postRender();

                const { mainTarget, workTarget } = scene.camera;

                scene.dataProcessor.copyRt(mainTarget, workTarget, scene.overdrawRender);

                // read the rendered frame (immediate: see render.offscreen)
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                if (format === 'exr' && withDepth) depthData = await captureDepth(width, height);

                // titles (src/titles.ts) at the current frame
                if (events.functions.has('titles.drawOnPixels')) {
                    events.invoke('titles.drawOnPixels', data, width, height, events.invoke('timeline.frame') ?? 0);
                }
            }

            let bytes: Uint8Array<ArrayBuffer>;
            let extension: string;
            let mimeType: string;

            if (format === 'exr') {
                bytes = await encodeExr(data, width, height, depthData) as Uint8Array<ArrayBuffer>;
                extension = 'exr';
                mimeType = 'image/x-exr';
            } else if (format === 'png') {
                bytes = await encodePng(transparentBg ? unpremultiply(data, new Uint8Array(data.length)) : data, width, height);
                extension = 'png';
                mimeType = 'image/png';
            } else if (format === 'jpeg') {
                // jpeg has no alpha channel and canvas encoding flattens
                // transparent pixels toward black, so force full opacity
                for (let i = 3; i < data.length; i += 4) {
                    data[i] = 255;
                }

                const imageData = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
                let blob: Blob;
                if (typeof OffscreenCanvas !== 'undefined') {
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                } else {
                    // fallback for browsers without OffscreenCanvas
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode jpeg'))), 'image/jpeg', quality ?? 0.9);
                    });
                }
                bytes = new Uint8Array(await blob.arrayBuffer());
                extension = 'jpg';
                mimeType = 'image/jpeg';
            } else {
                // construct the webp codec
                if (!webpCodec) {
                    webpCodec = await WebPCodec.create();
                }

                bytes = webpCodec.encodeLosslessRGBA(data, width, height);
                extension = 'webp';
                mimeType = 'image/webp';
            }

            // mono panoramas: GPano xmp so photo viewers open them as 360.
            // GPano has no top-bottom stereo mode (a tag would make viewers
            // show the stacked eyes as one distorted pano), so stereo images
            // rely on the _TB name suffix instead
            if (projection === 'equirect') {
                try {
                    if (format === 'jpeg') bytes = injectGPanoJpeg(bytes, width, height) as Uint8Array<ArrayBuffer>;
                    if (format === 'png') bytes = injectGPanoPng(bytes, width, height) as Uint8Array<ArrayBuffer>;
                } catch (error) {
                    console.warn(`failed to add GPano metadata: ${error.message ?? error}`);
                }
            }

            if (fileStream) {
                await fileStream.write(bytes);
                await fileStream.close();
            } else {
                const name = imageSettings.filename ?? `${baseFilename()}${job?.suffix ?? ''}${isStereo ? '_TB' : ''}`;
                downloadFile(bytes, `${name}.${extension}`, mimeType);
            }

            return true;
        } catch (error) {
            // close the stream even on failure so the caller can remove the
            // empty file
            if (fileStream) {
                try {
                    await fileStream.close();
                } catch {
                    // stream already closed or errored
                }
            }

            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.render.failed'),
                message: `'${error.message ?? error}'`
            });

            return false;
        } finally {
            if (equirect || ods) {
                scene.camera.setPoseOverride(null);
                scene.camera.fov = savedFov;
                scene.camera.ortho = savedOrtho;
                scene.lockedRenderMode = false;
                equirect?.destroy();
                equirect = null;
                ods?.destroy();
                ods = null;
            }

            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.centersLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.forceRender = true;       // repaint the viewport with normal rendering
            exporting = false;

            if (isStereo) {
                cancelHandler.off();
                events.fire('progressEnd');
            } else {
                events.fire('stopSpinner');
            }
        }
    });

    events.function('render.video', (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        const renderImpl = async () => {
            await beginExport();
            events.fire('progressStart', i18n.t('panel.render.render-video'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;
            let equirect: EquirectRenderer | null = null;
            let ods: OdsRenderer | null = null;
            let savedFov = 0;
            let savedOrtho = false;
            let output: Output | null = null;
            let muxerWrites = Promise.resolve();
            // closes alpha frames left over by a failed or cancelled render
            let alphaFramesCleanup = () => {};

            try {
                const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice, projection, levelHorizon } = videoSettings;

                // frames written by us instead of a WebCodecs encoder:
                // QuickTime with PNG frames, PNG / EXR image sequences
                const rawFormat = format === 'png-seq' || format === 'exr-seq' || (format === 'mov' && codecChoice === 'png') ? format : null;
                // WebM with an alpha channel (VP9 / AV1, encoded as a second
                // stream in series, like mediabunny does)
                const alphaVideo = !rawFormat && transparentBg && format === 'webm';

                const isStereo = projection === 'stereo';
                const is360 = projection === 'equirect' || isStereo;
                // stereo frames are top-bottom: each eye is width x height / 2
                const eyeHeight = isStereo ? Math.floor(height / 2) : height;

                // drive the camera from the chosen shot camera / cut track
                const shot = videoSettings.shot;
                if (shot && shot.mode !== 'all') {
                    events.invoke('camera.setRenderOverride', { mode: shot.mode, cameraId: shot.cameraId });
                }

                // 360 mp4/mov exports have spherical metadata patched into the
                // finished buffer, so they render to memory with moov written
                // last (fastStart false) instead of streaming to disk
                const taggable = !rawFormat && is360 && (format === 'mp4' || format === 'mov');

                const target = rawFormat ? null : ((fileStream && !taggable) ? new StreamTarget(fileStream) : new BufferTarget());

                // Configure output format and codec from lookup maps (default to mp4/h264)
                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = rawFormat ? null : formatConfig.create(taggable || !!fileStream);
                const fileExtension = rawFormat === 'mov' ? 'mov' : (rawFormat ? 'zip' : formatConfig.extension);

                const encoderConfig = rawFormat ? null : buildVideoEncoderConfig(videoSettings);
                const codecType = rawFormat ? null : getVideoCodecType(codecChoice);

                let videoSource: EncodedVideoPacketSource | null = null;
                if (!rawFormat) {
                    output = new Output({
                        format: outputFormat,
                        target
                    });

                    videoSource = new EncodedVideoPacketSource(codecType);
                    output.addVideoTrack(videoSource, {
                        rotation: 0,
                        frameRate
                    });

                    await output.start();
                }

                // raw outputs
                const movWriter = rawFormat === 'mov' ? new MovPngWriter(fileStream ?? null, width, height, frameRate, transparentBg) : null;
                await movWriter?.start();
                const sequence = rawFormat === 'png-seq' || rawFormat === 'exr-seq' ? new SequenceWriter(videoSettings.directory ?? null) : null;
                const straight = (rawFormat === 'png-seq' || rawFormat === 'mov' || alphaVideo) && transparentBg ? new Uint8Array(width * height * 4) : null;
                let rawIndex = 0;

                let encoderError: Error | null = null;
                let muxerError: Error | null = null;
                let muxerQueueSize = 0;

                // alpha video: alpha frames waiting for their colour chunk,
                // colour chunks waiting for their alpha chunk
                let alphaEncoder: VideoEncoder | null = null;
                const alphaFrames: VideoFrame[] = [];
                alphaFramesCleanup = () => {
                    alphaFrames.forEach(frame => frame.close());
                    alphaFrames.length = 0;
                    if (alphaEncoder && alphaEncoder.state !== 'closed') alphaEncoder.close();
                };
                const colorChunks: { chunk: EncodedVideoChunk, meta: any }[] = [];

                // helper to create and configure a VideoEncoder instance
                const createEncoder = () => {
                    encoderError = null;
                    const writePacket = (chunk: EncodedVideoChunk, meta: any, alphaChunk: EncodedVideoChunk | null) => {
                        let sideData;
                        if (alphaChunk) {
                            const alpha = new Uint8Array(alphaChunk.byteLength);
                            alphaChunk.copyTo(alpha);
                            sideData = { alpha };
                        }
                        const encodedPacket = EncodedPacket.fromEncodedChunk(chunk, sideData);
                        muxerQueueSize++;

                        // WebCodecs ignores a Promise returned by its output
                        // callback: awaiting the muxer here provides no
                        // backpressure, and a rejected write becomes an
                        // unhandled rejection that silently drops packets
                        // from the finished file. Chain the writes instead
                        // so failures surface via muxerError, muxerQueueSize
                        // drives backpressure in the encode loop, and every
                        // write has settled before output.finalize().
                        muxerWrites = muxerWrites
                        .then(async () => {
                            if (!muxerError) {
                                await videoSource.add(encodedPacket, meta);
                            }
                        })
                        .catch((error) => {
                            muxerError = error instanceof Error ? error : new Error(String(error));
                        })
                        .finally(() => {
                            muxerQueueSize--;
                        });
                    };
                    if (alphaVideo) {
                        if (alphaEncoder && alphaEncoder.state !== 'closed') alphaEncoder.close();
                        alphaFrames.forEach(frame => frame.close());
                        alphaFrames.length = 0;
                        colorChunks.length = 0;
                        alphaEncoder = new VideoEncoder({
                            output: (chunk) => {
                                const color = colorChunks.shift();
                                if (color) writePacket(color.chunk, color.meta, chunk);
                            },
                            error: (error) => {
                                encoderError = error;
                            }
                        });
                        alphaEncoder.configure(encoderConfig);
                    }
                    const enc = new VideoEncoder({
                        output: (chunk, meta) => {
                            if (!alphaEncoder) {
                                writePacket(chunk, meta, null);
                                return;
                            }
                            // the alpha frame is a key frame whenever the
                            // colour frame is (players glitch otherwise)
                            const alphaFrame = alphaFrames.shift();
                            colorChunks.push({ chunk, meta });
                            alphaEncoder.encode(alphaFrame, { keyFrame: chunk.type === 'key' });
                            alphaFrame.close();
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure(encoderConfig);
                    return enc;
                };

                // fail fast on unsupported configurations (e.g. encoder
                // dimension limits) instead of erroring mid-render
                if (!rawFormat) {
                    const support = await VideoEncoder.isConfigSupported(encoderConfig);
                    if (!support.supported) {
                        throw new Error(`Unsupported video configuration (${codecChoice} @ ${width}x${height})`);
                    }

                    encoder = createEncoder();
                }

                // in 360 mode the offscreen target is a square cube face; the
                // equirect target holds the output-sized frame
                const faceSize = Math.min(eyeHeight, scene.graphicsDevice.maxTextureSize);

                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
                scene.camera.renderOverlays = is360 ? false : showDebug;
                scene.gizmoLayer.enabled = false;
                scene.centersLayer.enabled = false;
                if (!transparentBg) {
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                if (is360) {
                    savedFov = scene.camera.fov;
                    savedOrtho = scene.camera.ortho;
                    if (isStereo) {
                        ods = new OdsRenderer(scene.graphicsDevice, width, eyeHeight, { ...DEFAULT_STEREO, ...videoSettings.stereo });
                    } else {
                        equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                    }
                    scene.camera.ortho = false;
                }

                // cpu-side buffer to read pixels into
                const data = new Uint8Array(width * height * 4);

                // cut cross-fades: the outgoing camera's frame, rendered
                // first and mixed under the incoming one
                const fadeData = shot?.mode === 'cut' ? new Uint8Array(width * height * 4) : null;

                // remember last camera position so we can skip sorting if the camera didn't move
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // helper to sort splats and wait for completion
                const sortAndWait = (splats: Splat[]) => sortSplatsAndWait(scene, splats);

                // prepare the frame for rendering, returns the newly loaded splat if any
                const prepareFrame = async (frameTime: number, skipSort = false): Promise<Splat | null> => {
                    // Fire timeline.time for camera animation interpolation
                    events.fire('timeline.time', frameTime);

                    // Wait for PLY sequence to load the frame if present
                    const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                    // manually update the camera so position and rotation are correct
                    scene.camera.onUpdate(0);

                    // 360 capture re-sorts per cube face, so skip sorting here
                    if (skipSort) {
                        return newSplat;
                    }

                    // If a new PLY was loaded, sort and wait for completion
                    if (newSplat) {
                        await sortAndWait([newSplat]);
                    } else {
                        // No new PLY - sort existing splats if camera moved
                        const pos = scene.camera.position;
                        const forward = scene.camera.forward;
                        if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                            last_pos.copy(pos);
                            last_forward.copy(forward);

                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    return newSplat;
                };

                // write the pixels in the data buffer as a png / exr frame
                const writeRawFrame = async () => {
                    const index = rawIndex++;
                    const name = `${baseFilename()}${videoSettings.filenameSuffix ?? ''}_${String(index).padStart(5, '0')}`;
                    if (rawFormat === 'exr-seq') {
                        const depth = videoSettings.depth && !is360 ? await captureDepth(width, height) : null;
                        await sequence.add(`${name}.exr`, await encodeExr(data, width, height, depth));
                        return;
                    }
                    const png = await encodePng(straight ? unpremultiply(data, straight) : data, width, height);
                    if (movWriter) {
                        await movWriter.addFrame(png);
                    } else {
                        await sequence.add(`${name}.png`, png);
                    }
                };

                // wrap and submit the pixels currently in the data buffer
                const encodeFrame = async (frameTime: number) => {
                    if (rawFormat) {
                        await writeRawFrame();
                        return;
                    }

                    const timing = {
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: Math.floor(1e6 * frameTime),
                        duration: Math.floor(1e6 / frameRate)
                    };

                    // construct the video frame (alpha video: straight colour
                    // without alpha, plus the alpha as a grey I420 frame)
                    let videoFrame: VideoFrame;
                    if (alphaVideo) {
                        videoFrame = new VideoFrame(unpremultiply(data, straight), { format: 'RGBX', ...timing });
                        const pixels = width * height;
                        const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
                        const alphaBuffer = new Uint8Array(pixels + chroma * 2);
                        for (let i = 0, j = 3; i < pixels; i++, j += 4) alphaBuffer[i] = data[j];
                        alphaBuffer.fill(128, pixels);
                        alphaFrames.push(new VideoFrame(alphaBuffer, { format: 'I420', ...timing }));
                    } else {
                        videoFrame = new VideoFrame(data, { format: 'RGBA', ...timing });
                    }

                    // wait for encoder queue to drain if necessary (backpressure handling)
                    const queueFull = () => encoder.encodeQueueSize > MAX_QUEUE_SIZE || (alphaEncoder?.encodeQueueSize ?? 0) > MAX_QUEUE_SIZE;
                    while (queueFull()) {
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 1);
                        });
                    }
                    // muxerQueueSize is decremented by the write chain settling
                    // during the await
                    // eslint-disable-next-line no-unmodified-loop-condition
                    while (muxerQueueSize > MAX_QUEUE_SIZE) {
                        await muxerWrites;
                    }

                    // if the codec was reclaimed (e.g. browser backgrounded the tab),
                    // recreate the encoder and continue
                    let forceKeyFrame = false;
                    if (encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')) {
                        encoder = createEncoder();
                        forceKeyFrame = true;
                    }

                    // check for non-recoverable encoder errors
                    if (encoderError || muxerError) {
                        videoFrame.close();
                        throw encoderError ?? muxerError;
                    }

                    encoder.encode(videoFrame, { keyFrame: forceKeyFrame });
                    videoFrame.close();
                };

                // read the rendered frame into buffer (immediate: see render.offscreen)
                const readFrame = async (buffer: Uint8Array) => {
                    const { mainTarget, workTarget } = scene.camera;

                    scene.dataProcessor.copyRt(mainTarget, workTarget, scene.overdrawRender);

                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data: buffer, immediate: true });
                };

                // render the outgoing camera of a cut cross-fade into fadeData;
                // returns the incoming camera's weight, or null outside a fade
                const renderFadeFrom = async (animTime: number): Promise<number | null> => {
                    const fade = fadeData && events.invoke('cut.fadeAt', animTime) as CutFade | null;
                    if (!fade) return null;
                    events.invoke('camera.setRenderOverride', { mode: 'camera', cameraId: fade.from });
                    await prepareFrame(animTime);
                    scene.lockedRender = true;
                    await postRender();
                    await readFrame(fadeData);
                    events.invoke('camera.setRenderOverride', { mode: 'cut' });
                    return fade.alpha;
                };

                const mixFade = (alpha: number) => {
                    const a = Math.round(alpha * 256);
                    for (let i = 0; i < data.length; i++) {
                        data[i] = (fadeData[i] * (256 - a) + data[i] * a) >> 8;
                    }
                };

                const animFrameRate = events.invoke('timeline.frameRate');
                const duration = (endFrame - startFrame) / animFrameRate;

                // titles (src/titles.ts) over a finished standard frame
                const overlayTitles = (animTime: number) => {
                    if (events.functions.has('titles.drawOnPixels')) {
                        events.invoke('titles.drawOnPixels', data, width, height, animTime);
                    }
                };

                // motion blur (standard projection): sub-frames per frame
                const blurSamples = !is360 && videoSettings.motionBlur ? Math.max(1, Math.round(videoSettings.motionBlur.samples)) : 1;
                const blurShutter = Math.min(1, Math.max(0.01, videoSettings.motionBlur?.shutter ?? 0.5));
                const blurAccum = blurSamples > 1 ? new Float32Array(width * height * 4) : null;
                const totalFrames = Math.floor(duration * frameRate) + 1;

                // work objects for 360 capture
                const camPos = new Vec3();
                const qCapture = new Quat();

                // capture a 360 frame (mono: six cube faces, stereo: ods
                // strips) from the animated camera position and encode it
                const capture360 = async (frameTime: number) => {
                    // snapshot the animated camera pose. supersplat cameras
                    // never roll, so with level horizon the capture frame is
                    // the camera yaw, otherwise yaw and pitch
                    camPos.copy(scene.camera.position);
                    if (levelHorizon ?? true) {
                        qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }

                    const frameIndex = Math.round(frameTime * frameRate);
                    const ok = await capturePanorama({
                        position: camPos,
                        rotation: qCapture,
                        equirect,
                        ods,
                        faceSize,
                        data,
                        render: async () => {
                            scene.lockedRender = true;
                            await postRender();
                        },
                        cancelled: () => cancelled,
                        progress: (fraction) => {
                            events.fire('progressUpdate', {
                                text: i18n.t('panel.render.rendering', { ellipsis: true }),
                                progress: 100 * (frameIndex + fraction) / totalFrames
                            });
                        }
                    });
                    if (ok) {
                        await encodeFrame(frameTime);
                    }
                };

                for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                    // check for cancellation
                    if (cancelled) break;

                    if (is360) {
                        // restore animated-pose evaluation before the timeline
                        // advances (fov feeds the tween-to-position mapping);
                        // stereo left the target at strip size
                        if (ods) scene.camera.startOffscreenMode(faceSize, faceSize);
                        scene.camera.setPoseOverride(null);
                        scene.camera.fov = savedFov;

                        // prepare the frame (loads PLY if needed, updates camera)
                        await prepareFrame(startFrame + frameTime * animFrameRate, true);

                        await capture360(frameTime);
                    } else {
                        const animTime = startFrame + frameTime * animFrameRate;
                        const fadeAlpha = await renderFadeFrom(animTime);

                        if (blurSamples > 1) {
                            // motion blur: sub-frames spread over the shutter
                            // around this frame's time, averaged
                            blurAccum.fill(0);
                            for (let s = 0; s < blurSamples; s++) {
                                const offset = ((s + 0.5) / blurSamples - 0.5) * blurShutter;
                                await prepareFrame(animTime + offset * animFrameRate / frameRate);
                                scene.lockedRender = true;
                                await postRender();
                                await readFrame(data);
                                for (let i = 0; i < data.length; i++) blurAccum[i] += data[i];
                            }
                            const inv = 1 / blurSamples;
                            for (let i = 0; i < data.length; i++) data[i] = blurAccum[i] * inv + 0.5;
                            if (fadeAlpha !== null) mixFade(fadeAlpha);
                            overlayTitles(animTime);
                            await encodeFrame(frameTime);
                            events.fire('progressUpdate', {
                                text: i18n.t('panel.render.rendering', { ellipsis: true }),
                                progress: 100 * frameTime / duration
                            });
                            continue;
                        }

                        // prepare the frame (loads PLY if needed, updates camera, sorts)
                        await prepareFrame(animTime);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        // wait for capture
                        await readFrame(data);
                        if (fadeAlpha !== null) mixFade(fadeAlpha);
                        overlayTitles(animTime);
                        await encodeFrame(frameTime);

                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * frameTime / duration
                        });
                    }
                }

                const filename = () => `${baseFilename()}${videoSettings.filenameSuffix ?? (isStereo ? '_TB' : '')}.${fileExtension}`;

                if (rawFormat) {
                    if (movWriter) {
                        const blob = await movWriter.finish();
                        if (fileStream) await fileStream.close();
                        else if (!cancelled) downloadFile(blob, filename());
                    } else {
                        const zip = sequence.finish();
                        if (zip && !cancelled) downloadFile(zip, filename());
                    }
                    return !cancelled;
                }

                // Flush and finalize output
                await encoder.flush();
                if (alphaEncoder) await alphaEncoder.flush();
                await muxerWrites;
                if (muxerError) {
                    throw muxerError;
                }
                await output.finalize();

                if (taggable) {
                    // patch spherical metadata into the finished buffer so
                    // players auto-detect the equirectangular projection
                    if (!cancelled) {
                        let buffer = (target as BufferTarget).buffer;
                        try {
                            buffer = injectSphericalMetadata(buffer, isStereo);
                        } catch (error) {
                            console.warn(`failed to inject spherical metadata: ${error.message ?? error}`);
                        }

                        if (fileStream) {
                            await fileStream.write(buffer);
                        } else {
                            downloadFile(buffer, filename());
                        }
                    }

                    // close the stream even when cancelled so the caller can
                    // remove the empty file
                    if (fileStream) {
                        await fileStream.close();
                    }
                } else if (!cancelled && !fileStream) {
                    // Download (skip if cancelled -- the caller will delete the file)
                    downloadFile((target as BufferTarget).buffer, filename());
                }

                return !cancelled;
            } catch (error) {
                // stop the encoder so no further packets are queued while
                // cleaning up
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }

                // the output's stream target holds a writer lock on the
                // destination file stream. drain in-flight muxer writes and
                // cancel the output to release it, otherwise the caller
                // cannot remove the partial file
                if (output) {
                    try {
                        await muxerWrites;
                        await output.cancel();
                    } catch {
                        // output already finalized or its target already closed
                    }
                }

                // tagged 360 exports write to the file stream directly, so
                // close it here too (mirrors render.image failure handling)
                if (fileStream) {
                    try {
                        await fileStream.close();
                    } catch {
                        // stream already closed or still locked by the output
                    }
                }

                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();
                alphaFramesCleanup();

                // back to the interactive view mode
                events.invoke('camera.setRenderOverride', null);
                events.fire('camera.applyView');

                if (equirect || ods) {
                    scene.camera.setPoseOverride(null);
                    scene.camera.fov = savedFov;
                    scene.camera.ortho = savedOrtho;
                    equirect?.destroy();
                    equirect = null;
                    ods?.destroy();
                    ods = null;
                }

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.centersLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;       // camera likely moved, finish with normal render
                exporting = false;

                events.fire('progressEnd');
            }
        };

        // Acquire a Web Lock during encoding to signal the browser that this tab is
        // actively working, which helps prevent aggressive background throttling and
        // codec reclamation.
        if (navigator.locks) {
            return navigator.locks.request('supersplat-video-render', renderImpl);
        }
        return renderImpl();
    });
};

export { ImageSettings, PanoramaJob, PanoramaSource, StereoSettings, registerRenderEvents };
export type { VideoSettings } from './video-config';
