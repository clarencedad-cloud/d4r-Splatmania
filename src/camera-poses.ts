import { Vec3 } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { AnimTrack } from './anim-track';
import { Events } from './events';

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number
};

// an evaluated camera pose
type PoseValue = {
    position: Vec3,
    target: Vec3,
    fov: number
};

/**
 * Keyframe track of one shot camera: position, target and fov keys,
 * interpolated with a cubic spline over the timeline.
 *
 * The track no longer drives the editor camera itself - it only answers
 * getPoseAt(frame). Which camera the viewport follows is decided by the
 * camera rig below (free / look through / cut).
 */
class CameraAnimTrack implements AnimTrack {
    private poses: Pose[] = [];
    private events: Events;
    private evaluator: ((frame: number, out: PoseValue) => void) | null = null;
    private handles: { off: () => void }[] = [];

    constructor(events: Events) {
        this.events = events;

        // rebuild the spline when timeline parameters change
        const rebuild = () => this.rebuildSpline();
        this.handles.push(events.on('timeline.frames', rebuild));
        this.handles.push(events.on('timeline.smoothness', rebuild));
        this.handles.push(events.on('timeline.loop', rebuild));
    }

    destroy() {
        this.handles.forEach(h => h.off());
        this.handles = [];
    }

    get keys(): readonly number[] {
        return this.poses.map(p => p.frame);
    }

    addKey(frame: number): boolean {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return false;

        const existingIndex = this.poses.findIndex(p => p.frame === frame);

        const newPose: Pose = {
            name: `camera_${this.poses.length}`,
            frame,
            position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
            target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
            fov: pose.fov
        };

        if (existingIndex === -1) {
            this.poses.push(newPose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', frame);
        } else {
            this.poses[existingIndex] = newPose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', frame);
        }
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.poses.findIndex(p => p.frame === frame);
        if (index === -1) return false;
        this.poses.splice(index, 1);
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const index = this.poses.findIndex(p => p.frame === fromFrame);
        if (index === -1) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        // Update the frame (re-find index since splice may have shifted it)
        const movedIndex = this.poses.findIndex(p => p.frame === fromFrame);
        this.poses[movedIndex].frame = toFrame;
        this.rebuildSpline();
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const source = this.poses.find(p => p.frame === fromFrame);
        if (!source) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        this.poses.push({
            name: `camera_${this.poses.length}`,
            frame: toFrame,
            position: source.position.clone(),
            target: source.target.clone(),
            fov: source.fov
        });

        this.rebuildSpline();
        this.events.fire('track.keyAdded', toFrame);
        return true;
    }

    // the interpolated pose at frame (fractional frames allowed), or null when
    // the track has no keys
    getPoseAt(frame: number, out?: PoseValue): PoseValue | null {
        if (!this.evaluator) {
            return null;
        }
        const result = out ?? { position: new Vec3(), target: new Vec3(), fov: 0 };
        this.evaluator(frame, result);
        return result;
    }

    clear(): void {
        this.poses.length = 0;
        this.rebuildSpline();
        this.events.fire('track.keysCleared');
    }

    snapshot(): Pose[] {
        return this.poses.map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
        }));
    }

    restore(snapshot: unknown): void {
        this.poses = (snapshot as Pose[]).map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
        }));
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    /**
     * Get all poses (used for serialization).
     */
    getPoses(): readonly Pose[] {
        return this.poses;
    }

    /**
     * Load poses from serialized data.
     */
    loadPoses(posesData: Pose[]): void {
        const defaultFov = this.events.invoke('camera.fov');
        this.poses.length = 0;
        posesData.forEach((pose) => {
            this.poses.push({
                ...pose,
                fov: pose.fov ?? defaultFov
            });
        });
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    private rebuildSpline(): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        const orderedPoses = this.poses.slice()
        .filter(a => a.frame < duration)
        .sort((a, b) => a.frame - b.frame);

        const times = orderedPoses.map(p => p.frame);
        const points: number[] = [];
        for (let i = 0; i < orderedPoses.length; ++i) {
            const p = orderedPoses[i];
            points.push(p.position.x, p.position.y, p.position.z);
            points.push(p.target.x, p.target.y, p.target.z);
            points.push(p.fov);
        }

        if (orderedPoses.length > 1) {
            // when not looping the spline clamps, holding the first/last pose
            // beyond the outer keys instead of wrapping the end into the start
            const spline = loop ?
                CubicSpline.fromPointsLooping(duration, times, points, smoothness) :
                CubicSpline.fromPoints(times, points, smoothness);
            const result: number[] = [];

            this.evaluator = (frame: number, out: PoseValue) => {
                spline.evaluate(frame, result);
                out.position.set(result[0], result[1], result[2]);
                out.target.set(result[3], result[4], result[5]);
                out.fov = result[6];
            };
        } else if (orderedPoses.length === 1) {
            // a single key can't form a spline; hold its pose at every frame
            const p = orderedPoses[0];
            this.evaluator = (frame: number, out: PoseValue) => {
                out.position.copy(p.position);
                out.target.copy(p.target);
                out.fov = p.fov;
            };
        } else {
            this.evaluator = null;
        }

        this.events.fire('track.changed', this);
    }
}

