import { Vec3 } from 'playcanvas';

import { reviewFloaters } from '../ai-shots/claude-client';
import type { FloaterGroup, FloaterStats } from '../analysis/floaters';
import { Events } from '../events';

// Views for the optional Claude check of the floater groups: two small
// renders per group (close and with context), the group always in the centre
// and circled in red. Only these JPEGs go to Claude, never splat data.

const WIDTH = 320;
const HEIGHT = 240;
const JPEG_QUALITY = 0.8;

type GroupViews = { id: number, jpegs: string[] };

const render = async (events: Events, position: Vec3, target: Vec3, fov: number, signal: AbortSignal) => {
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const canvas = await events.invoke('render.posePreview', { position, target, fov }, WIDTH, HEIGHT, signal) as HTMLCanvasElement | null;
        if (canvas) return canvas;
    }
    return null;
};

// red ring around the image centre, sized to the group's projected radius
// (landscape renders use a horizontal field of view)
const circle = (canvas: HTMLCanvasElement, radius: number, distance: number, fov: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const focal = (canvas.width / 2) / Math.tan(fov * Math.PI / 360);
    const r = Math.max(12, Math.min(canvas.height * 0.45, 1.3 * focal * radius / Math.max(distance, 1e-6) + 6));
    ctx.strokeStyle = '#ff2020';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, r, 0, 2 * Math.PI);
    ctx.stroke();
};

const renderGroupViews = async (events: Events, groups: FloaterGroup[], stats: FloaterStats, signal: AbortSignal): Promise<GroupViews[]> => {
    const fov = events.invoke('camera.fov') ?? 60;
    const size = stats.sceneSize || 1;
    const sceneCenter = new Vec3(stats.sceneCenter[0], stats.sceneCenter[1], stats.sceneCenter[2]);
    const out: GroupViews[] = [];
    for (const g of groups) {
        if (signal.aborted) break;
        const center = new Vec3(g.center[0], g.center[1], g.center[2]);
        const radius = Math.max(0.5 * Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]), 0.005 * size);
        // look from the free side (away from the structure next to it), else
        // from outside towards the scene centre
        const dir = new Vec3(g.away[0], g.away[1], g.away[2]);
        if (dir.lengthSq() < 0.5) dir.sub2(center, sceneCenter);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0.3, 1);
        dir.normalize();
        dir.y = Math.max(dir.y, 0.2);
        dir.normalize();
        // the second view turned by 60 degrees about the vertical
        const cos = Math.cos(Math.PI / 3), sin = Math.sin(Math.PI / 3);
        const side = new Vec3(dir.x * cos - dir.z * sin, dir.y, dir.x * sin + dir.z * cos).normalize();
        // views with a free line of sight from the floater core, else from
        // the free side and turned by 60 degrees
        const shots = g.views?.length ? g.views.map(v => ({ dir: new Vec3(v.dir[0], v.dir[1], v.dir[2]), distance: v.distance })) : [
            { dir, distance: Math.max(2.5 * radius, 0.03 * size) },
            { dir: side, distance: Math.max(6 * radius, 0.12 * size) }
        ];
        const jpegs: string[] = [];
        for (const shot of shots) {
            const position = new Vec3().copy(shot.dir).mulScalar(shot.distance).add(center);
            const canvas = await render(events, position, center, fov, signal);
            if (!canvas) continue;
            circle(canvas, radius, shot.distance, fov);
            jpegs.push(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
        }
        if (jpegs.length) out.push({ id: g.id, jpegs });
    }
    return out;
};

const reviewGroupViews = async (views: GroupViews[], language: string, signal: AbortSignal) => {
    const verdicts = await reviewFloaters({
        language,
        candidates: views.map(v => ({ id: `g${v.id}`, jpegBase64: v.jpegs }))
    }, signal);
    return verdicts.map(v => ({ ...v, id: parseInt(v.id.slice(1), 10) }));
};

export { renderGroupViews, reviewGroupViews, GroupViews };
