import { Container } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import type { ShotCamera } from '../camera-poses';
import { Events } from '../events';
import { i18n } from './localization';

// longest side of the preview panorama in pixels
const MAX_WIDTH = 2048;
const MIN_WIDTH = 512;

/**
 * Live panorama preview: while the viewport looks through a camera whose
 * projection is 360 / 360 VR (src/camera-poses.ts), it shows what the export
 * produces - the equirectangular image - instead of the lens view.
 *
 * The panorama is captured from the viewport's own pose (which is the camera
 * while looking through it), so navigating updates it too. It re-renders when
 * anything that changes the picture happens, and keeps rendering while the
 * view is still moving (damping). Stereo cameras preview one eye (mono).
 */
class PanoramaPreview extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'panorama-preview',
            hidden: true
        };
        super(args);

        const canvas = document.createElement('canvas');
        canvas.classList.add('panorama-preview-canvas');
        const label = document.createElement('div');
        label.classList.add('panorama-preview-label');
        this.dom.append(canvas, label);
        const context = canvas.getContext('2d');

        let running = false;
        let pending = false;
        const lastPose = { position: new Vec3(Infinity, 0, 0), yaw: Infinity };

        // the camera being previewed, or null when the preview is off
        const previewCamera = (): ShotCamera | null => {
            if (events.invoke('camera.viewMode') === 'free') return null;
            const camera = events.invoke('shotCameras.followed') as ShotCamera | null;
            if (!camera || camera.projection === 'standard' || !camera.track.placed) return null;
            return camera;
        };

        const viewPose = () => {
            const pose = events.invoke('camera.getPose');
            const position = new Vec3(pose.position.x, pose.position.y, pose.position.z);
            const dx = pose.target.x - pose.position.x;
            const dz = pose.target.z - pose.position.z;
            // camera azim convention: yaw 0 looks down -z, positive turns left
            const yaw = dx === 0 && dz === 0 ? 0 : Math.atan2(-dx, -dz) * 180 / Math.PI;
            return { position, yaw };
        };

        const updateLabel = (camera: ShotCamera) => {
            label.textContent = i18n.t(camera.projection === 'stereo' ? 'sm.pano-preview.label-stereo' : 'sm.pano-preview.label', { camera: camera.name });
        };

        const render = async () => {
            const camera = previewCamera();
            this.hidden = !camera;
            if (!camera) return;
            if (running) {
                pending = true;
                return;
            }
            running = true;
            try {
                updateLabel(camera);
                const { position, yaw } = viewPose();
                const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(this.dom.clientWidth * window.devicePixelRatio / 2) * 2 || 1024));
                const data = await events.invoke('render.panoramaPreview', position, yaw, width) as Uint8Array | null;
                if (data) {
                    const height = width / 2;
                    for (let i = 3; i < data.length; i += 4) data[i] = 255;
                    if (canvas.width !== width || canvas.height !== height) {
                        canvas.width = width;
                        canvas.height = height;
                    }
                    context.putImageData(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length), width, height), 0, 0);
                    lastPose.position.copy(position);
                    lastPose.yaw = yaw;
                } else {
                    // busy (export running): try again shortly
                    pending = true;
                }
            } finally {
                running = false;
            }
            // the view still moving (damping after a drag) or a change while
            // rendering: render again
            const now = viewPose();
            if (pending || !now.position.equals(lastPose.position) || Math.abs(now.yaw - lastPose.yaw) > 1e-3) {
                pending = false;
                setTimeout(() => render(), 16);
            }
        };

        // batch bursts of events into one render
        let queued = false;
        const schedule = () => {
            if (queued) return;
            queued = true;
            setTimeout(() => {
                queued = false;
                render();
            }, 30);
        };

        [
            'camera.viewMode', 'shotCameras.changed', 'camera.valuesChanged', 'track.changed', 'cut.changed',
            'timeline.frame', 'timeline.time', 'camera.controller', 'edit.apply', 'scene.elementAdded',
            'scene.elementRemoved', 'layerAnim.changed', 'dof.changed', 'section.changed', 'selection.changed',
            'splat.moved', 'pivot.ended'
        ].forEach(name => events.on(name, schedule));
        i18n.onChange(schedule);
        new ResizeObserver(schedule).observe(this.dom);
    }
}

export { PanoramaPreview };
