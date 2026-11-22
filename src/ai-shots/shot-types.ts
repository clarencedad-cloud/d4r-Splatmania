import { Vec3 } from 'playcanvas';

// Shared types of the shot-suggestion module ("KI-Kamerafahrten").
// Y is up, units are scene units, frames are integers.

type ShotTemplate = 'orbit' | 'reveal' | 'crane' | 'slide' | 'pushIn' | 'flyover';

const SHOT_TEMPLATES: ShotTemplate[] = ['orbit', 'reveal', 'crane', 'slide', 'pushIn', 'flyover'];

// camera height the moves keep: like the camera presets of video generators
//   auto   - each move its own height
//   ground - eye level, the camera stays near the ground
//   low    - frog's eye, close to the ground looking up
//   high   - raised, above the object's top
//   aerial - drone shot, well above and further out
type ShotStyle = 'auto' | 'ground' | 'low' | 'high' | 'aerial';

const SHOT_STYLES: ShotStyle[] = ['auto', 'ground', 'low', 'high', 'aerial'];

// the moves that make sense for a height (used when no move is picked)
const STYLE_TEMPLATES: Record<ShotStyle, ShotTemplate[]> = {
    auto: SHOT_TEMPLATES,
    ground: ['orbit', 'reveal', 'slide', 'pushIn'],
    low: ['orbit', 'reveal', 'slide', 'pushIn'],
    high: ['orbit', 'reveal', 'crane', 'slide', 'pushIn', 'flyover'],
    aerial: ['orbit', 'crane', 'slide', 'pushIn', 'flyover']
};

// valid parameter ranges, shared by the generator (clamping) and the Claude prompt/schema
const SHOT_LIMITS = {
    durationSec: [3, 30],
    distanceFactor: [0.6, 3],
    heightFactor: [-0.3, 1.5],
    sweepDeg: [20, 360],
    elevationDeg: [-80, 80]
} as const;

// i18n keys of the generator warnings (ShotProposal.warnings)
const SHOT_WARNINGS = [
    // little splat data on the side the camera looks at
    'sm.aishots.warn.lowCoverage',
    // the path came too close to scene geometry, camera positions were moved
    'sm.aishots.warn.collision',
    // the view of the object is blocked for a part of the move
    'sm.aishots.warn.occluded'
] as const;

type ShotParams = {
    template: ShotTemplate;
    // 3..30 seconds
    durationSec: number;
    // 0.6..3, multiple of the object radius (distance from the object centre);
    // orbit: constant, pushIn / flyover: at the start, reveal / crane: at the end,
    // slide: closest point of the track
    distanceFactor: number;
    // -0.3..1.5, camera height above the object centre in object radii
    heightFactor: number;
    // azimuth of the camera around the object at the start of the move, degrees
    // (0 = +Z side, 90 = +X side, increasing = counter-clockwise seen from above);
    // slide: the side the track runs on. undefined = generator picks (coverage / anchors)
    startAngleDeg?: number;
    // orbit / slide: swept angle 20..360
    sweepDeg?: number;
    direction?: 'cw' | 'ccw';
    // add focus / aperture keys for a focus pull
    focusPull?: boolean;
    easing?: 'linear' | 'smooth';
    // short title (e.g. from Claude); otherwise the generator's title
    label?: string;
    // reasoning (Claude)
    rationale?: string;
};

type ShotObject = {
    // AABB of the object; radius = halfExtents.length()
    center: Vec3;
    halfExtents: Vec3;
    radius: number;
    sceneCenter: Vec3;
    sceneRadius: number;
    source: 'box' | 'sphere' | 'selection' | 'scene';
};

type AnchorPose = {
    position: Vec3;
    target: Vec3;
    fov: number;
};

type GeneratedKey = {
    frame: number;
    position: Vec3;
    target: Vec3;
    fov?: number;
    focus?: number;
    aperture?: number;
};

// the procedural camera modifier a proposal brings along (walks): gait bob
// (scene units) and steps per second, handheld shake (degrees) and its speed
type ShotModifier = {
    bob: number;
    stepRate: number;
    shake: number;
    shakeRate: number;
};

type ShotProposal = {
    // stable, e.g. `${template}-${index}`
    id: string;
    params: ShotParams;
    // i18n key or plain text (Claude label)
    title: string;
    keys: GeneratedKey[];
    // number of frames (timeline length the move needs)
    frames: number;
    // 0..1 heuristic (coverage, collision free)
    score: number;
    // i18n keys, e.g. 'sm.aishots.warn.lowCoverage'
    warnings: string[];
    // 0..10 from Claude
    aiScore?: number;
    aiComment?: string;
    // dataURL for the panel
    thumbnail?: string;
    // walk (src/ai-shots/walk-path.ts): the camera modifier for the new
    // camera, the route on the ground and its length (scene units). A walk
    // is no ShotTemplate (Claude does not plan it); params.template is only
    // a placeholder there
    kind?: 'walk';
    modifier?: ShotModifier;
    route?: Vec3[];
    walkLength?: number;
    // the keys were moved by hand / tidied by the clean-up step
    edited?: boolean;
    cleaned?: boolean;
};

interface CoverageField {
    // density voxel grid built from splat centres (opacity weighted), 0..1
    occupancy(p: Vec3): number;
    // rough distance to the nearest dense voxel (scene units)
    clearance(p: Vec3): number;
    // 0..1: share of free line of sight plus data on the side facing the eye;
    // radius = size of the subject around target (default 35% of the distance)
    visibility(eye: Vec3, target: Vec3, radius?: number): number;
    // edge length of a voxel (scene units)
    readonly cellSize?: number;
}

export {
    SHOT_TEMPLATES,
    SHOT_STYLES,
    STYLE_TEMPLATES,
    type ShotStyle,
    SHOT_LIMITS,
    SHOT_WARNINGS,
    type ShotTemplate,
    type ShotParams,
    type ShotObject,
    type AnchorPose,
    type GeneratedKey,
    type ShotProposal,
    type ShotModifier,
    type CoverageField
};
