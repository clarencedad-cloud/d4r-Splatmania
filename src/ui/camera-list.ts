import { BooleanInput, Container, Label, NumericInput, SliderInput, VectorInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import type { CameraChannel, CameraProjection, CameraViewMode, CutTrack, ShotCamera } from '../camera-poses';
import { Events } from '../events';
import type { SceneScale } from '../scene-scale';
import { CollapsibleSection } from './collapsible';
import { helpButton } from './help';
import { createKeyButton, KeyState } from './key-button';
import { i18n } from './localization';

const rgb = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

// shot camera list for the scene panel: add, duplicate, rename, delete and
// select cameras, and choose what the viewport follows on the timeline
/**
 * The shot cameras: `rows` (the camera entries of the scene list, plus
 * `actions` for its header) and, as this container, the settings shown in
 * the properties when a camera is selected (view mode and cut, then the
 * camera's own transform, lens and depth of field).
 */
class CameraList extends Container {
    readonly rows: Container;
    readonly actions: HTMLElement[];
    // camera count changed (for the scene list header)
    onCount: (count: number) => void = () => {};

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'camera-list'
        };

        super(args);

        // collapsible section: title + add / duplicate buttons

        const button = (text: string, tip: string, onClick: () => void) => {
            const b = new Label({ text, class: ['panel-header-button', 'camera-list-button'] });
            i18n.bindDom(b.dom, tip, 'title');
            b.dom.addEventListener('click', onClick);
            return b.dom;
        };

        this.actions = [
            button('+', 'sm.cameras.add', () => events.fire('shotCameras.add')),
            button('−', 'sm.cameras.remove-selected', () => events.fire('shotCameras.remove')),
            button('⧉', 'sm.cameras.duplicate', () => events.fire('shotCameras.duplicate'))
        ];

        // view mode, cut and gizmos: one section
        const section = new CollapsibleSection({ key: 'cameras', title: 'sm.cameras.view-section', icon: '', open: true, actions: [helpButton(events, 'cameras')] });
        this.append(section);
        const body = section.body;

        // rows (placed in the scene list by the scene panel)

        const rows = new Container({ class: 'camera-list-rows' });
        this.rows = rows;

        const rebuild = () => {
            rows.dom.innerHTML = '';
            const cameras = events.invoke('shotCameras.list') as ShotCamera[];
            this.onCount(cameras.length);
            const selected = events.invoke('shotCameras.selected') as ShotCamera;

            for (const camera of cameras) {
                const row = document.createElement('div');
                row.classList.add('camera-list-row');
                if (camera === selected) row.classList.add('selected');

                const swatch = document.createElement('span');
                swatch.classList.add('camera-list-swatch');
                swatch.style.backgroundColor = rgb(camera.color);

                const name = document.createElement('span');
                name.classList.add('camera-list-name');
                name.textContent = camera.name;
                name.title = i18n.t('sm.cameras.rename');

                const keys = document.createElement('span');
                keys.classList.add('camera-list-keys');
                keys.textContent = i18n.t('sm.common.keys', { count: camera.track.keys.length });

                const remove = document.createElement('span');
                remove.classList.add('camera-list-remove');
                remove.textContent = '✕';
                remove.title = i18n.t('sm.cameras.remove');

                const badge = document.createElement('span');
                badge.classList.add('camera-list-badge');
                badge.textContent = camera.projection === 'stereo' ? '360° VR' : camera.projection === 'equirect' ? '360°' : '';
                badge.hidden = camera.projection === 'standard';

                row.append(swatch, name, badge, keys, remove);
                rows.dom.appendChild(row);

                // the look-at target of the selected camera: its own object,
                // moved with the move tool and keyed on its own channel
                if (camera === selected && camera.track.placed) {
                    const targetRow = document.createElement('div');
                    targetRow.classList.add('camera-list-row', 'camera-target-row');
                    const picked = events.functions.has('transform.target') && events.invoke('transform.target') === 'cameraTarget';
                    if (picked) targetRow.classList.add('selected');
                    const targetIcon = document.createElement('span');
                    targetIcon.classList.add('camera-target-icon');
                    targetIcon.textContent = '◎';
                    targetIcon.style.color = rgb(camera.color);
                    const targetName = document.createElement('span');
                    targetName.classList.add('camera-list-name');
                    targetName.textContent = i18n.t('sm.camera-props.target');
                    const targetKeys = document.createElement('span');
                    targetKeys.classList.add('camera-list-keys');
                    targetKeys.textContent = i18n.t('sm.common.keys', { count: camera.track.keyData.filter(k => k.target).length });
                    targetRow.append(targetIcon, targetName, targetKeys);
                    targetRow.title = i18n.t('sm.camera-props.target-row-tip');
                    targetRow.addEventListener('click', () => events.fire('cameraTarget.select', camera.id));
                    rows.dom.appendChild(targetRow);
                }

                row.addEventListener('click', () => events.fire('shotCameras.select', camera.id));

                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    events.fire('shotCameras.remove', camera.id);
                });

                name.addEventListener('dblclick', (event) => {
                    event.stopPropagation();
                    const input = document.createElement('input');
                    input.classList.add('camera-list-rename');
                    input.value = camera.name;
                    name.replaceWith(input);
                    input.focus();
                    input.select();
                    let done = false;
                    const commit = (apply: boolean) => {
                        if (done) return;
                        done = true;
                        if (apply && input.value.trim()) {
                            events.fire('shotCameras.rename', camera.id, input.value.trim());
                        }
                        rebuild();
                    };
                    input.addEventListener('keydown', (e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commit(true);
                        if (e.key === 'Escape') commit(false);
                    });
                    input.addEventListener('blur', () => commit(true));
                });
            }
        };

        // view mode and gizmo options

        const options = new Container({ class: 'camera-list-options' });

        const viewLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(viewLabel, 'sm.cameras.viewport');
        // segmented buttons rather than a dropdown: the scene panel scrolls
        // and would clip a dropdown list
        const viewMode = new Container({ class: 'camera-list-viewmode' });
        const modes: [CameraViewMode, string, string][] = [
            ['free', 'sm.cameras.mode.free', 'sm.cameras.mode.free-tip'],
            ['camera', 'sm.cameras.mode.camera', 'sm.cameras.mode.camera-tip'],
            ['cut', 'sm.cameras.mode.cut', 'sm.cameras.mode.cut-tip']
        ];
        const modeButtons = modes.map(([mode, text, tip]) => {
            const b = document.createElement('span');
            b.classList.add('camera-list-mode');
            b.dataset.mode = mode;
            i18n.bindDom(b, text);
            i18n.bindDom(b, tip, 'title');
            b.addEventListener('click', () => events.fire('camera.setViewMode', mode));
            viewMode.dom.appendChild(b);
            return b;
        });
        const syncMode = (value: CameraViewMode) => {
            modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === value));
        };
        events.on('camera.viewMode', syncMode);
        syncMode(events.invoke('camera.viewMode'));

        const viewRow = new Container({ class: 'camera-list-option' });
        viewRow.append(viewLabel);
        viewRow.append(viewMode);

        const gizmoRow = new Container({ class: 'camera-list-option' });
        // camera.showPoses is registered after the ui is built
        const frustums = new BooleanInput({ value: events.functions.has('camera.showPoses') ? events.invoke('camera.showPoses') : true });
        const paths = new BooleanInput({ value: events.invoke('camera.showPaths') });
        frustums.on('change', (value: boolean) => events.fire('camera.setShowPoses', value));
        paths.on('change', (value: boolean) => events.fire('camera.setShowPaths', value));
        events.on('camera.showPoses', (value: boolean) => {
            frustums.value = value;
        });
        events.on('camera.showPaths', (value: boolean) => {
            paths.value = value;
        });
        const frustumLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(frustumLabel, 'sm.cameras.frustums');
        const pathLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(pathLabel, 'sm.cameras.paths');
        i18n.bindDom(frustumLabel.dom, 'sm.cameras.frustums-tip', 'title');
        i18n.bindDom(frustums.dom, 'sm.cameras.frustums-tip', 'title');
        i18n.bindDom(pathLabel.dom, 'sm.cameras.paths-tip', 'title');
        i18n.bindDom(paths.dom, 'sm.cameras.paths-tip', 'title');
        gizmoRow.append(frustumLabel);
        gizmoRow.append(frustums);
        gizmoRow.append(pathLabel);
        gizmoRow.append(paths);

        // viewport path editing (src/tools/camera-path-tool.ts)
        const pathRow = new Container({ class: 'camera-list-option' });
        const pathEdit = document.createElement('span');
        pathEdit.classList.add('camera-list-mode', 'camera-list-path-edit');
        i18n.bindDom(pathEdit, 'sm.cameras.edit-path');
        i18n.bindDom(pathEdit, 'sm.cameras.edit-path-tip', 'title');
        pathEdit.addEventListener('click', () => events.fire('tool.cameraPath'));
        pathRow.dom.appendChild(pathEdit);
        const syncPathEdit = () => pathEdit.classList.toggle('active', events.invoke('tool.active') === 'cameraPath');
        events.on('tool.activated', syncPathEdit);
        events.on('tool.deactivated', syncPathEdit);

        // cross-fade of the cut under the playhead (src/camera-poses.ts
        // CutTrack.setFade), mixed in the cut video export
        const fadeRow = new Container({ class: 'camera-list-option' });
        const fadeLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(fadeLabel, 'sm.cameras.fade');
        const fade = new SliderInput({ min: 0, max: 60, precision: 0, step: 1, value: 0, enabled: false });
        i18n.bindDom(fadeRow.dom, 'sm.cameras.fade-tip', 'title');
        fadeRow.append(fadeLabel);
        fadeRow.append(fade);
        let syncingFade = false;
        const syncFade = () => {
            const cut = events.invoke('cut.track') as CutTrack;
            const segment = cut?.segmentAt(events.invoke('timeline.frame') ?? 0);
            const isCut = !!segment && cut.cutFrom(segment) !== null;
            syncingFade = true;
            fade.enabled = isCut;
            fade.max = isCut ? Math.max(1, Math.min(120, segment.end - segment.start)) : 60;
            fade.value = isCut ? (segment.fade ?? 0) : 0;
            syncingFade = false;
        };
        fade.on('change', (value: number) => {
            if (!syncingFade) events.fire('cut.setFade', events.invoke('timeline.frame'), value);
        });
        events.on('cut.changed', syncFade);
        events.on('timeline.frame', syncFade);
        events.on('shotCameras.changed', syncFade);

        options.append(viewRow);
        options.append(fadeRow);
        options.append(pathRow);
        options.append(gizmoRow);
        body.append(options);

        // properties of the selected camera: transform, lens and depth of
        // field, each with its key button (src/ui/key-button.ts)

        const props = new CollapsibleSection({ key: 'cameras.props', title: 'sm.camera-props.title', icon: '', open: true });
        this.append(props);
        const propBody = new Container({ class: ['camera-list-options', 'camera-props'] });
        props.body.append(propBody);

        const cameraValue = (channel: CameraChannel) => (events.invoke('shotCameras.value', channel) as Vec3 | number | null);
        const keyFor = (channel: CameraChannel) => createKeyButton(
            events,
            () => (events.invoke('shotCameras.selected') ? events.invoke('shotCameras.channelState', channel) as KeyState : null),
            () => events.fire('shotCameras.keyChannel', channel)
        );
        // inputs being edited are not overwritten by a refresh
        const editing = (el: HTMLElement) => el.contains(document.activeElement);

        const propRow = (text: string, tip: string) => {
            const row = new Container({ class: ['camera-list-option', 'camera-prop-row'] });
            const label = new Label({ class: 'camera-list-label' });
            i18n.bindText(label, text);
            i18n.bindDom(label.dom, tip, 'title');
            row.append(label);
            propBody.append(row);
            return row;
        };

        let syncing = false;

        // projection: what this camera renders in exports - a lens image, a
        // 360 panorama, or a stereo 360 for VR headsets
        const projRow = propRow('sm.camera-props.projection', 'sm.camera-props.projection-tip');
        const projModes = new Container({ class: 'camera-list-viewmode' });
        const projButtons = ([
            ['standard', 'sm.camera-props.proj.standard'],
            ['equirect', 'sm.camera-props.proj.equirect'],
            ['stereo', 'sm.camera-props.proj.stereo']
        ] as [CameraProjection, string][]).map(([mode, text]) => {
            const b = document.createElement('span');
            b.classList.add('camera-list-mode');
            b.dataset.mode = mode;
            i18n.bindDom(b, text);
            b.addEventListener('click', () => {
                events.fire('shotCameras.setProjection', mode);
                // switching to a panorama shows it: look through the camera
                // (the viewport then previews the equirect)
                if (mode !== 'standard' && events.invoke('camera.viewMode') === 'free') {
                    events.fire('camera.setViewMode', 'camera');
                }
            });
            projModes.dom.appendChild(b);
            return b;
        });
        projRow.append(projModes);

        // stereo eye separation
        const ipdRow = propRow('sm.camera-props.ipd', 'sm.camera-props.ipd-tip');
        const ipdInput = new NumericInput({ min: 0.001, max: 10, precision: 3, step: 0.005, value: 0.064, class: 'camera-prop-mm' });
        const ipdLabel = new Label({ class: 'camera-list-label', text: 'm' });
        ipdRow.append(ipdInput);
        ipdRow.append(ipdLabel);
        ipdInput.on('change', (v: number) => {
            if (!syncing) events.fire('shotCameras.setIpd', v);
        });

        // position: moving the camera keeps where it looks (the target moves
        // along)
        const posRow = propRow('sm.channel.position', 'sm.camera-props.position-tip');
        const posInput = new VectorInput({ dimensions: 3, precision: 3, placeholder: ['X', 'Y', 'Z'], value: [0, 0, 0], class: 'camera-prop-input' });
        posRow.append(posInput);
        posRow.dom.appendChild(keyFor('position').dom);
        posInput.on('change', (value: number[]) => {
            if (syncing) return;
            const p = cameraValue('position') as Vec3 | null;
            const t = cameraValue('target') as Vec3 | null;
            const np = new Vec3(value[0], value[1], value[2]);
            events.fire('shotCameras.setValue', 'position', np);
            if (p && t) events.fire('shotCameras.setValue', 'target', t.clone().add(np.clone().sub(p)));
        });

        // rotation: tilt and pan, computed from the look-at target
        const rotRow = propRow('sm.channel.rotation', 'sm.camera-props.rotation-tip');
        const rotInput = new VectorInput({ dimensions: 2, precision: 1, placeholder: [i18n.t('sm.camera-props.tilt'), i18n.t('sm.camera-props.pan')], value: [0, 0], class: 'camera-prop-input' });
        rotRow.append(rotInput);
        rotRow.dom.appendChild(keyFor('target').dom);
        const toRotation = (p: Vec3, t: Vec3) => {
            const d = t.clone().sub(p);
            const len = Math.max(1e-6, d.length());
            // pan 0 looks down -z, positive turns left (the editor convention)
            return [Math.asin(Math.max(-1, Math.min(1, d.y / len))) * 180 / Math.PI, Math.atan2(-d.x, -d.z) * 180 / Math.PI];
        };
        rotInput.on('change', (value: number[]) => {
            if (syncing) return;
            const p = cameraValue('position') as Vec3 | null;
            const t = cameraValue('target') as Vec3 | null;
            if (!p || !t) return;
            const len = Math.max(0.01, t.distance(p));
            const tilt = value[0] * Math.PI / 180;
            const pan = value[1] * Math.PI / 180;
            const dir = new Vec3(-Math.sin(pan) * Math.cos(tilt), Math.sin(tilt), -Math.cos(pan) * Math.cos(tilt));
            events.fire('shotCameras.setValue', 'target', p.clone().add(dir.mulScalar(len)));
        });

        // target: the look-at point itself, keyed on the target channel
        const targetRow = propRow('sm.camera-props.target', 'sm.camera-props.target-tip');
        const targetInput = new VectorInput({ dimensions: 3, precision: 3, placeholder: ['X', 'Y', 'Z'], value: [0, 0, 0], class: 'camera-prop-input' });
        targetRow.append(targetInput);
        targetRow.dom.appendChild(keyFor('target').dom);
        targetInput.on('change', (value: number[]) => {
            if (syncing) return;
            events.fire('shotCameras.setValue', 'target', new Vec3(value[0], value[1], value[2]));
        });

        // lens: focal length (full frame equivalent, on the image's long
        // side) and the field of view it gives
        const lensRow = propRow('sm.channel.lens', 'sm.camera-props.lens-tip');
        const mmInput = new NumericInput({ min: 4, max: 1200, precision: 1, step: 1, value: 35, class: 'camera-prop-mm' });
        const mmLabel = new Label({ class: 'camera-list-label', text: 'mm' });
        const fovInput = new NumericInput({ min: 2, max: 150, precision: 1, step: 1, value: 60, class: 'camera-prop-fov' });
        const fovLabel = new Label({ class: 'camera-list-label', text: '°' });
        i18n.bindDom(fovInput.dom, 'sm.camera-props.fov-tip', 'title');
        lensRow.append(mmInput);
        lensRow.append(mmLabel);
        lensRow.append(fovInput);
        lensRow.append(fovLabel);
        lensRow.dom.appendChild(keyFor('fov').dom);
        const mmFromFov = (fov: number) => 18 / Math.tan(fov * Math.PI / 360);
        const fovFromMm = (mm: number) => 360 / Math.PI * Math.atan(18 / mm);
        mmInput.on('change', (mm: number) => {
            if (!syncing && mm > 0) events.fire('shotCameras.setValue', 'fov', fovFromMm(mm));
        });
        fovInput.on('change', (fov: number) => {
            if (!syncing && fov > 0) events.fire('shotCameras.setValue', 'fov', fov);
        });

        // lens presets
        const presetRow = new Container({ class: ['camera-list-option', 'camera-lens-presets'] });
        [14, 24, 35, 50, 85, 135].forEach((mm) => {
            const b = document.createElement('span');
            b.classList.add('camera-list-mode');
            b.textContent = `${mm}`;
            b.title = `${mm} mm`;
            b.addEventListener('click', () => events.fire('shotCameras.setValue', 'fov', fovFromMm(mm)));
            presetRow.dom.appendChild(b);
        });
        propBody.append(presetRow);

        // put the camera where the viewport looks
        const viewRowBtn = new Container({ class: 'camera-list-option' });
        const toView = document.createElement('span');
        toView.classList.add('camera-list-mode');
        i18n.bindDom(toView, 'sm.camera-props.to-view');
        i18n.bindDom(toView, 'sm.camera-props.to-view-tip', 'title');
        toView.addEventListener('click', () => events.fire('shotCameras.setToView'));
        viewRowBtn.dom.appendChild(toView);
        propBody.append(viewRowBtn);

        // depth of field: on / off and blur cap are global, focus and
        // aperture belong to the camera

        const dofHead = new Container({ class: 'camera-list-option' });
        const dofOnLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(dofOnLabel, 'sm.dof.title');
        const dofEnabled = new BooleanInput({ value: false });
        i18n.bindDom(dofOnLabel.dom, 'sm.dof.enabled-tip', 'title');
        i18n.bindDom(dofEnabled.dom, 'sm.dof.enabled-tip', 'title');
        dofEnabled.on('change', (value: boolean) => {
            if (!syncing) events.fire('dof.set', { enabled: value });
        });
        const dofPick = document.createElement('span');
        dofPick.classList.add('camera-list-mode');
        i18n.bindDom(dofPick, 'sm.dof.pick');
        i18n.bindDom(dofPick, 'sm.dof.pick-tip', 'title');
        dofPick.addEventListener('click', () => events.fire('dof.pickFocus'));
        dofHead.append(dofOnLabel);
        dofHead.append(dofEnabled);
        dofHead.dom.appendChild(dofPick);
        propBody.append(dofHead);

        const slider = (text: string, tip: string, min: number, max: number, precision: number, onChange: (v: number) => void, channel?: CameraChannel) => {
            const row = propRow(text, tip);
            const input = new SliderInput({ min, max, precision, value: min, flexGrow: '1' });
            input.on('change', (value: number) => {
                if (!syncing) onChange(value);
            });
            row.append(input);
            if (channel) row.dom.appendChild(keyFor(channel).dom);
            return input;
        };
        const focusInput = slider('sm.dof.focus', 'sm.dof.focus-tip', 0.1, 50, 2, v => events.fire('shotCameras.setValue', 'focus', v), 'focus');
        const apertureInput = slider('sm.dof.aperture', 'sm.dof.aperture-tip', 0, 0.5, 3, v => events.fire('shotCameras.setValue', 'aperture', v), 'aperture');
        const maxBlurInput = slider('sm.dof.max-blur', 'sm.dof.max-blur-tip', 2, 64, 0, v => events.fire('dof.set', { maxBlur: v }));

        // gait bob and handheld shake (src/camera-modifier.ts): procedural,
        // on top of the keyed path, every value keyable. The bob height is
        // shown in cm when the scene scale is known, else in scene units
        const scale = (): SceneScale => (events.functions.has('sceneScale.get') ? events.invoke('sceneScale.get') : { mode: 'auto', metersPerUnit: 1, known: false, source: 'unknown' });
        const bobFactor = () => (scale().known ? 100 * scale().metersPerUnit : 1);
        const gaitHead = new Container({ class: ['camera-list-option', 'camera-gait-head'] });
        const gaitLabel = new Label({ class: 'camera-list-label' });
        i18n.bindText(gaitLabel, 'sm.gait.title');
        i18n.bindDom(gaitLabel.dom, 'sm.gait.title-tip', 'title');
        gaitHead.append(gaitLabel);
        propBody.append(gaitHead);
        const bobInput = slider('sm.gait.bob', 'sm.gait.bob-tip', 0, 15, 1, v => events.fire('shotCameras.setValue', 'bob', Math.max(0, v) / bobFactor()), 'bob');
        const bobUnit = new Label({ class: ['camera-list-label', 'camera-gait-unit'] });
        bobInput.parent?.dom.insertBefore(bobUnit.dom, bobInput.dom.nextSibling);
        const stepInput = slider('sm.gait.step-rate', 'sm.gait.step-rate-tip', 0.5, 3.5, 2, v => events.fire('shotCameras.setValue', 'stepRate', v), 'stepRate');
        const shakeInput = slider('sm.gait.shake', 'sm.gait.shake-tip', 0, 3, 2, v => events.fire('shotCameras.setValue', 'shake', v), 'shake');
        const shakeRateInput = slider('sm.gait.shake-rate', 'sm.gait.shake-rate-tip', 0.1, 4, 2, v => events.fire('shotCameras.setValue', 'shakeRate', v), 'shakeRate');
        const syncGaitUnit = () => {
            const known = scale().known;
            bobUnit.text = known ? 'cm' : i18n.t('sm.scale.unit-short');
            // in scene units the same slider covers 0..0.15
            bobInput.max = known ? 15 : 0.15;
            bobInput.sliderMax = known ? 15 : 0.15;
            bobInput.precision = known ? 1 : 3;
        };

        const syncProps = () => {
            const camera = events.invoke('shotCameras.selected') as ShotCamera;
            props.setInfo(camera?.name ?? '');
            if (!camera) return;
            syncing = true;
            const p = cameraValue('position') as Vec3 | null;
            const t = cameraValue('target') as Vec3 | null;
            posInput.enabled = rotInput.enabled = targetInput.enabled = !!p;
            if (p && !editing(posInput.dom)) posInput.value = [p.x, p.y, p.z];
            if (t && !editing(targetInput.dom)) targetInput.value = [t.x, t.y, t.z];
            if (p && t && !editing(rotInput.dom)) rotInput.value = toRotation(p, t);
            projButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === camera.projection));
            const is360 = camera.projection !== 'standard';
            // a panorama sees all around: the lens does not apply
            lensRow.hidden = is360;
            presetRow.hidden = is360;
            ipdRow.hidden = camera.projection !== 'stereo';
            if (!editing(ipdInput.dom)) ipdInput.value = camera.ipd;
            const fov = cameraValue('fov') as number;
            if (!editing(fovInput.dom)) fovInput.value = fov;
            if (!editing(mmInput.dom)) mmInput.value = mmFromFov(fov);
            if (!editing(focusInput.dom)) focusInput.value = cameraValue('focus') as number;
            if (!editing(apertureInput.dom)) apertureInput.value = cameraValue('aperture') as number;
            syncGaitUnit();
            if (!editing(bobInput.dom)) bobInput.value = (cameraValue('bob') as number ?? 0) * bobFactor();
            if (!editing(stepInput.dom)) stepInput.value = cameraValue('stepRate') as number;
            if (!editing(shakeInput.dom)) shakeInput.value = cameraValue('shake') as number;
            if (!editing(shakeRateInput.dom)) shakeRateInput.value = cameraValue('shakeRate') as number;
            syncing = false;
        };
        let syncQueued = false;
        const queueSync = () => {
            if (syncQueued) return;
            syncQueued = true;
            queueMicrotask(() => {
                syncQueued = false;
                syncProps();
            });
        };
        ['shotCameras.changed', 'camera.valuesChanged', 'timeline.frame', 'track.changed', 'track.keysLoaded', 'sceneScale.changed'].forEach(name => events.on(name, queueSync));
        i18n.onChange(queueSync);
        queueSync();

        events.on('dof.changed', (state: { enabled: boolean, focus: number, aperture: number, maxBlur: number }) => {
            syncing = true;
            dofEnabled.value = state.enabled;
            maxBlurInput.value = state.maxBlur;
            syncing = false;
        });
        events.on('dof.picking', (value: boolean) => dofPick.classList.toggle('active', value));

        events.on('shotCameras.changed', rebuild);
        events.on('transform.target', rebuild);
        events.on('track.keyAdded', rebuild);
        events.on('track.keyRemoved', rebuild);
        events.on('track.keysLoaded', rebuild);
        events.on('track.keysCleared', rebuild);
        // rows are translated at build time: rebuild on a language switch
        i18n.onChange(rebuild);
    }
}

export { CameraList };
