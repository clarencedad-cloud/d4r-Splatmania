import { BooleanInput, Button, ColorPicker, Container, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { helpButton } from './help';
import { createKeyButton, KeyState } from './key-button';
import { i18n } from './localization';
import lookSvg from './svg/look.svg';
import resetSvg from './svg/reset.svg';
import { Tooltips } from './tooltips';
import type { LookParams } from '../look/look-renderer';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type NumberKey = 'bloom' | 'bloomThreshold' | 'bloomRadius' | 'exposure' | 'contrast' | 'saturation' | 'temperature' |
    'vignette' | 'vignetteSoftness' | 'grain' | 'aberration' | 'lutStrength' | 'fog' | 'fogStart' | 'fogEnd';

/**
 * The look panel (src/look/look.ts): glow, grading, lens effects and a LUT
 * over the rendered image, live in the viewport and in every export.
 */
class LookPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'look-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };

        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // header

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(lookSvg));
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'sm.look.title');
        const resetButton = new Container({ class: ['panel-header-button', 'panel-header-reset-button'] });
        resetButton.dom.appendChild(createSvg(resetSvg));
        resetButton.dom.setAttribute('role', 'button');
        resetButton.dom.setAttribute('tabindex', '0');
        tooltips.register(resetButton, () => i18n.t('sm.look.reset'), 'left');
        // key button of the whole look: key / remove the key at this frame
        const keyButton = createKeyButton(events, () => {
            return events.functions.has('look.keyState') ? events.invoke('look.keyState') as KeyState : null;
        }, () => {
            events.fire('look.selectTrack');
            if (events.invoke('look.keyState') === 'keyed') {
                events.fire('look.removeKey');
            } else {
                events.fire('look.addKey');
            }
        });
        keyButton.dom.classList.add('look-key-button');
        header.append(icon);
        header.append(label);
        header.dom.appendChild(helpButton(events, 'look'));
        header.dom.appendChild(keyButton.dom);
        header.append(resetButton);
        this.append(header);

        const help = (key: string) => () => i18n.t(key);

        const section = (key: string) => {
            const container = new Container({ class: ['panel-header', 'options-panel-section'] });
            const sectionLabel = new Label({ class: 'panel-header-label' });
            i18n.bindText(sectionLabel, key);
            container.append(sectionLabel);
            this.append(container);
        };

        const row = (labelKey: string, tipKey?: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            if (tipKey) tooltips.register(rowLabel, help(tipKey), 'left');
            container.append(rowLabel);
            this.append(container);
            return container;
        };

        const sliders = new Map<NumberKey, SliderInput>();
        let syncing = false;

        // sliderMax: the slider's range when typed values may go beyond it
        const slider = (key: NumberKey, labelKey: string, tipKey: string, min: number, max: number, precision: number, sliderMax = max) => {
            const container = row(labelKey, tipKey);
            const input = new SliderInput({
                class: 'settings-panel-row-slider',
                min,
                max,
                sliderMin: min,
                sliderMax,
                precision,
                step: Math.pow(10, -precision)
            });
            container.append(input);
            input.on('change', (value: number) => {
                if (!syncing) events.fire('look.set', { [key]: value });
            });
            sliders.set(key, input);
            return input;
        };

        // on / off

        const enabledRow = row('sm.look.enabled', 'sm.look.enabled-tip');
        const enabledToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
        enabledRow.append(enabledToggle);
        enabledToggle.on('change', (value: boolean) => {
            if (!syncing) events.fire('look.set', { enabled: value });
        });

        // glow

        section('sm.look.glow');
        slider('bloom', 'sm.look.bloom', 'sm.look.bloom-tip', 0, 3, 2);
        slider('bloomThreshold', 'sm.look.threshold', 'sm.look.threshold-tip', 0, 1.5, 2);
        slider('bloomRadius', 'sm.look.radius', 'sm.look.radius-tip', 0, 1, 2);
        const tintRow = row('sm.look.tint', 'sm.look.tint-tip');
        const tintPickers = new Container({ class: 'settings-panel-row-pickers' });
        const tintPicker = new ColorPicker({ class: 'settings-panel-row-picker', channels: 3, value: [1, 1, 1] });
        tintPickers.append(tintPicker);
        tintRow.append(tintPickers);
        tintPicker.on('change', (value: number[]) => {
            if (!syncing) events.fire('look.set', { bloomTint: [value[0], value[1], value[2]] });
        });

        // grading

        section('sm.look.grading');
        slider('exposure', 'sm.look.exposure', 'sm.look.exposure-tip', -3, 3, 2);
        slider('contrast', 'sm.look.contrast', 'sm.look.contrast-tip', 0, 2, 2);
        slider('saturation', 'sm.look.saturation', 'sm.look.saturation-tip', 0, 2, 2);
        slider('temperature', 'sm.look.temperature', 'sm.look.temperature-tip', -1, 1, 2);

        // lens

        section('sm.look.lens');
        slider('vignette', 'sm.look.vignette', 'sm.look.vignette-tip', 0, 1, 2);
        slider('vignetteSoftness', 'sm.look.softness', 'sm.look.softness-tip', 0, 1, 2);
        slider('grain', 'sm.look.grain', 'sm.look.grain-tip', 0, 0.3, 3);
        slider('aberration', 'sm.look.aberration', 'sm.look.aberration-tip', 0, 1, 2);

        // fog

        section('sm.look.fog');
        slider('fog', 'sm.look.fog-strength', 'sm.look.fog-strength-tip', 0, 1, 2);
        slider('fogStart', 'sm.look.fog-start', 'sm.look.fog-start-tip', 0, 100000, 1, 100);
        slider('fogEnd', 'sm.look.fog-end', 'sm.look.fog-end-tip', 0, 100000, 1, 200);
        const fogColorRow = row('sm.look.fog-color', 'sm.look.fog-color-tip');
        const fogColorToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: false });
        const fogPickers = new Container({ class: 'settings-panel-row-pickers' });
        const fogPicker = new ColorPicker({ class: 'settings-panel-row-picker', channels: 3, value: [0.6, 0.65, 0.7] });
        fogPickers.append(fogPicker);
        fogColorRow.append(fogColorToggle);
        fogColorRow.append(fogPickers);
        fogColorToggle.on('change', (value: boolean) => {
            if (!syncing) events.fire('look.set', { fogMode: value ? 'color' : 'fade' });
        });
        fogPicker.on('change', (value: number[]) => {
            if (!syncing) events.fire('look.set', { fogColor: [value[0], value[1], value[2]] });
        });

        // lut

        section('sm.look.lut');
        const lutRow = row('sm.look.lut-file', 'sm.look.lut-tip');
        const lutButtons = new Container({ class: 'look-lut-buttons' });
        const lutName = new Label({ class: 'look-lut-name' });
        const lutLoad = new Button({ class: 'look-lut-button' });
        const lutClear = new Button({ class: 'look-lut-button', text: '✕' });
        i18n.bindText(lutLoad, 'sm.look.lut-load');
        tooltips.register(lutClear, help('sm.look.lut-clear'), 'top');
        lutButtons.append(lutName);
        lutButtons.append(lutLoad);
        lutButtons.append(lutClear);
        lutRow.append(lutButtons);
        const lutStrength = slider('lutStrength', 'sm.look.lut-strength', 'sm.look.lut-strength-tip', 0, 1, 2);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.cube';
        fileInput.style.display = 'none';
        this.dom.appendChild(fileInput);
        lutLoad.on('click', () => {
            fileInput.value = '';
            fileInput.click();
        });
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                events.fire('look.loadLut', file.name.replace(/\.cube$/i, ''), await file.text());
            } catch (err) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('sm.look.lut-error'),
                    message: (err as Error).message
                });
            }
        });
        lutClear.on('click', () => events.fire('look.clearLut'));

        resetButton.dom.addEventListener('click', () => events.fire('look.reset'));
        resetButton.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                events.fire('look.reset');
            }
        });

        // state -> controls

        const sync = () => {
            if (!events.functions.has('look.state')) return;
            const state = events.invoke('look.state') as LookParams;
            if (!state) return;
            syncing = true;
            enabledToggle.value = state.enabled;
            sliders.forEach((input, key) => {
                if (input.value !== state[key]) input.value = state[key];
            });
            tintPicker.value = [...state.bloomTint, 1];
            fogColorToggle.value = state.fogMode === 'color';
            fogPicker.value = [...state.fogColor, 1];
            fogPicker.enabled = state.fogMode === 'color';
            lutName.text = state.lut ? state.lut.name : i18n.t('sm.look.lut-none');
            lutClear.enabled = !!state.lut;
            lutStrength.enabled = !!state.lut;
            syncing = false;
            this.class[state.enabled ? 'remove' : 'add']('look-disabled');
        };
        events.on('look.changed', sync);
        i18n.onChange(sync, this);

        // visibility: one options panel at a time

        const setVisible = (visible: boolean) => {
            if (visible !== this.hidden) return;
            if (visible) sync();
            this.hidden = !visible;
            events.fire('lookPanel.visible', visible);
            if (visible) {
                events.fire('appearancePanel.setVisible', false);
                events.fire('overlaysPanel.setVisible', false);
                events.fire('settingsPanel.setVisible', false);
                events.fire('titlesPanel.setVisible', false);
            }
        };

        events.function('lookPanel.visible', () => !this.hidden);
        events.on('lookPanel.setVisible', setVisible);
        events.on('lookPanel.toggleVisible', () => setVisible(this.hidden));
        ['appearancePanel.visible', 'overlaysPanel.visible', 'settingsPanel.visible', 'titlesPanel.visible'].forEach((name) => {
            events.on(name, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });
    }
}

export { LookPanel };
