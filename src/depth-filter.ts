import { Events } from './events';

// depth-limited selection: screen-space selection gestures (rect, lasso,
// polygon, brush, click) only take splats whose view-space depth - the
// distance of the splat center along the camera's view axis, in scene units -
// lies within [near, far]. display controls how out-of-range splats render
// while the filter is on: 'off' renders them normally, 'dim' darkens them and
// 'hide' culls them. Selection passes always cull them, so an out-of-range
// splat can neither be selected nor occlude an in-range one in a depth pick.
//
// minAlpha (0..1) drives the "visible splats only" mode of the id pick: a
// splat only claims a pixel where its gaussian contributes at least this much
// opacity, so faint splats no longer win the frontmost pick. 0 = off.
type DepthFilterDisplay = 'off' | 'dim' | 'hide';

type DepthFilterState = {
    enabled: boolean;
    near: number;
    far: number;
    display: DepthFilterDisplay;
    minAlpha: number;
};

const registerDepthFilterEvents = (events: Events) => {
    const state: DepthFilterState = {
        enabled: false,
        near: 0,
        far: 3,
        display: 'dim',
        minAlpha: 0
    };

    events.function('depthFilter', () => state);

    // the active [near, far] range, or null when the filter is off
    events.function('depthFilter.range', () => {
        return state.enabled ? { near: state.near, far: state.far } : null;
    });

    events.function('depthFilter.set', (value: Partial<DepthFilterState>) => {
        Object.assign(state, value);
        state.near = Math.max(0, state.near);
        state.far = Math.max(state.near, state.far);
        state.minAlpha = Math.min(1, Math.max(0, state.minAlpha));
        events.fire('depthFilter.changed', state);
    });
};

export { registerDepthFilterEvents, DepthFilterState, DepthFilterDisplay };
