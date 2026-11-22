import { ElementType } from './element';
import { Events } from './events';
import type { Scene } from './scene';
import type { Splat } from './splat';
import { i18n } from './ui/localization';

// How long one scene unit is in the real world. Scans from XGRIDS / PortalCam
// (LCC containers) are metric; Postshot and most other PLY exports come in an
// arbitrary size. Lengths in the ui (camera distance, eye height, walking
// speed, bob height) are shown in metres when the scale is known and in scene
// units otherwise - never as metres that only look like metres.
//
// mode
//   auto   - metric when a visible layer was loaded from an LCC container,
//            otherwise unknown
//   metric - the user says: one unit is one metre
//   custom - the user set the length of a unit (e.g. from the real height
//            of the object)

type SceneScaleMode = 'auto' | 'metric' | 'custom';

type SceneScale = {
    mode: SceneScaleMode;
    // metres per scene unit; 1 when the scale is unknown
    metersPerUnit: number;
    // false: unknown, lengths are scene units
    known: boolean;
    // where the scale comes from
    source: 'lcc' | 'metric' | 'custom' | 'unknown';
};

const isLccName = (name: string) => /\.lcc2?$/i.test(name ?? '');

// number with the locale's decimal separator
const formatNumber = (value: number, digits: number) => {
    const locale = i18n.locale || 'en';
    try {
        return value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch {
        return value.toFixed(digits);
    }
};

// a length in scene units for display: "4,2 m", "35 cm" or "4,2 units"
const formatLength = (units: number, scale: SceneScale, digits?: number) => {
    if (!Number.isFinite(units)) return '–';
    if (!scale.known) {
        const a = Math.abs(units);
        const d = digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
        return `${formatNumber(units, d)} ${i18n.t('sm.scale.unit-short')}`;
    }
    const meters = units * scale.metersPerUnit;
    const a = Math.abs(meters);
    if (digits === undefined && a < 1) {
        return `${formatNumber(meters * 100, a < 0.1 ? 1 : 0)} cm`;
    }
    const d = digits ?? (a >= 100 ? 0 : 1);
    return `${formatNumber(meters, d)} m`;
};

// a speed in scene units per second: "1,3 m/s" or "1,3 units/s"
const formatSpeed = (unitsPerSecond: number, scale: SceneScale) => {
    const value = scale.known ? unitsPerSecond * scale.metersPerUnit : unitsPerSecond;
    const unit = scale.known ? 'm/s' : `${i18n.t('sm.scale.unit-short')}/s`;
    return `${formatNumber(value, 1)} ${unit}`;
};

const registerSceneScaleEvents = (events: Events, scene: Scene) => {
    let mode: SceneScaleMode = 'auto';
    let custom = 1;

    const lccLoaded = () => (scene.getElementsByType(ElementType.splat) as Splat[])
    .some(s => s.visible && (isLccName(s.filename) || isLccName(s.name)));

    const current = (): SceneScale => {
        if (mode === 'metric') return { mode, metersPerUnit: 1, known: true, source: 'metric' };
        if (mode === 'custom') return { mode, metersPerUnit: custom, known: true, source: 'custom' };
        return lccLoaded() ?
            { mode, metersPerUnit: 1, known: true, source: 'lcc' } :
            { mode, metersPerUnit: 1, known: false, source: 'unknown' };
    };

    let last = JSON.stringify(current());
    const changed = () => {
        const now = current();
        const key = JSON.stringify(now);
        if (key === last) return;
        last = key;
        events.fire('sceneScale.changed', now);
    };

    events.function('sceneScale.get', current);
    events.function('sceneScale.metersPerUnit', () => current().metersPerUnit);

    // ('auto' | 'metric') or ('custom', metres per unit)
    events.on('sceneScale.set', (value: SceneScaleMode, metersPerUnit?: number) => {
        if (value === 'custom') {
            if (!(typeof metersPerUnit === 'number' && metersPerUnit > 0 && Number.isFinite(metersPerUnit))) return;
            custom = metersPerUnit;
        }
        mode = value === 'metric' || value === 'custom' ? value : 'auto';
        changed();
    });

    ['scene.elementAdded', 'scene.elementRemoved'].forEach((name) => {
        events.on(name, (element: { type?: ElementType }) => {
            if (element?.type === ElementType.splat) changed();
        });
    });
    events.on('splat.visibility', changed);
    events.on('scene.clear', () => {
        mode = 'auto';
        custom = 1;
        changed();
    });

    events.function('docSerialize.sceneScale', () => (mode === 'auto' ? undefined : { mode, metersPerUnit: custom }));
    events.function('docDeserialize.sceneScale', (doc: { mode?: SceneScaleMode, metersPerUnit?: number } | null | undefined) => {
        mode = doc?.mode === 'metric' || doc?.mode === 'custom' ? doc.mode : 'auto';
        custom = typeof doc?.metersPerUnit === 'number' && doc.metersPerUnit > 0 ? doc.metersPerUnit : 1;
        changed();
    });
};

export { registerSceneScaleEvents, formatLength, formatSpeed, formatNumber, type SceneScale, type SceneScaleMode };