// a hard-cut segment: frames [start, end) are shown through camera cameraId
type CutSegment = {
    start: number,
    end: number,
    cameraId: number
};

/**
 * The cut track: a list of non-overlapping segments mapping frame ranges to
 * shot cameras. Undo goes through AnimTrackEditOp (snapshot / restore).
 */
class CutTrack {
    private events: Events;
    segments: CutSegment[] = [];

    constructor(events: Events) {
        this.events = events;
    }

    // place a segment, trimming or splitting whatever it overlaps
    set(start: number, end: number, cameraId: number): boolean {
        if (end <= start) return false;
        const result: CutSegment[] = [];
        for (const s of this.segments) {
            if (s.end <= start || s.start >= end) {
                result.push(s);
                continue;
            }
            if (s.start < start) result.push({ start: s.start, end: start, cameraId: s.cameraId });
            if (s.end > end) result.push({ start: end, end: s.end, cameraId: s.cameraId });
        }
        result.push({ start, end, cameraId });
        this.segments = this.normalize(result);
        this.changed();
        return true;
    }

    removeAt(frame: number): boolean {
        const index = this.segments.findIndex(s => frame >= s.start && frame < s.end);
        if (index === -1) return false;
        this.segments.splice(index, 1);
        this.changed();
        return true;
    }

    removeCamera(cameraId: number) {
        const before = this.segments.length;
        this.segments = this.segments.filter(s => s.cameraId !== cameraId);
        if (this.segments.length !== before) this.changed();
    }

    segmentAt(frame: number): CutSegment | null {
        return this.segments.find(s => frame >= s.start && frame < s.end) ?? null;
    }

    // the camera shown at frame: the containing segment, else the last
    // segment before it (holds through gaps), else the first segment
    cameraAt(time: number): number | null {
        if (this.segments.length === 0) return null;
        // render export accumulates 1/fps steps, so frame 90 can arrive as
        // 89.99999 - snap to the frame a hard cut is defined on
        const frame = Math.floor(time + 1e-4);
        let result = this.segments[0].cameraId;
        for (const s of this.segments) {
            if (s.start <= frame) result = s.cameraId;
            if (frame >= s.start && frame < s.end) return s.cameraId;
        }
        return result;
    }

    clear() {
        this.segments = [];
        this.changed();
    }

    snapshot(): CutSegment[] {
        return this.segments.map(s => ({ ...s }));
    }

    restore(snapshot: unknown) {
        this.segments = (snapshot as CutSegment[]).map(s => ({ ...s }));
        this.changed();
    }

    private normalize(segments: CutSegment[]) {
        // sort and merge touching segments of the same camera
        const sorted = segments.filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
        const merged: CutSegment[] = [];
        for (const s of sorted) {
            const last = merged[merged.length - 1];
            if (last && last.cameraId === s.cameraId && last.end === s.start) {
                last.end = s.end;
            } else {
                merged.push({ ...s });
            }
        }
        return merged;
    }

    private changed() {
        this.events.fire('cut.changed', this.segments);
    }
}

type ShotCamera = {
    id: number,
    name: string,
    color: [number, number, number],
    track: CameraAnimTrack
};

// what the viewport follows while the timeline moves: nothing (free editor
// camera), the selected shot camera, or the cut track
type CameraViewMode = 'free' | 'camera' | 'cut';

const PALETTE: [number, number, number][] = [
    [0, 220, 255],
    [255, 170, 0],
    [120, 255, 90],
    [255, 80, 200],
    [255, 240, 80],
    [150, 120, 255],
    [255, 90, 90],
    [80, 255, 210]
];

