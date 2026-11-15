import { Button, Container, ContainerArgs, Label, NumericInput, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { createKeyButton, KeyState } from './key-button';
import { i18n } from './localization';
import { Pivot } from '../pivot';

const v = new Vec3();

class Transform extends Container {
    constructor(events: Events, args: ContainerArgs = {}) {
        args = {
            ...args,
            id: 'transform'
        };

        super(args);

        // position
        const position = new Container({
            class: 'transform-row'
        });

        const positionLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(positionLabel, 'panel.scene.transform.position');

        const positionVector = new VectorInput({
            class: 'transform-expand',
            precision: 3,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        position.append(positionLabel);
        position.append(positionVector);

        // rotation
        const rotation = new Container({
            class: 'transform-row'
        });

        const rotationLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(rotationLabel, 'panel.scene.transform.rotation');

        const rotationVector = new VectorInput({
            class: 'transform-expand',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            enabled: false
        });

        rotation.append(rotationLabel);
        rotation.append(rotationVector);

        // scale
        const scale = new Container({
            class: 'transform-row'
        });

        const scaleLabel = new Label({
            class: 'transform-label'
        });
        i18n.bindText(scaleLabel, 'panel.scene.transform.scale');

        const scaleInput = new NumericInput({
            class: ['transform-expand', 'transform-scale'],
            precision: 3,
            value: 1,
            min: 0.001,
            max: 10000,
            enabled: false
        });

        scale.append(scaleLabel);
        scale.append(scaleInput);

        // XGrids preset: XGrids scans come in Z-up, this stands them upright
        // (the values typed into the panel: position 0, rotation -90 0 0,
        // scale 1). One undo step, like any panel edit
        const presetRow = new Container({ class: ['transform-row', 'transform-preset-row'] });
        const presetLabel = new Label({ class: 'transform-label' });
        const xgrids = new Button({ text: 'XGRIDS default', class: 'transform-preset', enabled: false });
        i18n.bindDom(xgrids.dom, 'sm.transform.xgrids-tip', 'title');
        xgrids.on('click', () => {
            const pivot = events.invoke('pivot') as Pivot;
            if (!pivot || !(events.functions.has('selection') && events.invoke('selection'))) return;
            const q = new Quat().setFromEulerAngles(-90, 0, 0);
            pivot.start();
            pivot.moveTRS(new Vec3(0, 0, 0), q, new Vec3(1, 1, 1));
            pivot.end();
        });
        presetRow.append(presetLabel);
        presetRow.append(xgrids);

        this.append(position);
        this.append(rotation);
        this.append(presetRow);
        this.append(scale);

        // key buttons: key just this property of the selected splat
        const selected = () => (events.functions.has('selection') ? events.invoke('selection') : null);
        const keyButton = (channel: string) => createKeyButton(
            events,
            () => (selected() ? events.invoke('layerAnim.channelState', selected(), channel) as KeyState : null),
            () => selected() && events.fire('layerAnim.keyChannel', selected(), channel)
        ).dom;
        position.dom.appendChild(keyButton('position'));
        rotation.dom.appendChild(keyButton('rotation'));
        scale.dom.appendChild(keyButton('scale'));

        const toArray = (v: Vec3) => {
            return [v.x, v.y, v.z];
        };

        let uiUpdating = false;
        let mouseUpdating = false;

        // the panel shows the pivot in world coordinates. with a user-defined
        // local frame set (see Splat.getPivot), the pivot is that frame, so
        // zeroing the values aligns the frame with the world origin and axes
        const updateUI = (pivot: Pivot) => {
            uiUpdating = true;
            const transform = pivot.transform;
            transform.rotation.getEulerAngles(v);
            positionVector.value = toArray(transform.position);
            rotationVector.value = toArray(v);
            scaleInput.value = transform.scale.x;
            uiUpdating = false;
        };

        // update pivot with UI
        const updatePivot = (pivot: Pivot) => {
            const p = positionVector.value;
            const r = rotationVector.value;
            const q = new Quat().setFromEulerAngles(r[0], r[1], r[2]);
            const s = scaleInput.value;

            if (q.w < 0) {
                q.mulScalar(-1);
            }

            pivot.moveTRS(new Vec3(p[0], p[1], p[2]), q, new Vec3(s, s, s));
        };

        // handle a change in the UI state
        const change = () => {
            if (!uiUpdating) {
                const pivot = events.invoke('pivot') as Pivot;
                if (mouseUpdating) {
                    updatePivot(pivot);
                } else {
                    pivot.start();
                    updatePivot(pivot);
                    pivot.end();
                }
            }
        };

        const mousedown = () => {
            mouseUpdating = true;
            const pivot = events.invoke('pivot') as Pivot;
            pivot.start();
        };

        const mouseup = () => {
            const pivot = events.invoke('pivot') as Pivot;
            updatePivot(pivot);
            mouseUpdating = false;
            pivot.end();
        };

        [positionVector.inputs, rotationVector.inputs, scaleInput].flat().forEach((input) => {
            input.on('change', change);
            input.on('slider:mousedown', mousedown);
            input.on('slider:mouseup', mouseup);
        });

        // toggle ui availability based on selection
        events.on('selection.changed', (selection) => {
            positionVector.enabled = rotationVector.enabled = scaleInput.enabled = xgrids.enabled = !!selection;
        });

        events.on('pivot.placed', (pivot: Pivot) => {
            updateUI(pivot);
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (!mouseUpdating) {
                updateUI(pivot);
            }
        });

        events.on('pivot.ended', (pivot: Pivot) => {
            updateUI(pivot);
        });
    }
}

export { Transform };
