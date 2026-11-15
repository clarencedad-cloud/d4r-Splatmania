import { BooleanInput, Button, ColorPicker, Container, Label, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import type { Light, LightRig, LightType } from './light';
import { helpButton } from '../ui/help';
import { createKeyButton, KeyState } from '../ui/key-button';
import { i18n } from '../ui/localization';
import lightSvg from '../ui/svg/light.svg';
import resetSvg from '../ui/svg/reset.svg';
import { Tooltips } from '../ui/tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type Card = { root: Container, update: (l: Light) => void };

/**
 * The light panel (src/light/light.ts): dim the scanned light, add ambient
 * and up to four sun / point / spot lights, keyed as a whole.
 */
class LightPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'light-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };
        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const help = (key: string) => () => i18n.t(key);
        const state = () => (events.functions.has('light.state') ? events.invoke('light.state') as LightRig : null);
        let syncing = false;

        // header: icon, title, key button, reset

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(lightSvg));
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'sm.light.title');
        const keyButton = createKeyButton(events, () => {
            return events.functions.has('light.keyState') ? events.invoke('light.keyState') as KeyState : null;
        }, () => {
            events.fire('light.selectTrack');
            if (events.invoke('light.keyState') === 'keyed') {
                events.fire('light.removeKey');
            } else {
                events.fire('light.addKey');
            }
        });
        keyButton.dom.classList.add('look-key-button');
        const resetButton = new Container({ class: ['panel-header-button', 'panel-header-reset-button'] });
        resetButton.dom.appendChild(createSvg(resetSvg));
        resetButton.dom.setAttribute('role', 'button');
        tooltips.register(resetButton, () => i18n.t('sm.light.reset'), 'left');
        resetButton.dom.addEventListener('click', () => events.fire('light.reset'));
        header.append(icon);
        header.append(label);
        header.dom.appendChild(helpButton(events, 'light'));
        header.dom.appendChild(keyButton.dom);
        header.append(resetButton);
        this.append(header);

        const row = (parent: Container, labelKey: string, tipKey?: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            if (tipKey) tooltips.register(rowLabel, help(tipKey), 'left');
            container.append(rowLabel);
            parent.append(container);
            return container;
        };

        const slider = (parent: Container, labelKey: string, tipKey: string, min: number, max: number, precision: number, onChange: (v: number) => void, sliderMax = max) => {
            const input = new SliderInput({
                class: 'settings-panel-row-slider',
                min,
                max,
                sliderMin: min,
                sliderMax,
                precision,
                step: Math.pow(10, -precision)
            });
            row(parent, labelKey, tipKey).append(input);
            input.on('change', (v: number) => {
                if (!syncing) onChange(v);
            });
            return input;
        };

        // global

        const enabledToggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
        row(this, 'sm.light.enabled', 'sm.light.enabled-tip').append(enabledToggle);
        enabledToggle.on('change', (v: boolean) => !syncing && events.fire('light.set', { enabled: v }));

        const baked = slider(this, 'sm.light.baked', 'sm.light.baked-tip', 0, 2, 2, v => events.fire('light.set', { baked: v }));
        const ambient = slider(this, 'sm.light.ambient', 'sm.light.ambient-tip', 0, 2, 2, v => events.fire('light.set', { ambientStrength: v }));
        const ambientColor = new ColorPicker({ class: 'settings-panel-row-picker', channels: 3, value: [1, 1, 1] });
        row(this, 'sm.light.ambient-color').append(ambientColor);
        ambientColor.on('change', (v: number[]) => !syncing && events.fire('light.set', { ambient: [v[0], v[1], v[2]] }));
        const wrap = slider(this, 'sm.light.wrap', 'sm.light.wrap-tip', 0, 1, 2, v => events.fire('light.set', { wrap: v }));

        // lights

        const lightsHeader = new Container({ class: ['panel-header', 'options-panel-section'] });
        const lightsLabel = new Label({ class: 'panel-header-label' });
        i18n.bindText(lightsLabel, 'sm.light.lights');
        lightsHeader.append(lightsLabel);
        this.append(lightsHeader);

        const list = new Container({ class: 'light-list' });
        this.append(list);

        const empty = new Label({ class: 'light-empty' });
        i18n.bindText(empty, 'sm.light.empty');
        this.append(empty);

        const addRow = new Container({ class: 'light-add-row' });
        (['sun', 'point', 'spot'] as LightType[]).forEach((type) => {
            const b = new Button({ class: 'light-add' });
            i18n.bindText(b, `sm.light.add-${type}`);
            b.on('click', () => events.invoke('light.add', type));
            addRow.append(b);
        });
        this.append(addRow);

        const createCard = (light: Light): Card => {
            const { id, type } = light;
            const root = new Container({ class: 'light-card' });
            let cardSyncing = false;
            const put = (patch: Partial<Light>) => {
                if (!cardSyncing) events.fire('light.update', id, patch);
            };

            const title = new Container({ class: 'light-card-title' });
            const enabled = new BooleanInput({ class: 'light-check' });
            enabled.on('change', (v: boolean) => put({ enabled: v }));
            const name = new Label({ class: 'light-card-name' });
            i18n.bindText(name, `sm.light.type-${type}`);
            const remove = new Button({ class: 'light-small', text: '✕' });
            tooltips.register(remove, () => i18n.t('sm.light.remove'), 'top');
            remove.on('click', () => events.fire('light.remove', id));
            title.append(enabled);
            title.append(name);
            title.append(remove);
            root.append(title);

            const color = new ColorPicker({ class: 'settings-panel-row-picker', channels: 3, value: [1, 1, 1] });
            row(root, 'sm.light.color').append(color);
            color.on('change', (v: number[]) => put({ color: [v[0], v[1], v[2]] }));
            const intensity = slider(root, 'sm.light.intensity', 'sm.light.intensity-tip', 0, 10, 2, v => put({ intensity: v }), 4);

            let azimuth: SliderInput | null = null;
            let elevation: SliderInput | null = null;
            let range: SliderInput | null = null;
            let cone: SliderInput | null = null;

            if (type === 'sun') {
                azimuth = slider(root, 'sm.light.azimuth', 'sm.light.azimuth-tip', -180, 180, 0, v => put({ azimuth: v }));
                elevation = slider(root, 'sm.light.elevation', 'sm.light.elevation-tip', -90, 90, 0, v => put({ elevation: v }));
            } else {
                range = slider(root, 'sm.light.range', 'sm.light.range-tip', 0.05, 10000, 2, v => put({ range: v }), 50);
                if (type === 'spot') {
                    cone = slider(root, 'sm.light.cone', 'sm.light.cone-tip', 1, 89, 0, v => put({ cone: v }));
                }
                const actions = new Container({ class: 'light-actions' });
                const place = new Button({ class: 'light-small-text' });
                i18n.bindText(place, 'sm.light.place');
                tooltips.register(place, () => i18n.t('sm.light.place-tip'), 'top');
                place.on('click', () => events.fire('light.pick', id, 'position'));
                const toCamera = new Button({ class: 'light-small-text' });
                i18n.bindText(toCamera, 'sm.light.to-camera');
                tooltips.register(toCamera, () => i18n.t('sm.light.to-camera-tip'), 'top');
                toCamera.on('click', () => events.fire('light.toCamera', id));
                actions.append(place);
                actions.append(toCamera);
                if (type === 'spot') {
                    const aim = new Button({ class: 'light-small-text' });
                    i18n.bindText(aim, 'sm.light.aim');
                    tooltips.register(aim, () => i18n.t('sm.light.aim-tip'), 'top');
                    aim.on('click', () => events.fire('light.pick', id, 'target'));
                    actions.append(aim);
                }
                root.append(actions);
            }

            const update = (l: Light) => {
                cardSyncing = true;
                enabled.value = l.enabled;
                color.value = [...l.color, 1];
                if (intensity.value !== l.intensity) intensity.value = l.intensity;
                if (azimuth && azimuth.value !== l.azimuth) azimuth.value = l.azimuth;
                if (elevation && elevation.value !== l.elevation) elevation.value = l.elevation;
                if (range && range.value !== l.range) range.value = l.range;
                if (cone && cone.value !== l.cone) cone.value = l.cone;
                root.class[l.enabled ? 'remove' : 'add']('light-off');
                cardSyncing = false;
            };
            update(light);
            return { root, update };
        };

        const cards = new Map<number, Card>();

        const sync = () => {
            const rig = state();
            if (!rig) return;
            syncing = true;
            enabledToggle.value = rig.enabled;
            if (baked.value !== rig.baked) baked.value = rig.baked;
            if (ambient.value !== rig.ambientStrength) ambient.value = rig.ambientStrength;
            ambientColor.value = [...rig.ambient, 1];
            if (wrap.value !== rig.wrap) wrap.value = rig.wrap;
            syncing = false;

            for (const [id, card] of cards) {
                if (!rig.lights.some(l => l.id === id)) {
                    card.root.destroy();
                    cards.delete(id);
                }
            }
            for (const l of rig.lights) {
                const card = cards.get(l.id);
                if (card) {
                    card.update(l);
                } else {
                    const created = createCard(l);
                    cards.set(l.id, created);
                    list.append(created.root);
                }
            }
            empty.hidden = rig.lights.length > 0;
            addRow.hidden = rig.lights.length >= 4;
            this.class[rig.enabled ? 'remove' : 'add']('look-disabled');
        };
        events.on('light.changed', sync);
        i18n.onChange(sync, this);

        // a light being placed: the panel says so, Escape cancels
        const hint = new Label({ class: 'light-hint', hidden: true });
        i18n.bindText(hint, 'sm.light.picking');
        this.append(hint);
        events.on('light.picking', (picking: unknown) => {
            hint.hidden = !picking;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && events.functions.has('light.picking') && events.invoke('light.picking')) {
                events.fire('light.pick', null);
            }
        });

        // visibility: one options panel at a time
        const others = ['appearancePanel', 'overlaysPanel', 'settingsPanel', 'lookPanel', 'titlesPanel'];
        const setVisible = (visible: boolean) => {
            if (visible !== this.hidden) return;
            if (visible) sync();
            this.hidden = !visible;
            events.fire('lightPanel.visible', visible);
            if (visible) others.forEach(name => events.fire(`${name}.setVisible`, false));
            if (!visible) events.fire('light.pick', null);
        };
        events.function('lightPanel.visible', () => !this.hidden);
        events.on('lightPanel.setVisible', setVisible);
        events.on('lightPanel.toggleVisible', () => setVisible(this.hidden));
        others.forEach((name) => {
            events.on(`${name}.visible`, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });
    }
}

export { LightPanel };
