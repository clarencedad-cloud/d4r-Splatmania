import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import aiShotsSvg from './svg/ai-shots.svg';
import alignSvg from './svg/align.svg';
import appearanceSvg from './svg/appearance.svg';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import composeSvg from './svg/compose.svg';
import flyCameraSvg from './svg/fly-camera.svg';
import lightSvg from './svg/light.svg';
import lookSvg from './svg/look.svg';
import orbitCameraSvg from './svg/orbit-camera.svg';
import overlaysSvg from './svg/overlays.svg';
import qualitySvg from './svg/quality.svg';
import sectionSvg from './svg/section.svg';
import titlesSvg from './svg/titles.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const appearance = new Button({
            id: 'right-toolbar-appearance',
            class: 'right-toolbar-toggle'
        });

        // look: glow, grading, lens effects (src/ui/look-panel.ts)
        const look = new Button({
            id: 'right-toolbar-look',
            class: 'right-toolbar-toggle'
        });
        look.dom.appendChild(createSvg(lookSvg));

        // relighting (src/light/light-panel.ts)
        const light = new Button({
            id: 'right-toolbar-light',
            class: 'right-toolbar-toggle'
        });
        light.dom.appendChild(createSvg(lightSvg));

        // titles over the image (src/ui/titles-panel.ts)
        const titles = new Button({
            id: 'right-toolbar-titles',
            class: 'right-toolbar-toggle'
        });
        titles.dom.appendChild(createSvg(titlesSvg));

        // shot suggestions (src/ui/ai-shots-panel.ts)
        const aiShots = new Button({
            id: 'right-toolbar-ai-shots',
            class: 'right-toolbar-toggle'
        });
        aiShots.dom.appendChild(createSvg(aiShotsSvg));

        const orbitMode = new Button({
            id: 'right-toolbar-orbit-mode',
            class: ['right-toolbar-toggle', 'active']
        });

        const flyMode = new Button({
            id: 'right-toolbar-fly-mode',
            class: 'right-toolbar-toggle'
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        const overlays = new Button({
            id: 'right-toolbar-overlays',
            class: 'right-toolbar-toggle'
        });

        // anchor alignment tool (src/tools/align-tool.ts)
        const align = new Button({
            id: 'right-toolbar-align',
            class: 'right-toolbar-tool'
        });

        const settings = new Button({
            id: 'right-toolbar-settings',
            class: 'right-toolbar-toggle',
            icon: 'E283'
        });

        appearance.dom.appendChild(createSvg(appearanceSvg));
        orbitMode.dom.appendChild(createSvg(orbitCameraSvg));
        flyMode.dom.appendChild(createSvg(flyCameraSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));
        overlays.dom.appendChild(createSvg(overlaysSvg));
        align.dom.appendChild(createSvg(alignSvg));

        // scan composition wizard (src/compose/compose-tool.ts)
        const compose = new Button({
            id: 'right-toolbar-compose',
            class: 'right-toolbar-tool'
        });
        compose.dom.appendChild(createSvg(composeSvg));

        // quality heatmap / scan comparison tool (src/quality/quality-tool.ts)
        const quality = new Button({
            id: 'right-toolbar-quality',
            class: 'right-toolbar-tool'
        });
        quality.dom.appendChild(createSvg(qualitySvg));

        // section cut tool (src/section/section-tool.ts)
        const section = new Button({
            id: 'right-toolbar-section',
            class: 'right-toolbar-tool'
        });
        section.dom.appendChild(createSvg(sectionSvg));

        // icon-only buttons: keep accessible names in sync with the language
        const buttonLabels: [Button, string][] = [
            [appearance, 'panel.appearance'],
            [overlays, 'panel.overlays'],
            [look, 'sm.look.title'],
            [light, 'sm.light.title'],
            [titles, 'sm.titles.title'],
            [aiShots, 'sm.aishots.title'],
            [compose, 'sm.compose.title'],
            [orbitMode, 'tooltip.right-toolbar.orbit-camera'],
            [flyMode, 'tooltip.right-toolbar.fly-camera'],
            [cameraFrameSelection, 'tooltip.right-toolbar.frame-selection'],
            [cameraReset, 'tooltip.right-toolbar.reset-camera'],
            [settings, 'panel.settings']
        ];
        buttonLabels.forEach(([button, key]) => {
            i18n.onChange(() => button.dom.setAttribute('aria-label', i18n.t(key)), button);
        });

        this.append(appearance);
        this.append(overlays);
        this.append(look);
        this.append(light);
        this.append(titles);
        this.append(aiShots);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(orbitMode);
        this.append(flyMode);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraReset);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(align);
        this.append(compose);
        this.append(quality);
        this.append(section);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(settings);

        // Helper to compose localized tooltip text with shortcut
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(appearance, tooltip('panel.appearance'), 'left');
        tooltips.register(orbitMode, tooltip('tooltip.right-toolbar.orbit-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(flyMode, tooltip('tooltip.right-toolbar.fly-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(cameraFrameSelection, tooltip('tooltip.right-toolbar.frame-selection', 'camera.focus'), 'left');
        tooltips.register(cameraReset, tooltip('tooltip.right-toolbar.reset-camera', 'camera.reset'), 'left');
        tooltips.register(overlays, tooltip('panel.overlays'), 'left');
        tooltips.register(look, tooltip('sm.look.title'), 'left');
        tooltips.register(light, tooltip('sm.light.title'), 'left');
        tooltips.register(titles, tooltip('sm.titles.title'), 'left');
        tooltips.register(aiShots, tooltip('sm.aishots.title'), 'left');
        tooltips.register(settings, tooltip('panel.settings'), 'left');
        tooltips.register(align, tooltip('tooltip.right-toolbar.align', 'tool.align'), 'left');
        tooltips.register(compose, tooltip('sm.compose.tooltip'), 'left');
        tooltips.register(quality, tooltip('tooltip.right-toolbar.quality', 'tool.quality'), 'left');
        tooltips.register(section, tooltip('tooltip.right-toolbar.section', 'tool.section'), 'left');

        // add event handlers

        appearance.on('click', () => events.fire('appearancePanel.toggleVisible'));
        orbitMode.on('click', () => events.fire('camera.setControlMode', 'orbit'));
        flyMode.on('click', () => events.fire('camera.setControlMode', 'fly'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
        overlays.on('click', () => events.fire('overlaysPanel.toggleVisible'));
        look.on('click', () => events.fire('lookPanel.toggleVisible'));
        light.on('click', () => events.fire('lightPanel.toggleVisible'));
        titles.on('click', () => events.fire('titlesPanel.toggleVisible'));
        aiShots.on('click', () => events.fire('aiShotsPanel.toggleVisible'));
        settings.on('click', () => events.fire('settingsPanel.toggleVisible'));
        align.on('click', () => events.fire('tool.align'));
        compose.on('click', () => events.fire('tool.compose'));
        quality.on('click', () => events.fire('tool.quality'));
        section.on('click', () => events.fire('tool.section'));

        events.on('tool.activated', (toolName: string) => {
            align.class[toolName === 'align' ? 'add' : 'remove']('active');
            compose.class[toolName === 'compose' ? 'add' : 'remove']('active');
            quality.class[toolName === 'quality' ? 'add' : 'remove']('active');
            section.class[toolName === 'section' ? 'add' : 'remove']('active');
        });

        events.on('appearancePanel.visible', (visible: boolean) => {
            appearance.class[visible ? 'add' : 'remove']('active');
        });

        events.on('camera.controlMode', (mode: 'orbit' | 'fly') => {
            orbitMode.class[mode === 'orbit' ? 'add' : 'remove']('active');
            flyMode.class[mode === 'fly' ? 'add' : 'remove']('active');
        });

        events.on('overlaysPanel.visible', (visible: boolean) => {
            overlays.class[visible ? 'add' : 'remove']('active');
        });

        events.on('titlesPanel.visible', (visible: boolean) => {
            titles.class[visible ? 'add' : 'remove']('active');
        });

        events.on('aiShotsPanel.visible', (visible: boolean) => {
            aiShots.class[visible ? 'add' : 'remove']('active');
        });

        events.on('lightPanel.visible', (visible: boolean) => {
            light.class[visible ? 'add' : 'remove']('active');
        });
        events.on('light.changed', () => {
            light.class[events.invoke('light.active') ? 'add' : 'remove']('look-on');
        });

        events.on('lookPanel.visible', (visible: boolean) => {
            look.class[visible ? 'add' : 'remove']('active');
        });

        // a dot on the button while a look is applied
        events.on('look.changed', () => {
            look.class[events.invoke('look.active') ? 'add' : 'remove']('look-on');
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            settings.class[visible ? 'add' : 'remove']('active');
        });
    }
}

export { RightToolbar };
