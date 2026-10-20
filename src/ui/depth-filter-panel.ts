import { BooleanInput, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import type { DepthFilterState } from '../depth-filter';
import { Events } from '../events';

// floating panel for the depth-limited selection (src/depth-filter.ts)
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
            const label = new Label({ text: labelText, class: 'depth-filter-label' });
            if (title) {
                container.dom.title = title;
            }
            container.append(label);
            container.append(input);
            this.append(container);
            return container;
        };

        const enabled = new BooleanInput({ type: 'toggle', value: state.enabled });
        const near = new SliderInput({ min: 0, max: 100000, sliderMin: 0, sliderMax: 20, precision: 2, step: 0.1, value: state.near });
        const far = new SliderInput({ min: 0, max: 100000, sliderMin: 0, sliderMax: 20, precision: 2, step: 0.1, value: state.far });
        const display = new SelectInput({
            options: [
                { v: 'off', t: 'Normal' },
                { v: 'dim', t: 'Abdunkeln' },
                { v: 'hide', t: 'Ausblenden' }
            ],
            value: state.display
        });
        const minAlpha = new SliderInput({ min: 0, max: 1, sliderMin: 0, sliderMax: 1, precision: 2, step: 0.01, value: state.minAlpha });

        row('Tiefenfilter', enabled, 'Rechteck, Lasso, Polygon, Pinsel und Klick erfassen nur Splats im Tiefenbereich');
        row('Near (m)', near, 'Mindestabstand zur Kamera (View-Tiefe der Splat-Mitte)');
        row('Far (m)', far, 'Maximalabstand zur Kamera');
        row('Außerhalb', display, 'Wie Splats außerhalb des Bereichs angezeigt werden');
        row('Min. Deckkraft', minAlpha,
            'Nur sichtbare Splats: Bei Tiefen-Selektion (Depth an) gewinnt ein Splat ein Pixel nur, wenn er dort mindestens diese Deckkraft beiträgt. 0 = aus');

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
