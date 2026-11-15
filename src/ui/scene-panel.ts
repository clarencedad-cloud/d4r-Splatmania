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

type PropertiesContext = 'splat' | 'camera' | 'cameraTarget' | 'light';

type LightInfo = { id: number, type: 'sun' | 'point' | 'spot', enabled: boolean, color: [number, number, number] };

/**
 * The scene panel, in two parts:
 * - the scene list: every object of the scene, splat layers and shot
 *   cameras, in one place
 * - the properties of what is selected there: a splat shows its transform,
 *   animation, transitions, display, cleanup and colours; a camera shows the
 *   view mode and cut and its own transform, lens and depth of field
 *
 * Single sections can be switched off in the View menu (src/ui/menu.ts).
 */
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
            text: '',
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

        // ---- scene list: splats and cameras ----

        const cameraList = new CameraList(events);

        const objectsSection = new CollapsibleSection({ key: 'objects', title: 'sm.objects.title', icon: '', open: true });

        const group = (titleKey: string, actions: HTMLElement[] = []) => {
            const header = new Container({ class: 'objects-group-header' });
            const title = new Label({ class: 'objects-group-title' });
            i18n.bindText(title, titleKey);
            const count = new Label({ text: '', class: 'objects-group-count' });
            header.append(title);
            header.append(count);
            actions.forEach(action => header.dom.appendChild(action));
            objectsSection.body.append(header);
            return count;
        };

        const splatCount = group('sm.splats.title');
        const splatList = new SplatList(events);
        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);
        objectsSection.body.append(splatListContainer);

        const cameraCount = group('sm.cameras.title', cameraList.actions);
        objectsSection.body.append(cameraList.rows);
        cameraList.onCount = (count: number) => {
            cameraCount.text = String(count);
        };

        // lights (src/light/light.ts): listed like cameras, picked to move
        // them with the gizmo, removed with the cross or Delete
        const lightAdd = new Label({ text: '+', class: ['panel-header-button', 'camera-list-button'] });
        i18n.bindDom(lightAdd.dom, 'sm.light.add-from-list', 'title');
        lightAdd.dom.addEventListener('click', () => events.fire('lightPanel.setVisible', true));
        const lightCount = group('sm.light.lights', [lightAdd.dom]);
        const lightRows = new Container({ class: ['camera-list-rows', 'light-list-rows'] });
        objectsSection.body.append(lightRows);

        const lightsNow = (): LightInfo[] => (events.functions.has('light.state') ? events.invoke('light.state').lights : []);
        const lightName = (lights: LightInfo[], light: LightInfo) => {
            const sameType = lights.filter(l => l.type === light.type);
            const n = sameType.indexOf(light) + 1;
            const type = i18n.t(`sm.light.type-${light.type}`);
            return sameType.length > 1 ? `${type} ${n}` : type;
        };
        const rgb = (c: [number, number, number]) => `rgb(${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(', ')})`;

        // which object the properties show: the last one picked in the
        // scene list (or in the viewport / timeline)
        let context: PropertiesContext = 'camera';

        let lightRowsPending = false;
        const rebuildLights = () => {
            lightRowsPending = false;
            lightRows.dom.innerHTML = '';
            const lights = lightsNow();
            lightCount.text = lights.length ? String(lights.length) : '';
            const selected = events.functions.has('light.selected') ? events.invoke('light.selected') : null;
            for (const light of lights) {
                const row = document.createElement('div');
                row.classList.add('camera-list-row');
                if (light.id === selected && context === 'light') row.classList.add('selected');
                if (!light.enabled) row.classList.add('light-off');

                const swatch = document.createElement('span');
                swatch.classList.add('camera-list-swatch', 'light-list-swatch');
                swatch.style.backgroundColor = rgb(light.color);

                const name = document.createElement('span');
                name.classList.add('camera-list-name');
                name.textContent = lightName(lights, light);

                const toggle = document.createElement('span');
                toggle.classList.add('camera-list-keys', 'light-list-toggle');
                toggle.textContent = i18n.t(light.enabled ? 'sm.light.on' : 'sm.light.off');
                toggle.title = i18n.t('sm.light.toggle-tip');

                const remove = document.createElement('span');
                remove.classList.add('camera-list-remove');
                remove.textContent = '✕';
                remove.title = i18n.t('sm.light.remove');

                row.append(swatch, name, toggle, remove);
                lightRows.dom.appendChild(row);

                row.addEventListener('click', () => events.fire('light.select', light.id));
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    events.fire('light.update', light.id, { enabled: !light.enabled });
                });
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    events.fire('light.remove', light.id);
                });
            }
        };
        // light.changed fires every frame while dragging or playing: one
        // rebuild per animation frame at most
        const scheduleLights = () => {
            if (lightRowsPending) return;
            lightRowsPending = true;
            requestAnimationFrame(rebuildLights);
        };
        events.on('light.changed', scheduleLights);
        events.on('light.selected', scheduleLights);
        i18n.onChange(scheduleLights);

        // ---- properties of the selected object ----

        const propsHeader = new Container({ class: 'properties-header' });
        const propsTitle = new Label({ class: 'properties-title' });
        i18n.bindText(propsTitle, 'sm.properties.title');
        const propsSwatch = new Label({ text: '', class: 'properties-swatch' });
        const propsName = new Label({ text: '', class: 'properties-name' });
        propsHeader.append(propsTitle);
        propsHeader.append(propsSwatch);
        propsHeader.append(propsName);

        const transformSection = new CollapsibleSection({ key: 'transform', title: 'panel.scene.transform', icon: '', open: true });
        transformSection.body.append(new Transform(events));

        const splatProps = new Container({ class: 'properties-body' });
        splatProps.append(transformSection);
        splatProps.append(new LayerAnimPanel(events));
        splatProps.append(new CleanupPanel(events));
        splatProps.append(new ColorPanel(events));

        const cameraProps = new Container({ class: 'properties-body' });
        cameraProps.append(cameraList);

        // a picked light: how to move it; its own controls stay in the
        // light panel
        const lightProps = new Container({ class: ['properties-body', 'light-props'] });
        const lightHint = new Label({ class: ['properties-empty', 'light-props-hint'] });
        i18n.bindText(lightHint, 'sm.light.props-hint');
        const lightOpenPanel = new Label({ class: ['camera-list-mode', 'light-props-open'] });
        i18n.bindText(lightOpenPanel, 'sm.light.open-panel');
        lightOpenPanel.dom.addEventListener('click', () => events.fire('lightPanel.setVisible', true));
        lightProps.append(lightHint);
        lightProps.append(lightOpenPanel);

        const propsEmpty = new Label({ class: 'properties-empty' });
        i18n.bindText(propsEmpty, 'sm.properties.empty');

        const selectedSplat = () => (events.functions.has('selection') ? events.invoke('selection') : null);

        const sync = () => {
            const splat = selectedSplat();
            if (context === 'splat' && !splat) context = 'camera';
            const lightId = events.functions.has('light.selected') ? events.invoke('light.selected') : null;
            const lights = lightsNow();
            const light = lights.find(l => l.id === lightId) ?? null;
            if (context === 'light' && !light) context = 'camera';
            const camera = events.functions.has('shotCameras.selected') ? events.invoke('shotCameras.selected') : null;

            if (context === 'cameraTarget' && !camera) context = 'camera';
            splatProps.hidden = context !== 'splat';
            cameraProps.hidden = (context !== 'camera' && context !== 'cameraTarget') || !camera;
            lightProps.hidden = context !== 'light';
            propsEmpty.hidden = !(splatProps.hidden && cameraProps.hidden && lightProps.hidden);
            this.class[context === 'camera' ? 'add' : 'remove']('context-camera');
            this.class[context === 'splat' ? 'add' : 'remove']('context-splat');

            if (context === 'splat') {
                propsName.text = splat?.name ?? '';
                propsSwatch.hidden = true;
            } else if (context === 'light' && light) {
                propsName.text = lightName(lights, light);
                propsSwatch.hidden = false;
                propsSwatch.dom.style.backgroundColor = rgb(light.color);
            } else if (context === 'cameraTarget' && camera) {
                propsName.text = `${camera.name} · ${i18n.t('sm.camera-props.target')}`;
                propsSwatch.hidden = false;
                propsSwatch.dom.style.backgroundColor = `rgb(${camera.color.join(', ')})`;
            } else {
                propsName.text = camera?.name ?? '';
                propsSwatch.hidden = !camera;
                if (camera) propsSwatch.dom.style.backgroundColor = `rgb(${camera.color.join(', ')})`;
            }

            const layers = events.functions.has('layerAnim.layers') ? events.invoke('layerAnim.layers').length : 0;
            splatCount.text = layers ? String(layers) : '';
        };

        const setContext = (value: PropertiesContext) => {
            context = value;
            events.fire('transform.setTarget', value);
            // leaving a light drops its move gizmo
            if (value !== 'light' && events.functions.has('light.selected') && events.invoke('light.selected') !== null) {
                events.fire('light.select', null);
            }
            sync();
            scheduleLights();
        };

        events.on('selection.changed', (splat: unknown) => setContext(splat ? 'splat' : 'camera'));
        // picking the already selected splat again shows it too
        events.on('selection', (splat: unknown) => {
            if (splat) setContext('splat');
        });
        // the target row of a camera: its look-at point as its own object
        events.on('cameraTarget.select', (id: number) => {
            if (events.invoke('shotCameras.selected')?.id !== id) events.fire('shotCameras.select', id);
            setContext('cameraTarget');
        });

        // a light picked in the scene list shows its properties
        events.on('light.selected', (id: number | null) => {
            if (id !== null) setContext('light');
        });
        ['shotCameras.select', 'shotCameras.add', 'shotCameras.duplicate'].forEach((name) => {
            events.on(name, () => setContext('camera'));
        });
        ['scene.elementAdded', 'scene.elementRemoved', 'splat.name', 'shotCameras.changed', 'light.changed', 'light.selected'].forEach(name => events.on(name, sync));
        i18n.onChange(sync);

        this.append(sceneHeader);
        this.append(objectsSection);
        this.append(propsHeader);
        this.append(propsEmpty);
        this.append(splatProps);
        this.append(cameraProps);
        this.append(lightProps);

        sync();
    }
}

export { ScenePanel };