/**
 * Register the shot cameras, the cut track and the camera rig.
 */
const registerCameraPosesEvents = (events: Events) => {
    const cameras: ShotCamera[] = [];
    let nextId = 1;
    let selectedId = 0;
    // free by default: looking through a camera without keys would jump the
    // view somewhere arbitrary
    let viewMode: CameraViewMode = 'free';
    // export override: forces the rig onto one camera or the cut while
    // rendering, independent of the interactive view mode
    let override: { mode: 'camera' | 'cut', cameraId?: number } | null = null;
    let currentFrame = 0;

    const cut = new CutTrack(events);

    const byId = (id: number) => cameras.find(c => c.id === id) ?? null;
    const selected = () => byId(selectedId) ?? cameras[0] ?? null;

    const nextName = () => {
        const taken = new Set(cameras.map(c => c.name));
        let n = cameras.length + 1;
        while (taken.has(`Kamera ${n}`)) n++;
        return `Kamera ${n}`;
    };

    const nextColor = (): [number, number, number] => {
        const used = new Set(cameras.map(c => c.color.join(',')));
        return PALETTE.find(c => !used.has(c.join(','))) ?? PALETTE[cameras.length % PALETTE.length];
    };

    // which camera the viewport follows right now, or null for none
    const followedCamera = (frame: number): ShotCamera | null => {
        const mode = override?.mode ?? viewMode;
        if (mode === 'camera') {
            return override?.cameraId !== undefined ? byId(override.cameraId) : selected();
        }
        if (mode === 'cut') {
            const id = cut.cameraAt(frame);
            return id !== null ? byId(id) : selected();
        }
        return null;
    };

    const tmpPose: PoseValue = { position: new Vec3(), target: new Vec3(), fov: 0 };

    // move the viewport to the followed camera's pose at the current frame
    const apply = () => {
        const camera = followedCamera(currentFrame);
        if (camera && camera.track.getPoseAt(currentFrame, tmpPose)) {
            events.fire('camera.setPose', tmpPose, 0);
        }
    };

    const changed = () => {
        events.fire('shotCameras.changed', cameras);
        // the active track (and so the timeline's keys) may have switched
        events.fire('track.keysLoaded');
        apply();
    };

    const create = (name?: string, color?: [number, number, number], id?: number) => {
        const camera: ShotCamera = {
            id: id ?? nextId,
            name: name ?? nextName(),
            color: color ?? nextColor(),
            track: new CameraAnimTrack(events)
        };
        nextId = Math.max(nextId, camera.id + 1);
        cameras.push(camera);
        return camera;
    };

    const removeAll = () => {
        cameras.forEach(c => c.track.destroy());
        cameras.length = 0;
    };

    events.on('timeline.time', (time: number) => {
        currentFrame = time;
        apply();
    });

    events.on('timeline.frame', (frame: number) => {
        currentFrame = frame;
        apply();
    });

    // a key edit re-evaluates the followed camera so the view updates at once
    events.on('track.changed', (track: CameraAnimTrack) => {
        if (followedCamera(currentFrame)?.track === track) {
            apply();
        }
    });

    events.on('camera.applyView', () => apply());

    events.on('cut.changed', () => {
        if ((override?.mode ?? viewMode) === 'cut') apply();
    });

    // start with one camera; a cleared scene resets to that
    create();
    selectedId = cameras[0].id;

    events.on('scene.clear', () => {
        removeAll();
        nextId = 1;
        selectedId = create().id;
        cut.clear();
        changed();
    });

    // shot camera api

    events.function('shotCameras.list', () => cameras);
    events.function('shotCameras.selected', () => selected());
    events.function('shotCameras.byId', (id: number) => byId(id));
    events.function('shotCameras.poseAt', (id: number, frame: number) => byId(id)?.track.getPoseAt(frame) ?? null);
    events.function('shotCameras.followed', (frame?: number) => followedCamera(frame ?? currentFrame));

    events.on('shotCameras.add', () => {
        selectedId = create().id;
        changed();
    });

    events.on('shotCameras.duplicate', (id?: number) => {
        const source = byId(id ?? selectedId);
        if (!source) return;
        const copy = create(`${source.name} Kopie`);
        copy.track.restore(source.track.snapshot());
        selectedId = copy.id;
        changed();
    });

    events.on('shotCameras.remove', (id?: number) => {
        const camera = byId(id ?? selectedId);
        // always keep one camera
        if (!camera || cameras.length <= 1) return;
        camera.track.destroy();
        cameras.splice(cameras.indexOf(camera), 1);
        cut.removeCamera(camera.id);
        if (selectedId === camera.id) selectedId = cameras[0].id;
        changed();
    });

    events.on('shotCameras.rename', (id: number, name: string) => {
        const camera = byId(id);
        if (!camera || !name) return;
        camera.name = name;
        events.fire('shotCameras.changed', cameras);
    });

    events.on('shotCameras.select', (id: number) => {
        if (!byId(id) || id === selectedId) return;
        selectedId = id;
        changed();
    });

    // path lines of the camera gizmos

    let showPaths = true;
    events.function('camera.showPaths', () => showPaths);
    events.on('camera.setShowPaths', (value: boolean) => {
        if (value === showPaths) return;
        showPaths = value;
        events.fire('camera.showPaths', showPaths);
    });

    // view mode

    events.function('camera.viewMode', () => viewMode);

    events.on('camera.setViewMode', (mode: CameraViewMode) => {
        if (mode === viewMode) return;
        viewMode = mode;
        events.fire('camera.viewMode', viewMode);
        apply();
    });

    events.on('camera.toggleLookThrough', () => {
        events.fire('camera.setViewMode', viewMode === 'free' ? 'camera' : 'free');
    });

    // render export: follow one camera or the cut regardless of the view mode
    events.function('camera.setRenderOverride', (value: { mode: 'camera' | 'cut', cameraId?: number } | null) => {
        override = value;
    });

    // the selected camera's track is the active track (track-manager)
    events.function('camera.animTrack', () => selected()?.track ?? null);

    // poses of the selected camera (viewer export, publish settings)
    events.function('camera.poses', () => selected()?.track.getPoses() ?? []);

    events.on('camera.loadPoses', (poses: Pose[]) => {
        selected()?.track.loadPoses(poses);
    });

    // cut track api (undo via AnimTrackEditOp)

    events.function('cut.track', () => cut);
    events.function('cut.segments', () => cut.segments);
    events.function('cut.cameraAt', (frame: number) => cut.cameraAt(frame));

    // Serialization: one pose set per camera, plus the cut track. Cut
    // segments reference cameras by pose set index so ids need not persist

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        // an untouched single camera saves nothing, as before
        if (cameras.length === 1 && cameras[0].track.getPoses().length === 0) {
            return [];
        }

        return cameras.map(camera => ({
            name: camera.name,
            color: camera.color,
            poses: camera.track.getPoses().map(pose => ({
                name: pose.name,
                frame: pose.frame,
                position: pack3(pose.position),
                target: pack3(pose.target),
                fov: pose.fov
            }))
        }));
    });

    events.function('docDeserialize.poseSets', (poseSets: any[], documentCameraFov?: number) => {
        if (!poseSets || poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');
        const defaultFov = documentCameraFov ?? events.invoke('camera.fov') ?? 60;

        removeAll();
        nextId = 1;

        poseSets.forEach((poseSet: any, setIndex: number) => {
            // old projects stored a single set named 'set0': migrate it to
            // "Kamera 1"
            const name = (!poseSet.name || /^set\d+$/.test(poseSet.name)) ? `Kamera ${setIndex + 1}` : poseSet.name;
            const camera = create(name, poseSet.color);
            camera.track.loadPoses((poseSet.poses ?? []).map((docPose: any, index: number) => ({
                name: docPose.name,
                frame: docPose.frame ?? (index * fps),
                position: new Vec3(docPose.position),
                target: new Vec3(docPose.target),
                fov: docPose.fov ?? defaultFov
            })));
        });

        selectedId = cameras[0].id;
        changed();
    });

    events.function('docSerialize.cuts', () => {
        return {
            viewMode,
            segments: cut.segments.map(s => ({
                start: s.start,
                end: s.end,
                camera: cameras.findIndex(c => c.id === s.cameraId)
            })).filter(s => s.camera >= 0)
        };
    });

    events.function('docDeserialize.cuts', (doc: any) => {
        cut.restore((doc?.segments ?? [])
        .filter((s: any) => cameras[s.camera])
        .map((s: any) => ({ start: s.start, end: s.end, cameraId: cameras[s.camera].id })));
        if (doc?.viewMode) {
            events.fire('camera.setViewMode', doc.viewMode);
        }
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, CutTrack, Pose, PoseValue, ShotCamera, CutSegment, CameraViewMode };
