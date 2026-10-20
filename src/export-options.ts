import type { Pose, ShotCamera } from './camera-poses';
import { Events } from './events';
import type { WriteTarget } from './io';
import { AnimTrack, defaultPostEffectSettings, ExperienceSettings, SerializeSettings, ViewerExportSettings } from './splat-serialize';

type ExportType = 'ply' | 'splat' | 'sog' | 'spz' | 'viewer';

// The export dialog's choices. Everything else in SceneExportOptions is read
// from the scene when the export runs, so repeating an export with the same
// choices picks up the current camera pose and animation.
interface ExportChoices {
    filename: string;
    maxSHBands?: number;

    // export only the active layer instead of every visible one
    activeLayerOnly?: boolean;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // spz
    spzVersion?: 3 | 4;

    // viewer
    viewerType?: 'html' | 'zip';
    includeAnimation?: boolean;
    loopMode?: 'none' | 'repeat' | 'pingpong';
    backgroundColor?: [number, number, number];
    fov?: number;
}

// what the export dialog resolves: its choices plus, when a folder was chosen,
// the folder and the file to write
type ExportDialogResult = ExportChoices & {
    directory?: FileSystemDirectoryHandle;
    fileTarget?: WriteTarget;
};

interface SceneExportOptions {
    filename: string;
    splatIdx: 'all' | number;
    serializeSettings: SerializeSettings;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // spz
    spzVersion?: 3 | 4;

    // viewer
    viewerExportSettings?: ViewerExportSettings;
}

const buildViewerSettings = (events: Events, choices: ExportChoices): ViewerExportSettings => {
    const fov = choices.fov;

    // use current viewport as start pose
    const pose = events.invoke('camera.getPose');
    const p = pose?.position;
    const t = pose?.target;
    const cameras = (p && t) ? [{
        initial: {
            position: [p.x, p.y, p.z] as [number, number, number],
            target: [t.x, t.y, t.z] as [number, number, number],
            fov
        }
    }] : [];

    const animTracks: AnimTrack[] = [];

    if (choices.includeAnimation) {
        const frames = events.invoke('timeline.frames');
        const frameRate = events.invoke('timeline.frameRate');
        const smoothness = events.invoke('timeline.smoothness');

        // one track per shot camera (src/camera-poses.ts), the selected camera
        // first: the viewer starts with the first track
        const shotCameras = (events.invoke('shotCameras.list') as ShotCamera[] ?? []).slice();
        const selected = events.invoke('shotCameras.selected') as ShotCamera;
        shotCameras.sort((a, b) => (a === selected ? -1 : b === selected ? 1 : 0));
        const sources = shotCameras.length > 0 ?
            shotCameras.map(c => ({ name: c.name, poses: c.track.getPoses() as Pose[] })) :
            [{ name: 'cameraAnim', poses: events.invoke('camera.poses') as Pose[] }];

        for (const source of sources) {
            const orderedPoses = source.poses
            .filter(entry => entry.frame >= 0 && entry.frame < frames)
            .sort((a, b) => a.frame - b.frame);

            if (orderedPoses.length === 0) continue;

            const times: number[] = [];
            const position: number[] = [];
            const target: number[] = [];
            const fovKeys: number[] = [];
            for (let i = 0; i < orderedPoses.length; ++i) {
                const op = orderedPoses[i];
                times.push(op.frame);
                position.push(op.position.x, op.position.y, op.position.z);
                target.push(op.target.x, op.target.y, op.target.z);
                fovKeys.push(op.fov ?? fov);
            }

            animTracks.push({
                name: source.name,
                duration: frames / frameRate,
                frameRate,
                loopMode: choices.loopMode,
                interpolation: 'spline',
                smoothness,
                keyframes: {
                    times,
                    values: { position, target, fov: fovKeys }
                }
            });

            // each shot camera also becomes a viewer camera at its first key
            const first = orderedPoses[0];
            cameras.push({
                initial: {
                    position: [first.position.x, first.position.y, first.position.z],
                    target: [first.target.x, first.target.y, first.target.z],
                    fov: first.fov ?? fov
                }
            });
        }
    }

    const experienceSettings: ExperienceSettings = {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: { color: choices.backgroundColor },
        postEffectSettings: defaultPostEffectSettings(),
        animTracks,
        cameras,
        annotations: [],
        startMode: animTracks.length > 0 ? 'animTrack' : 'default'
    };

    return { type: choices.viewerType, experienceSettings };
};

// index of the active layer among the exported (visible, non-empty) splats,
// or 'all' when exporting every visible layer
const activeLayerIndex = (events: Events, choices: ExportChoices): 'all' | number => {
    if (!choices.activeLayerOnly) return 'all';
    const index = (events.invoke('scene.splats') as unknown[]).indexOf(events.invoke('selection'));
    return index === -1 ? 'all' : index;
};

// turn the dialog's choices into export options against the current scene
const buildExportOptions = (events: Events, exportType: ExportType, choices: ExportChoices): SceneExportOptions => {
    const options: SceneExportOptions = {
        filename: choices.filename,
        splatIdx: activeLayerIndex(events, choices),
        serializeSettings: { maxSHBands: choices.maxSHBands }
    };

    switch (exportType) {
        case 'ply':
            options.compressedPly = choices.compressedPly;
            break;
        case 'sog':
            options.sogIterations = choices.sogIterations;
            break;
        case 'spz':
            options.spzVersion = choices.spzVersion;
            break;
        case 'viewer':
            options.viewerExportSettings = buildViewerSettings(events, choices);
            break;
    }

    return options;
};

export { buildExportOptions, ExportChoices, ExportDialogResult, ExportType, SceneExportOptions };
