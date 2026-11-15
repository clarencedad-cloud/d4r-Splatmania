import { BooleanInput, Button, ColorPicker, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import type { Title } from '../titles';
import { helpButton } from './help';
import { i18n } from './localization';
import titlesSvg from './svg/titles.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type Card = {
    root: Container,
    update: (t: Title) => void
};

/**
 * The titles panel (src/titles.ts): text over the image for a frame range,
 * previewed over the viewport and drawn into image and video exports.
 */
class TitlesPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'titles-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };
        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(titlesSvg));
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'sm.titles.title');
        header.append(icon);
        header.append(label);
        header.dom.appendChild(helpButton(events, 'titles'));
        this.append(header);

        const list = new Container({ class: 'titles-list' });
        this.append(list);

        const empty = new Label({ class: 'titles-empty' });
        i18n.bindText(empty, 'sm.titles.empty');
        this.append(empty);

        const addButton = new Button({ class: 'titles-add' });
        i18n.bindText(addButton, 'sm.titles.add');
        addButton.on('click', () => events.invoke('titles.add'));
        this.append(addButton);

        const fps = () => events.invoke('timeline.frameRate') ?? 30;
        const currentFrame = () => Math.round(events.invoke('timeline.frame') ?? 0);
        const set = (id: number, patch: Partial<Title>) => events.fire('titles.update', id, patch);

        // a row of choice buttons; returns a function marking the active one
        const choices = <T extends string>(parent: Container, options: [T, string][], onPick: (value: T) => void) => {
            const group = new Container({ class: 'titles-choices' });
            const buttons = options.map(([value, key]) => {
                const button = new Button({ class: 'titles-choice' });
                i18n.bindText(button, key);
                button.on('click', () => onPick(value));
                group.append(button);
                return { value, button };
            });
            parent.append(group);
            return (value: T) => buttons.forEach(b => b.button.class[b.value === value ? 'add' : 'remove']('active'));
        };

        const row = (parent: Container, labelKey: string) => {
            const r = new Container({ class: 'titles-row' });
            const l = new Label({ class: 'titles-row-label' });
            i18n.bindText(l, labelKey);
            r.append(l);
            parent.append(r);
            return r;
        };

        const createCard = (title: Title): Card => {
            const { id } = title;
            const root = new Container({ class: 'titles-card' });
            // programmatic updates fire the inputs' change events too
            let syncing = false;
            const put = (patch: Partial<Title>) => {
                if (!syncing) set(id, patch);
            };

            const text = document.createElement('textarea');
            text.className = 'titles-text';
            text.rows = 2;
            text.addEventListener('input', () => put({ text: text.value }));
            root.dom.appendChild(text);

            // timing
            const timing = row(root, 'sm.titles.frames');
            const start = new NumericInput({ class: 'titles-num', precision: 0, min: 0 });
            const end = new NumericInput({ class: 'titles-num', precision: 0, min: 0 });
            const startHere = new Button({ class: 'titles-small', text: '⤓' });
            const endHere = new Button({ class: 'titles-small', text: '⤓' });
            tooltips.register(startHere, () => i18n.t('sm.titles.start-here'), 'top');
            tooltips.register(endHere, () => i18n.t('sm.titles.end-here'), 'top');
            timing.append(start);
            timing.append(startHere);
            timing.append(new Label({ class: 'titles-dash', text: '–' }));
            timing.append(end);
            timing.append(endHere);
            start.on('change', (v: number) => put({ start: Math.round(v) }));
            end.on('change', (v: number) => put({ end: Math.round(v) }));
            startHere.on('click', () => put({ start: currentFrame() }));
            endHere.on('click', () => put({ end: currentFrame() }));

            const fadeRow = row(root, 'sm.titles.fade');
            const fade = new SliderInput({ class: 'titles-slider', min: 0, max: 3, precision: 2, step: 0.05 });
            fadeRow.append(fade);
            fade.on('change', (v: number) => put({ fade: Math.round(v * fps()) }));

            // layout
            const positionRow = row(root, 'sm.titles.position');
            const markPosition = choices(positionRow, [
                ['top', 'sm.titles.pos-top'],
                ['center', 'sm.titles.pos-center'],
                ['lower-third', 'sm.titles.pos-lower'],
                ['bottom', 'sm.titles.pos-bottom']
            ], value => put({ position: value }));

            const alignRow = row(root, 'sm.titles.align');
            const markAlign = choices(alignRow, [
                ['left', 'sm.titles.align-left'],
                ['center', 'sm.titles.align-center'],
                ['right', 'sm.titles.align-right']
            ], value => put({ align: value }));

            const sizeRow = row(root, 'sm.titles.size');
            const size = new SliderInput({ class: 'titles-slider', min: 1, max: 25, precision: 1, step: 0.5 });
            sizeRow.append(size);
            size.on('change', (v: number) => put({ size: v / 100 }));

            // style
            const styleRow = row(root, 'sm.titles.style');
            const markFont = choices(styleRow, [
                ['sans', 'sm.titles.font-sans'],
                ['serif', 'sm.titles.font-serif'],
                ['mono', 'sm.titles.font-mono']
            ], value => put({ font: value }));

            const lookRow = row(root, 'sm.titles.color');
            const color = new ColorPicker({ class: 'titles-color', channels: 3, value: [1, 1, 1] });
            lookRow.append(color);
            color.on('change', (v: number[]) => put({ color: [v[0], v[1], v[2]] }));
            const boldLabel = new Label({ class: 'titles-inline-label' });
            i18n.bindText(boldLabel, 'sm.titles.bold');
            const bold = new BooleanInput({ class: 'titles-check' });
            const boxLabel = new Label({ class: 'titles-inline-label' });
            i18n.bindText(boxLabel, 'sm.titles.box');
            const box = new BooleanInput({ class: 'titles-check' });
            lookRow.append(boldLabel);
            lookRow.append(bold);
            lookRow.append(boxLabel);
            lookRow.append(box);
            bold.on('change', (v: boolean) => put({ bold: v }));
            box.on('change', (v: boolean) => put({ box: v }));

            // actions
            const actions = new Container({ class: 'titles-actions' });
            const jump = new Button({ class: 'titles-small-text' });
            i18n.bindText(jump, 'sm.titles.jump');
            const remove = new Button({ class: ['titles-small-text', 'titles-remove'] });
            i18n.bindText(remove, 'sm.titles.remove');
            actions.append(jump);
            actions.append(remove);
            root.append(actions);
            jump.on('click', () => {
                const t = (events.invoke('titles.list') as Title[]).find(x => x.id === id);
                if (t) events.fire('timeline.setFrame', Math.round((t.start + t.end) / 2));
            });
            remove.on('click', () => events.fire('titles.remove', id));

            const update = (t: Title) => {
                syncing = true;
                if (document.activeElement !== text && text.value !== t.text) text.value = t.text;
                if (start.value !== t.start) start.value = t.start;
                if (end.value !== t.end) end.value = t.end;
                const fadeSeconds = Math.round(t.fade / fps() * 100) / 100;
                if (fade.value !== fadeSeconds) fade.value = fadeSeconds;
                const sizePercent = Math.round(t.size * 1000) / 10;
                if (size.value !== sizePercent) size.value = sizePercent;
                markPosition(t.position);
                markAlign(t.align);
                markFont(t.font);
                color.value = [...t.color, 1];
                bold.value = t.bold;
                box.value = t.box;
                syncing = false;
            };
            update(title);
            root.dom.addEventListener('focusin', () => {
                const t = (events.invoke('titles.list') as Title[]).find(x => x.id === id);
                if (t && !syncing) {
                    const frame = currentFrame();
                    if (frame < t.start || frame > t.end) events.fire('timeline.setFrame', t.start + Math.min(t.fade, Math.round((t.end - t.start) / 2)));
                }
            });
            return { root, update };
        };

        const cards = new Map<number, Card>();
        const sync = () => {
            const titles = (events.functions.has('titles.list') ? events.invoke('titles.list') : []) as Title[];
            for (const [id, card] of cards) {
                if (!titles.some(t => t.id === id)) {
                    card.root.destroy();
                    cards.delete(id);
                }
            }
            for (const t of titles) {
                let card = cards.get(t.id);
                if (!card) {
                    card = createCard(t);
                    cards.set(t.id, card);
                    list.append(card.root);
                } else {
                    card.update(t);
                }
            }
            empty.hidden = titles.length > 0;
        };
        events.on('titles.changed', sync);
        events.on('timeline.frameRate', sync);

        // visibility: one options panel at a time
        const setVisible = (visible: boolean) => {
            if (visible !== this.hidden) return;
            if (visible) sync();
            this.hidden = !visible;
            events.fire('titlesPanel.visible', visible);
            if (visible) {
                events.fire('appearancePanel.setVisible', false);
                events.fire('overlaysPanel.setVisible', false);
                events.fire('settingsPanel.setVisible', false);
                events.fire('lookPanel.setVisible', false);
            }
        };
        events.function('titlesPanel.visible', () => !this.hidden);
        events.on('titlesPanel.setVisible', setVisible);
        events.on('titlesPanel.toggleVisible', () => setVisible(this.hidden));
        ['appearancePanel.visible', 'overlaysPanel.visible', 'settingsPanel.visible', 'lookPanel.visible'].forEach((name) => {
            events.on(name, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });
    }
}

export { TitlesPanel };
