import { BooleanInput, Container, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { opFromModifiers } from '../select-op';
import { i18n } from '../ui/localization';

type NormalizedPoint = { x: number, y: number };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

class EyedropperSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, canvasContainer: Container) {
        let pointerId: number | null = null;
        let threshold = 0.2;
        // "Farb-Floater": only the clump around the click (color-region.ts)
        let connected = true;
        let radius = 5;

        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const thresholdInput = new NumericInput({
            value: threshold,
            width: 120,
            precision: 3,
            min: 0,
            max: 1
        });

        // labels and roll-over texts: the pipette is not self-explanatory
        const label = (key: string, tip: string, target: { dom: HTMLElement }[]) => {
            const l = new Label({ class: 'select-toolbar-label' });
            i18n.bindText(l, key);
            for (const t of [l, ...target]) i18n.bindDom(t.dom, tip, 'title');
            return l;
        };

        const connectedInput = new BooleanInput({ type: 'toggle', value: connected });
        const radiusInput = new NumericInput({
            value: radius,
            width: 80,
            precision: 2,
            min: 0
        });

        selectToolbar.append(label('select-toolbar.color-tolerance', 'select-toolbar.color-tolerance-tip', [thresholdInput]));
        selectToolbar.append(thresholdInput);
        selectToolbar.append(label('select-toolbar.color-clump', 'select-toolbar.color-clump-tip', [connectedInput]));
        selectToolbar.append(connectedInput);
        selectToolbar.append(label('select-toolbar.color-radius', 'select-toolbar.color-radius-tip', [radiusInput]));
        selectToolbar.append(radiusInput);
        canvasContainer.append(selectToolbar);

        connectedInput.on('change', (value: boolean) => {
            connected = value;
        });
        radiusInput.on('change', () => {
            radius = Math.max(0, radiusInput.value ?? 0);
        });

        // Convert pointer event to normalized coordinates within the parent element
        const toNormalizedPoint = (event: PointerEvent): NormalizedPoint => {
            const width = parent.clientWidth || 1;
            const height = parent.clientHeight || 1;
            return {
                x: clamp01(event.offsetX / width),
                y: clamp01(event.offsetY / height)
            };
        };

        const resetPointer = () => {
            if (pointerId !== null) {
                parent.releasePointerCapture(pointerId);
                pointerId = null;
            }
        };

        thresholdInput.on('change', () => {
            threshold = clamp01(thresholdInput.value ?? threshold);
        });

        const pointerdown = (event: PointerEvent) => {
            if (pointerId === null && (event.pointerType === 'mouse' ? event.button === 0 : event.isPrimary)) {
                event.preventDefault();
                event.stopPropagation();
                pointerId = event.pointerId;
                parent.setPointerCapture(pointerId);
            }
        };

        const pointermove = (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                event.preventDefault();
                event.stopPropagation();
            }
        };

        const pointerup = async (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                event.preventDefault();
                event.stopPropagation();

                await events.invoke(
                    'select.colorMatch',
                    opFromModifiers(event),
                    toNormalizedPoint(event),
                    threshold,
                    { connected, radius }
                );

                resetPointer();
            }
        };

        const pointercancel = (event: PointerEvent) => {
            if (event.pointerId === pointerId) {
                event.preventDefault();
                event.stopPropagation();
                resetPointer();
            }
        };

        this.activate = () => {
            parent.style.display = 'block';
            selectToolbar.hidden = false;
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
        };

        this.deactivate = () => {
            parent.style.display = 'none';
            selectToolbar.hidden = true;
            resetPointer();
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
        };
    }
}

export { EyedropperSelection };
