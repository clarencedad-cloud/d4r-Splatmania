import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { CameraList } from './camera-list';
import { CleanupPanel } from './cleanup-panel';
import { CollapsibleSection } from './collapsible';
import { ColorPanel } from './color-panel';
import { LayerAnimPanel } from './layer-anim-panel';
import { i18n } from './localization';
import { SplatList } from './splat-list';
import sceneImportSvg from './svg/import.svg';
import sceneNewSvg from './svg/new.svg';
import soloSvg from './svg/solo.svg';
import { Tooltips } from './tooltips';
import { Transform } from './transform';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class ScenePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'scene-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const sceneHeader = new Container({
            class: 'panel-header'
        });

        const sceneIcon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const sceneLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(sceneLabel, 'panel.scene');

        let soloActive = false;

        const soloToggle = new Container({
            class: 'panel-header-button'
        });
        soloToggle.dom.appendChild(createSvg(soloSvg));

        soloToggle.on('click', () => {
            soloActive = !soloActive;
            if (soloActive) {
                soloToggle.class.add('active');
            } else {
                soloToggle.class.remove('active');
            }
            events.fire('scene.solo', soloActive);
        });

        const sceneImport = new Container({
            class: 'panel-header-button'
        });
        sceneImport.dom.appendChild(createSvg(sceneImportSvg));

        const sceneNew = new Container({
            class: 'panel-header-button'
        });
        sceneNew.dom.appendChild(createSvg(sceneNewSvg));

        sceneHeader.append(sceneIcon);
        sceneHeader.append(sceneLabel);
        sceneHeader.append(soloToggle);
        sceneHeader.append(sceneImport);
        sceneHeader.append(sceneNew);

        sceneImport.on('click', async () => {
            await events.invoke('scene.import');
        });

        sceneNew.on('click', () => {
            events.invoke('doc.new');
        });

        tooltips.register(soloToggle, () => i18n.t('tooltip.scene.solo'), 'top');
        tooltips.register(sceneImport, () => i18n.t('tooltip.scene.import'), 'top');
        tooltips.register(sceneNew, () => i18n.t('tooltip.scene.new'), 'top');

        const splatList = new SplatList(events);

        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);

        // sections by relevance: layers, their transform, cameras, then the
        // animation and effect tools; each one collapsible (ui/collapsible.ts)

        const splatsSection = new CollapsibleSection({ key: 'splats', title: 'Splats', icon: '\uE344', open: true });
        splatsSection.body.append(splatListContainer);

        const transformSection = new CollapsibleSection({ key: 'transform', title: i18n.t('panel.scene.transform'), icon: '\uE111', open: true });
        transformSection.body.append(new Transform(events));

        // the layers live in the scene, the transform acts on the selected one
        const syncInfo = () => {
            const layers = events.functions.has('layerAnim.layers') ? events.invoke('layerAnim.layers').length : 0;
            splatsSection.setInfo(layers ? `${layers} Layer` : '');
            const splat = events.functions.has('selection') ? events.invoke('selection') : null;
            transformSection.setInfo(splat?.name ?? '');
        };
        ['scene.elementAdded', 'scene.elementRemoved', 'selection.changed', 'splat.name'].forEach(name => events.on(name, syncInfo));

        this.append(sceneHeader);
        this.append(splatsSection);
        this.append(transformSection);
        this.append(new CameraList(events));
        this.append(new LayerAnimPanel(events));
        this.append(new CleanupPanel(events));
        this.append(new ColorPanel(events));
    }
}

export { ScenePanel };
