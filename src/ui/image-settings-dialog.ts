import { BooleanInput, Button, Container, Element, Label, NumericInput, SelectInput, SliderInput, VectorInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { ImageSettings } from '../render';
import { i18n } from './localization';
import sceneExport from './svg/export.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

class ImageSettingsDialog extends Container {
    show: () => Promise<ImageSettings | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'image-settings-dialog',
            class: ['settings-dialog', 'blocks-shortcuts'],
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({
            id: 'dialog'
        });

        // header

        const headerIcon = createSvg(sceneExport, { id: 'icon' });
        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, () => i18n.t('popup.render-image.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerIcon);
        header.append(headerText);

        // projection

        const projectionLabel = new Label({ class: 'label' });
        i18n.bindText(projectionLabel, 'popup.render-image.projection');
        const projectionSelect = new SelectInput({
            class: 'select',
            defaultValue: 'standard'
        });
        i18n.bindOptions(projectionSelect, () => [
            { v: 'standard', t: i18n.t('popup.render-image.projection.standard') },
            { v: 'equirect', t: i18n.t('popup.render-image.projection.equirectangular') },
            { v: 'stereo', t: i18n.t('sm.stereo.projection') }
        ]);
        const projectionRow = new Container({ class: 'row' });
        projectionRow.append(projectionLabel);
        projectionRow.append(projectionSelect);

        // preset

        // 360 output is 2:1 equirectangular (mirrors video's presets)
        const buildPresetOptions = () => {
            // stereo 360: top-bottom, each eye 2:1, so the frame is square
            if (projectionSelect.value === 'stereo') {
                return [
                    { v: 'tb-2048', t: '2048x2048' },
                    { v: 'tb-4096', t: '4096x4096' },
                    { v: 'tb-5760', t: '5760x5760' },
                    { v: 'tb-8192', t: '8192x8192' },
                    { v: 'custom', t: i18n.t('popup.render-image.resolution.custom') }
                ];
            }
            return projectionSelect.value === 'equirect' ? [
                { v: '360-1k', t: '1024x512' },
                { v: '360-2k', t: '2048x1024' },
                { v: '360-4k', t: '3840x1920' },
                { v: '360-4096', t: '4096x2048' },
                { v: '360-8k', t: '7680x3840' },
                { v: '360-8192', t: '8192x4096' },
                { v: 'custom', t: i18n.t('popup.render-image.resolution.custom') }
            ] : [
                { v: 'viewport', t: i18n.t('popup.render-image.resolution.current') },
                { v: 'HD', t: 'HD' },
                { v: 'QHD', t: 'QHD' },
                { v: '4K', t: '4K' },
                { v: 'custom', t: i18n.t('popup.render-image.resolution.custom') }
            ];
        };

        const presetLabel = new Label({ class: 'label' });
        i18n.bindText(presetLabel, 'popup.render-image.preset');
        const presetSelect = new SelectInput({
            class: 'select',
            defaultValue: 'viewport'
        });
        i18n.bindOptions(presetSelect, buildPresetOptions);
        const presetRow = new Container({ class: 'row' });
        presetRow.append(presetLabel);
        presetRow.append(presetSelect);

        // resolution

        const resolutionLabel = new Label({ class: 'label' });
        i18n.bindText(resolutionLabel, 'popup.render-image.resolution');
        const resolutionValue = new VectorInput({
            class: 'vector-input',
            dimensions: 2,
            min: 4,
            max: 16000,
            precision: 0,
            value: [1024, 768]
        });
        const resolutionRow = new Container({ class: 'row', enabled: false });
        resolutionRow.append(resolutionLabel);
        resolutionRow.append(resolutionValue);

        // format

        const formatLabel = new Label({ class: 'label' });
        i18n.bindText(formatLabel, 'popup.render-image.format');
        const formatSelect = new SelectInput({
            class: 'select',
            defaultValue: 'png',
            options: [
                { v: 'png', t: 'PNG' },
                { v: 'jpeg', t: 'JPEG' },
                { v: 'webp', t: 'WebP' },
                { v: 'exr', t: 'EXR' }
            ]
        });
        const formatRow = new Container({ class: 'row' });
        formatRow.append(formatLabel);
        formatRow.append(formatSelect);

        // jpeg quality

        const qualityLabel = new Label({ class: 'label' });
        i18n.bindText(qualityLabel, 'popup.render-image.quality');
        const qualitySlider = new SliderInput({
            class: 'slider',
            min: 1,
            max: 100,
            precision: 0,
            value: 90
        });
        const qualityRow = new Container({ class: 'row' });
        qualityRow.append(qualityLabel);
        qualityRow.append(qualitySlider);

        // hidden until jpeg is selected
        qualityRow.hidden = true;

        // level horizon (360 only)

        const levelHorizonLabel = new Label({ class: 'label' });
        i18n.bindText(levelHorizonLabel, 'popup.render-image.level-horizon');
        const levelHorizonBoolean = new BooleanInput({ class: 'boolean', value: true });
        const levelHorizonRow = new Container({ class: 'row' });
        levelHorizonRow.append(levelHorizonLabel);
        levelHorizonRow.append(levelHorizonBoolean);

        // hidden until 360 projection is selected
        levelHorizonRow.hidden = true;

        // stereo 360 (omnidirectional stereo, src/ods-renderer.ts)

        const row = (text: string, input: Element, title?: string) => {
            const r = new Container({ class: 'row' });
            if (title) i18n.bindDom(r.dom, title, 'title');
            const label = new Label({ class: 'label' });
            i18n.bindText(label, text);
            r.append(label);
            r.append(input);
            return r;
        };

        const ipdInput = new NumericInput({ class: 'numeric-input', min: 0, max: 1000, precision: 4, step: 0.001, value: 0.064 });
        const ipdRow = row('sm.stereo.ipd', ipdInput, 'sm.stereo.ipd-tip');
        const poleSlider = new SliderInput({ class: 'slider', min: 20, max: 69, precision: 0, value: 50 });
        const poleRow = row('sm.stereo.pole', poleSlider, 'sm.stereo.pole-tip');
        const segmentSelect = new SelectInput({
            class: 'select',
            defaultValue: '112'
        });
        i18n.bindOptions(segmentSelect, () => [
            { v: '48', t: i18n.t('sm.stereo.q48') },
            { v: '96', t: i18n.t('sm.stereo.q96') },
            { v: '112', t: i18n.t('sm.stereo.q112') },
            { v: '160', t: i18n.t('sm.stereo.q160') }
        ]);
        const segmentRow = row('sm.stereo.quality', segmentSelect, 'sm.stereo.quality-tip');
        [ipdRow, poleRow, segmentRow].forEach((r) => {
            r.hidden = true;
        });

        // panorama source (360 only): the current view or the shot cameras

        const sourceSelect = new SelectInput({
            class: 'select',
            defaultValue: 'view'
        });
        i18n.bindOptions(sourceSelect, () => [
            { v: 'view', t: i18n.t('sm.pano.view') },
            { v: 'camera', t: i18n.t('sm.pano.camera') },
            { v: 'cameraKeys', t: i18n.t('sm.pano.camera-keys') },
            { v: 'allCameras', t: i18n.t('sm.pano.all-cameras') },
            { v: 'allCameraKeys', t: i18n.t('sm.pano.all-camera-keys') }
        ]);
        const sourceRow = row('sm.pano.source', sourceSelect, 'sm.pano.source-tip');
        const cameraSelect = new SelectInput({ class: 'select' });
        const cameraRow = row('sm.cameras.camera', cameraSelect);
        const northBoolean = new BooleanInput({ class: 'boolean', value: false });
        const northRow = row('sm.pano.north', northBoolean, 'sm.pano.north-tip');
        [sourceRow, cameraRow, northRow].forEach((r) => {
            r.hidden = true;
        });

        const syncSource = () => {
            const is360 = projectionSelect.value !== 'standard';
            const fromCamera = sourceSelect.value !== 'view';
            sourceRow.hidden = !is360;
            cameraRow.hidden = !is360 || !['camera', 'cameraKeys'].includes(sourceSelect.value);
            northRow.hidden = !is360 || !fromCamera;
            // camera panoramas always keep the horizon level
            levelHorizonRow.hidden = !is360 || fromCamera;
        };
        sourceSelect.on('change', syncSource);

        // picking a panorama camera takes over its projection and stereo
        // eye separation
        const applyCameraProjection = () => {
            if (!['camera', 'cameraKeys'].includes(sourceSelect.value)) return;
            const cameras = (events.invoke('shotCameras.list') ?? []) as { id: number, projection: string, ipd: number }[];
            const camera = cameras.find(c => String(c.id) === cameraSelect.value);
            if (!camera || camera.projection === 'standard') return;
            if (projectionSelect.value !== camera.projection) projectionSelect.value = camera.projection;
            if (camera.projection === 'stereo') ipdInput.value = camera.ipd;
        };
        cameraSelect.on('change', applyCameraProjection);

        // transparent background

        const transparentBgLabel = new Label({ class: 'label' });
        i18n.bindText(transparentBgLabel, 'popup.render-image.transparent-background');
        const transparentBgBoolean = new BooleanInput({ class: 'boolean', value: false });
        const transparentBgRow = new Container({ class: 'row' });
        transparentBgRow.append(transparentBgLabel);
        transparentBgRow.append(transparentBgBoolean);

        // show debug overlays

        const showDebugLabel = new Label({ class: 'label' });
        i18n.bindText(showDebugLabel, 'popup.render-image.show-debug-overlays');
        const showDebugBoolean = new BooleanInput({ class: 'boolean', value: false });
        const showDebugRow = new Container({ class: 'row' });
        showDebugRow.append(showDebugLabel);
        showDebugRow.append(showDebugBoolean);

        // exr: camera depth as a Z channel (standard projection)
        const depthLabel = new Label({ class: 'label' });
        i18n.bindText(depthLabel, 'sm.video.depth');
        const depthBoolean = new BooleanInput({ class: 'boolean', value: true });
        const depthRow = new Container({ class: 'row' });
        i18n.bindDom(depthRow.dom, 'sm.image.depth-tip', 'title');
        depthRow.append(depthLabel);
        depthRow.append(depthBoolean);
        depthRow.hidden = true;
        const syncDepth = () => {
            depthRow.hidden = !(formatSelect.value === 'exr' && projectionSelect.value === 'standard');
        };

        // content

        const content = new Container({ id: 'content' });
        content.append(projectionRow);
        content.append(presetRow);
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(qualityRow);
        content.append(transparentBgRow);
        content.append(depthRow);
        content.append(showDebugRow);
        content.append(levelHorizonRow);
        content.append(ipdRow);
        content.append(poleRow);
        content.append(segmentRow);
        content.append(sourceRow);
        content.append(cameraRow);
        content.append(northRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button'
        });
        i18n.bindText(cancelButton, 'panel.render.cancel');

        const okButton = new Button({
            class: 'button'
        });
        i18n.bindText(okButton, 'panel.render.ok');

        footer.append(cancelButton);
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        let targetSize: { width: number, height: number };

        // Handle custom resolution activation

        const updateResolution = () => {
            const widths: Record<string, number> = {
                'viewport': targetSize.width,
                'HD': 1920,
                'QHD': 2560,
                '4K': 3840,
                '360-1k': 1024,
                '360-2k': 2048,
                '360-4k': 3840,
                '360-4096': 4096,
                '360-8k': 7680,
                '360-8192': 8192,
                'tb-2048': 2048,
                'tb-4096': 4096,
                'tb-5760': 5760,
                'tb-8192': 8192
            };

            const heights: Record<string, number> = {
                'viewport': targetSize.height,
                'HD': 1080,
                'QHD': 1440,
                '4K': 2160,
                '360-1k': 512,
                '360-2k': 1024,
                '360-4k': 1920,
                '360-4096': 2048,
                '360-8k': 3840,
                '360-8192': 4096,
                'tb-2048': 2048,
                'tb-4096': 4096,
                'tb-5760': 5760,
                'tb-8192': 8192
            };

            resolutionValue.value = [
                widths[presetSelect.value] ?? resolutionValue.value[0],
                heights[presetSelect.value] ?? resolutionValue.value[1]
            ];
        };

        presetSelect.on('change', () => {
            resolutionRow.enabled = presetSelect.value === 'custom';

            if (presetSelect.value !== 'custom') {
                updateResolution();
            }
        });

        // sync the ui to the selected projection: 360 renders are 2:1
        // equirectangular without debug overlays, and gain a level horizon toggle
        const syncProjection = () => {
            const isStereo = projectionSelect.value === 'stereo';
            const is360 = projectionSelect.value === 'equirect' || isStereo;
            presetSelect.options = buildPresetOptions();
            presetSelect.value = isStereo ? 'tb-4096' : (is360 ? '360-4k' : 'viewport');
            resolutionRow.enabled = presetSelect.value === 'custom';
            updateResolution();
            showDebugRow.hidden = is360;
            levelHorizonRow.hidden = !is360;
            [ipdRow, poleRow, segmentRow].forEach((r) => {
                r.hidden = !isStereo;
            });
            syncSource();
        };

        projectionSelect.on('change', syncProjection);
        projectionSelect.on('change', syncDepth);

        // jpeg has no alpha channel: hide the transparent background toggle
        // and show the quality slider instead
        formatSelect.on('change', () => {
            const isJpeg = formatSelect.value === 'jpeg';
            transparentBgRow.hidden = isJpeg;
            qualityRow.hidden = !isJpeg;
            syncDepth();
        });

        // handle key bindings for enter and escape

        let onCancel: () => void;
        let onOK: () => void;

        cancelButton.on('click', () => onCancel());
        okButton.on('click', () => onOK());

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };

        // reset UI and configure for current state
        const reset = () => {
            updateResolution();

            // shot cameras for the panorama source
            const cameras = (events.invoke('shotCameras.list') ?? []) as { id: number, name: string }[];
            const selected = events.invoke('shotCameras.selected') as { id: number } | null;
            cameraSelect.options = cameras.map(camera => ({ v: String(camera.id), t: camera.name }));
            if (cameras.length) {
                cameraSelect.value = String(selected?.id ?? cameras[0].id);
            }
            // a panorama camera (src/camera-poses.ts projection) preselects
            // its panorama: that camera as source, its projection and eyes
            const camera = selected as { id: number, projection?: string } | null;
            if (camera?.projection && camera.projection !== 'standard') {
                projectionSelect.value = camera.projection;
                sourceSelect.value = 'camera';
                applyCameraProjection();
            }
            syncSource();
        };

        // function implementations

        this.show = () => {
            targetSize = events.invoke('targetSize');

            reset();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<ImageSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = () => {
                    const [width, height] = resolutionValue.value;
                    const isStereo = projectionSelect.value === 'stereo';
                    const is360 = projectionSelect.value === 'equirect' || isStereo;
                    const format = formatSelect.value as ImageSettings['format'];

                    const imageSettings: ImageSettings = {
                        width,
                        height,
                        transparentBg: format !== 'jpeg' && transparentBgBoolean.value,
                        showDebug: !is360 && showDebugBoolean.value,
                        format,
                        quality: format === 'jpeg' ? qualitySlider.value / 100 : undefined,
                        depth: !depthRow.hidden && depthBoolean.value,
                        projection: (isStereo ? 'stereo' : (is360 ? 'equirect' : 'standard')) as ImageSettings['projection'],
                        levelHorizon: is360 && levelHorizonBoolean.value,
                        stereo: isStereo ? { ipd: ipdInput.value, poleStart: poleSlider.value, segments: parseInt(segmentSelect.value, 10) } : undefined,
                        source: is360 ? {
                            mode: sourceSelect.value as NonNullable<ImageSettings['source']>['mode'],
                            cameraId: parseInt(cameraSelect.value, 10),
                            north: northBoolean.value
                        } : undefined
                    };

                    resolve(imageSettings);
                };
            }).finally(() => {
                document.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { ImageSettingsDialog };
