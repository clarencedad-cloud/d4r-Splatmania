import { BooleanInput, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import type { DepthFilterState } from '../depth-filter';
import { Events } from '../events';
import { makeFloating } from './floating-panel';
import { helpButton } from './help';
import { i18n } from './localization';

// floating panel for the depth-limited selection (src/depth-filter.ts):
// draggable and minimizable, the on/off switch stays in the title bar
class DepthFilterPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'depth-filter-panel'
        };

        super(args);

        // keep pointer and key input away from the camera and the shortcuts
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const state = events.invoke('depthFilter') as DepthFilterState;
        const set = (value: Partial<DepthFilterState>) => events.invoke('depthFilter.set', value);

        const row = (labelText: string, input: Container | BooleanInput | SliderInput | SelectInput, title?: string) => {
            const container = new Container({ class: 'depth-filter-row' });
            const label = new Label({ class: 'depth-filter-label' });
            i18n.bindText(label, labelText);
            if (title) {
                i18n.bindDom(container.dom, title, 'title');
            }
            container.append(label);
            container.append(input);
            this.append(container);
            return container;
        };

        const enabled = new BooleanInput({ type: 'toggle', value: state.enabled });
        const near = new SliderInput({ min: 0, max: 100000, sliderMin: 0, sliderMax: 20, precision: 2, step: 0.1, value: state.near });
        const far = new SliderInput({ min: 0, max: 100000, sliderMin: 0, sliderMax: 20, precision: 2, step: 0.1, value: state.far });
        const display = new SelectInput({ value: state.display });
        i18n.bindOptions(display, () => [
            { v: 'off', t: i18n.t('sm.depth.outside.off') },
            { v: 'dim', t: i18n.t('sm.depth.outside.dim') },
            { v: 'hide', t: i18n.t('sm.depth.outside.hide') }
        ]);
        const minAlpha = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: state.minAlpha });

        i18n.bindDom(enabled.dom, 'sm.depth.enabled-tip', 'title');
        const floating = makeFloating(this, { key: 'depthFilter', title: 'sm.depth.title', extras: [helpButton(events, 'depthFilter'), enabled.dom] });
        row('sm.depth.near', near, 'sm.depth.near-tip');
        row('sm.depth.far', far, 'sm.depth.far-tip');
        row('sm.depth.outside', display, 'sm.depth.outside-tip');
        row('sm.depth.min-alpha', minAlpha, 'sm.depth.min-alpha-tip');

        let syncing = false;
        const sync = () => {
            const s = events.invoke('depthFilter') as DepthFilterState;
            syncing = true;
            enabled.value = s.enabled;
            near.value = s.near;
            far.value = s.far;
            display.value = s.display;
            minAlpha.value = s.minAlpha;
            syncing = false;
            this.class[s.enabled ? 'add' : 'remove']('active');
            const fmt = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
            floating.setInfo(s.enabled ? `${fmt(s.near)}–${fmt(s.far)} m` : '');
        };

        enabled.on('change', (value: boolean) => !syncing && set({ enabled: value }));
        near.on('change', (value: number) => {
            if (syncing) return;
            // dragging near past far pushes far along
            const s = events.invoke('depthFilter') as DepthFilterState;
            set({ near: value, far: Math.max(value, s.far) });
        });
        far.on('change', (value: number) => {
            if (syncing) return;
            const s = events.invoke('depthFilter') as DepthFilterState;
            set({ far: value, near: Math.min(value, s.near) });
        });
        display.on('change', (value: string) => !syncing && set({ display: value as DepthFilterState['display'] }));
        minAlpha.on('change', (value: number) => !syncing && set({ minAlpha: value }));

        events.on('depthFilter.changed', sync);
        sync();
    }
}

export { DepthFilterPanel };
