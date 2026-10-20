import { BooleanInput, Container, Label, SliderInput } from '@playcanvas/pcui';

import type { CameraViewMode, ShotCamera } from '../camera-poses';
import { Events } from '../events';

const rgb = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

// shot camera list for the scene panel: add, duplicate, rename, delete and
// select cameras, and choose what the viewport follows on the timeline
class CameraList extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'camera-list'
        };

        super(args);

        // header: title + add / duplicate buttons

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ text: '', class: 'panel-header-icon' });
        const title = new Label({ text: 'KAMERAS', class: 'panel-header-label' });

        const button = (text: string, tip: string, onClick: () => void) => {
            const b = new Label({ text, class: ['panel-header-button', 'camera-list-button'] });
            b.dom.title = tip;
            b.dom.addEventListener('click', onClick);
            return b;
        };

        header.append(icon);
        header.append(title);
        header.append(button('+', 'Kamera hinzufügen', () => events.fire('shotCameras.add')));
        header.append(button('⧉', 'Gewählte Kamera duplizieren', () => events.fire('shotCameras.duplicate')));
        this.append(header);

        // rows

        const rows = new Container({ class: 'camera-list-rows' });
        this.append(rows);

        const rebuild = () => {
            rows.dom.innerHTML = '';
            const cameras = events.invoke('shotCameras.list') as ShotCamera[];
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
                name.title = 'Doppelklick: umbenennen';

                const keys = document.createElement('span');
                keys.classList.add('camera-list-keys');
                keys.textContent = `${camera.track.keys.length} Keys`;

                const remove = document.createElement('span');
                remove.classList.add('camera-list-remove');
                remove.textContent = '✕';
                remove.title = 'Kamera löschen';

                row.append(swatch, name, keys, remove);
                rows.dom.appendChild(row);

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

        const viewLabel = new Label({ text: 'Viewport', class: 'camera-list-label' });
        // segmented buttons rather than a dropdown: the scene panel scrolls
        // and would clip a dropdown list
        const viewMode = new Container({ class: 'camera-list-viewmode' });
        const modes: [CameraViewMode, string, string][] = [
            ['free', 'Frei', 'Freie Editor-Kamera: die Timeline bewegt den Viewport nicht'],
            ['camera', 'Durchschauen', 'Viewport schaut durch die gewählte Kamera (K)'],
            ['cut', 'Schnitt', 'Viewport folgt der Schnittspur']
        ];
        const modeButtons = modes.map(([mode, text, tip]) => {
            const b = document.createElement('span');
            b.classList.add('camera-list-mode');
            b.dataset.mode = mode;
            b.textContent = text;
            b.title = tip;
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
        gizmoRow.append(new Label({ text: 'Frustums', class: 'camera-list-label' }));
        gizmoRow.append(frustums);
        gizmoRow.append(new Label({ text: 'Pfade', class: 'camera-list-label' }));
        gizmoRow.append(paths);

        options.append(viewRow);
        options.append(gizmoRow);
        this.append(options);

        // depth of field (src/dof/dof.ts), registered after the ui: the
        // controls start at defaults and sync on dof.changed

        const dof = new Container({ class: 'camera-list-options' });
        let syncing = false;
        const dofHead = new Container({ class: 'camera-list-option' });
        const dofEnabled = new BooleanInput({ value: false });
        dofEnabled.on('change', (value: boolean) => {
            if (!syncing) events.fire('dof.set', { enabled: value });
        });
        const dofPick = document.createElement('span');
        dofPick.classList.add('camera-list-mode');
        dofPick.textContent = 'Pipette';
        dofPick.title = 'Klick in den Viewport stellt auf die Fläche darunter scharf';
        dofPick.addEventListener('click', () => events.fire('dof.pickFocus'));
        const dofKey = document.createElement('span');
        dofKey.classList.add('camera-list-mode');
        dofKey.textContent = '◆ Key';
        dofKey.title = 'Fokus und Blende am aktuellen Frame keyen (Fokus-Spur in der Timeline)';
        dofKey.addEventListener('click', () => {
            events.fire('dof.addKey');
            events.fire('dof.selectTrack');
        });
        dofHead.append(new Label({ text: 'Tiefenschärfe', class: 'camera-list-label' }));
        dofHead.append(dofEnabled);
        dofHead.dom.appendChild(dofPick);
        dofHead.dom.appendChild(dofKey);

        const slider = (text: string, tip: string, min: number, max: number, precision: number, key: 'focus' | 'aperture' | 'maxBlur') => {
            const row = new Container({ class: 'camera-list-option' });
            const label = new Label({ text, class: 'camera-list-label' });
            label.dom.title = tip;
            const input = new SliderInput({ min, max, precision, value: min, flexGrow: '1' });
            input.on('change', (value: number) => {
                if (!syncing) events.fire('dof.set', { [key]: value });
            });
            row.append(label);
            row.append(input);
            dof.append(row);
            return input;
        };
        dof.append(dofHead);
        const focusInput = slider('Fokus', 'Entfernung der Schärfeebene zur Kamera', 0.1, 50, 2, 'focus');
        const apertureInput = slider('Blende', 'Linsenradius: größer = geringere Tiefenschärfe', 0, 0.5, 3, 'aperture');
        const maxBlurInput = slider('Max. px', 'Obergrenze der Unschärfe in Pixeln', 2, 64, 0, 'maxBlur');
        this.append(dof);

        events.on('dof.changed', (state: { enabled: boolean, focus: number, aperture: number, maxBlur: number }) => {
            syncing = true;
            dofEnabled.value = state.enabled;
            focusInput.value = state.focus;
            apertureInput.value = state.aperture;
            maxBlurInput.value = state.maxBlur;
            syncing = false;
        });
        events.on('dof.picking', (value: boolean) => dofPick.classList.toggle('active', value));

        events.on('shotCameras.changed', rebuild);
        events.on('track.keyAdded', rebuild);
        events.on('track.keyRemoved', rebuild);
        events.on('track.keysLoaded', rebuild);
        events.on('track.keysCleared', rebuild);
        rebuild();
    }
}

export { CameraList };
