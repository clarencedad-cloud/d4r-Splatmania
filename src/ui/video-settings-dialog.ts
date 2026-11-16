import { BooleanInput, Button, Container, Element, Label, NumericInput, SelectInput, SliderInput, VectorInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { buildVideoEncoderConfig, VideoCodecChoice, VideoSettings } from '../video-config';
import { createDepthMapOptions } from './depth-map-options';
import { i18n } from './localization';
import sceneExport from './svg/export.svg';

type ResolutionOption = {
    v: string;
    t: string;
};

const standardResolutions: ResolutionOption[] = [
    { v: '540', t: '960x540' },
    { v: '720', t: '1280x720' },
    { v: '1080', t: '1920x1080' },
    { v: '1440', t: '2560x1440' },
    { v: '4k', t: '3840x2160' },
    { v: '8k', t: '7680x4320' }
];

// 360 output is 2:1 equirectangular. Encoder support for each preset is
// detected dynamically because maximum dimensions vary by device and browser.
const equirectResolutions: ResolutionOption[] = [
    { v: '360-1k', t: '1024x512' },
    { v: '360-2k', t: '2048x1024' },
    { v: '360-4k', t: '3840x1920' },
    { v: '360-4096', t: '4096x2048' },
    { v: '360-8k', t: '7680x3840' },
    { v: '360-8192', t: '8192x4096' }
];

// stereo 360: top-bottom, each eye 2:1, so the frame is square
const stereoResolutions: ResolutionOption[] = [
    { v: 'tb-1024', t: '1024x1024' },
    { v: 'tb-2048', t: '2048x2048' },
    { v: 'tb-4096', t: '4096x4096' },
    { v: 'tb-5760', t: '5760x5760' },
    { v: 'tb-8192', t: '8192x8192' }
];

const widths: Record<string, number> = {
    'tb-1024': 1024,
    'tb-2048': 2048,
    'tb-4096': 4096,
    'tb-5760': 5760,
    'tb-8192': 8192,
    '540': 960,
    '720': 1280,
    '1080': 1920,
    '1440': 2560,
    '4k': 3840,
    '8k': 7680,
    '360-1k': 1024,
    '360-2k': 2048,
    '360-4k': 3840,
    '360-4096': 4096,
    '360-8k': 7680,
    '360-8192': 8192
};

const heights: Record<string, number> = {
    'tb-1024': 1024,
    'tb-2048': 2048,
    'tb-4096': 4096,
    'tb-5760': 5760,
    'tb-8192': 8192,
    '540': 540,
    '720': 720,
    '1080': 1080,
    '1440': 1440,
    '4k': 2160,
    '8k': 4320,
    '360-1k': 512,
    '360-2k': 1024,
    '360-4k': 1920,
    '360-4096': 2048,
    '360-8k': 3840,
    '360-8192': 4096
};

const frameRates: Record<string, number> = {
    '12': 12,
    '15': 15,
    '24': 24,
    '25': 25,
    '30': 30,
    '48': 48,
    '60': 60,
    '120': 120
};

// Bits per pixel per frame for different quality settings.
const bppfs: Record<string, number> = {
    'low': 0.001,
    'medium': 0.01,
    'high': 0.1,
    'ultra': 1
};

// Scale down higher resolutions (matched by pixel count).
const bppfFactors: Record<string, number> = {
    'tb-1024': 1 / 2,
    'tb-2048': 1 / 4,
    'tb-4096': 1 / 5,
    'tb-5760': 1 / 6,
    'tb-8192': 1 / 7,
    '540': 1,
    '720': 1 / 2,
    '1080': 1 / 3,
    '1440': 1 / 4,
    '4k': 1 / 5,
    '8k': 1 / 7,
    '360-1k': 1,
    '360-2k': 1 / 3,
    '360-4k': 1 / 5,
    '360-4096': 1 / 5,
    '360-8k': 1 / 7,
    '360-8192': 1 / 7
};

const codecNames: Record<VideoCodecChoice, string> = {
    h264: 'H.264',
    h265: 'H.265/HEVC',
    vp9: 'VP9',
    png: 'PNG',
    av1: 'AV1'
};

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

class VideoSettingsDialog extends Container {
    show: () => Promise<VideoSettings | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'video-settings-dialog',
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
        i18n.bindText(headerText, () => i18n.t('popup.render-video.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerIcon);
        header.append(headerText);

        // projection

        const projectionLabel = new Label({ class: 'label' });
        i18n.bindText(projectionLabel, 'popup.render-video.projection');
        const projectionSelect = new SelectInput({
            class: 'select',
            defaultValue: 'standard',
            options: [
                { v: 'standard', t: 'Standard' },
                { v: 'equirect', t: '360° Equirectangular' },
                { v: 'stereo', t: '360° Stereo (top/bottom)' }
            ]
        });
        i18n.bindOptions(projectionSelect, () => [
            { v: 'standard', t: i18n.t('popup.render-video.projection.standard') },
            { v: 'equirect', t: i18n.t('popup.render-video.projection.equirectangular') },
            { v: 'stereo', t: i18n.t('sm.stereo.projection') }
        ]);
        const projectionRow = new Container({ class: 'row' });
        projectionRow.append(projectionLabel);
        projectionRow.append(projectionSelect);

        // shot camera source

        const shotLabel = new Label({ class: 'label' });
        i18n.bindText(shotLabel, 'sm.cameras.camera');
        const shotSelect = new SelectInput({
            class: 'select',
            defaultValue: 'cut',
            options: [{ v: 'cut', t: i18n.t('sm.video.shot-cut') }]
        });
        const shotRow = new Container({ class: 'row' });
        shotRow.append(shotLabel);
        shotRow.append(shotSelect);

        // resolution

        const resolutionLabel = new Label({ class: 'label' });
        i18n.bindText(resolutionLabel, 'popup.render-video.resolution');
        const resolutionSelect = new SelectInput({
            class: 'select',
            defaultValue: '1080',
            options: standardResolutions
        });
        const resolutionRow = new Container({ class: 'row' });
        resolutionRow.append(resolutionLabel);
        resolutionRow.append(resolutionSelect);

        // format

        const formatLabel = new Label({ class: 'label' });
        i18n.bindText(formatLabel, 'popup.render-video.format');
        const formatSelect = new SelectInput({
            class: 'select',
            defaultValue: 'mp4'
        });
        i18n.bindOptions(formatSelect, () => [
            { v: 'mp4', t: 'MP4' },
            { v: 'webm', t: 'WebM' },
            { v: 'mov', t: 'MOV (QuickTime)' },
            { v: 'mkv', t: 'MKV' },
            { v: 'png-seq', t: i18n.t('sm.video.png-seq') },
            { v: 'exr-seq', t: i18n.t('sm.video.exr-seq') }
        ]);

        const formatRow = new Container({ class: 'row' });
        formatRow.append(formatLabel);
        formatRow.append(formatSelect);
        i18n.bindDom(formatRow.dom, 'sm.video.format-tip', 'title');

        // codec

        const codecLabel = new Label({ class: 'label' });
        i18n.bindText(codecLabel, 'popup.render-video.codec');
        const codecSelect = new SelectInput({
            class: 'select',
            defaultValue: 'h264',
            options: [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' }
            ]
        });
        const codecRow = new Container({ class: 'row' });
        codecRow.append(codecLabel);
        codecRow.append(codecSelect);

        // Codec compatibility mapping
        const codecOptions: Record<string, Array<{ v: string, t: string }>> = {
            'mp4': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' }
            ],
            'webm': [
                { v: 'vp9', t: 'VP9' },
                { v: 'av1', t: 'AV1' }
            ],
            'mov': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' },
                { v: 'png', t: 'PNG (Alpha)' }
            ],
            'png-seq': [{ v: 'png', t: 'PNG' }],
            'exr-seq': [{ v: 'png', t: 'EXR' }],
            'mkv': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' },
                { v: 'vp9', t: 'VP9' },
                { v: 'av1', t: 'AV1' }
            ]
        };

        // Update codec options when format changes
        const syncFormat = () => {
            const format = formatSelect.value;
            const options = codecOptions[format] || codecOptions.mp4;
            codecSelect.options = options;

            // Set default codec based on format
            if (format === 'webm') {
                codecSelect.value = 'vp9';
            } else if (format.endsWith('-seq')) {
                codecSelect.value = 'png';
            } else {
                codecSelect.value = 'h264';
            }
        };

        // frames we write ourselves (no WebCodecs encoder): QuickTime PNG
        // and the image sequences
        const isRaw = () => formatSelect.value.endsWith('-seq') || codecSelect.value === 'png';

        // framerate

        const frameRateLabel = new Label({ class: 'label' });
        i18n.bindText(frameRateLabel, 'popup.render-video.frame-rate');
        const frameRateSelect = new SelectInput({
            class: 'select',
            defaultValue: '30',
            options: [
                { v: '12', t: '12 fps' },
                { v: '15', t: '15 fps' },
                { v: '24', t: '24 fps' },
                { v: '25', t: '25 fps' },
                { v: '30', t: '30 fps' },
                { v: '48', t: '48 fps' },
                { v: '60', t: '60 fps' },
                { v: '120', t: '120 fps' }
            ]
        });

        const frameRateRow = new Container({ class: 'row' });
        frameRateRow.append(frameRateLabel);
        frameRateRow.append(frameRateSelect);

        // bitrate

        const bitrateLabel = new Label({ class: 'label' });
        i18n.bindText(bitrateLabel, 'popup.render-video.bitrate');
        const bitrateSelect = new SelectInput({
            class: 'select',
            defaultValue: 'high',
            options: [
                { v: 'low', t: 'Low' },
                { v: 'medium', t: 'Medium' },
                { v: 'high', t: 'High' },
                { v: 'ultra', t: 'Ultra' }
            ]
        });
        const bitrateRow = new Container({ class: 'row' });
        bitrateRow.append(bitrateLabel);
        bitrateRow.append(bitrateSelect);

        // frame range

        const totalFrames = events.invoke('timeline.frames');
        const frameRangeLabel = new Label({ class: 'label' });
        i18n.bindText(frameRangeLabel, 'popup.render-video.frame-range');
        const frameRangeInput = new VectorInput({
            class: 'vector-input',
            dimensions: 2,
            min: 0,
            max: totalFrames - 1,
            precision: 0,
            value: [0, totalFrames - 1]
        });
        i18n.onChange(() => {
            frameRangeInput.placeholder = [i18n.t('popup.render-video.frame-range-first'), i18n.t('popup.render-video.frame-range-last')];
        }, frameRangeInput);
        const frameRangeRow = new Container({ class: 'row' });
        frameRangeRow.append(frameRangeLabel);
        frameRangeRow.append(frameRangeInput);

        // Validate frame range
        frameRangeInput.on('change', (value: number[]) => {
            if (value[0] > value[1]) {
                frameRangeInput.value = [value[1], value[0]];
            }
        });

        // portrait mode

        const portraitLabel = new Label({ class: 'label' });
        i18n.bindText(portraitLabel, 'popup.render-video.portrait');
        const portraitBoolean = new BooleanInput({ class: 'boolean', value: false });
        const portraitRow = new Container({ class: 'row' });
        portraitRow.append(portraitLabel);
        portraitRow.append(portraitBoolean);

        // level horizon (360 only)

        const levelHorizonLabel = new Label({ class: 'label' });
        i18n.bindText(levelHorizonLabel, 'popup.render-video.level-horizon');
        const levelHorizonBoolean = new BooleanInput({ class: 'boolean', value: true });
        const levelHorizonRow = new Container({ class: 'row' });
        levelHorizonRow.append(levelHorizonLabel);
        levelHorizonRow.append(levelHorizonBoolean);

        // stereo 360 (omnidirectional stereo, src/ods-renderer.ts)

        const stereoRow = (text: string, input: Element, title: string) => {
            const r = new Container({ class: 'row' });
            i18n.bindDom(r.dom, title, 'title');
            const label = new Label({ class: 'label' });
            i18n.bindText(label, text);
            r.append(label);
            r.append(input);
            r.hidden = true;
            return r;
        };
        const ipdInput = new NumericInput({ class: 'numeric-input', min: 0, max: 1000, precision: 4, step: 0.001, value: 0.064 });
        const ipdRow = stereoRow('sm.stereo.ipd', ipdInput, 'sm.stereo.ipd-tip');
        const poleSlider = new SliderInput({ class: 'slider', min: 20, max: 69, precision: 0, value: 50 });
        const poleRow = stereoRow('sm.stereo.pole', poleSlider, 'sm.stereo.pole-tip');
        const segmentSelect = new SelectInput({
            class: 'select',
            defaultValue: '96'
        });
        i18n.bindOptions(segmentSelect, () => [
            { v: '48', t: i18n.t('sm.stereo.q48') },
            { v: '96', t: i18n.t('sm.stereo.q96') },
            { v: '112', t: i18n.t('sm.stereo.q112') },
            { v: '160', t: i18n.t('sm.stereo.q160') }
        ]);
        const segmentRow = stereoRow('sm.stereo.quality', segmentSelect, 'sm.stereo.quality-tip-video');

        // motion blur (standard projection only)

        const motionBlurSelect = new SelectInput({ class: 'select', defaultValue: '1' });
        i18n.bindOptions(motionBlurSelect, () => [
            { v: '1', t: i18n.t('sm.motion-blur.off') },
            { v: '4', t: i18n.t('sm.motion-blur.light') },
            { v: '8', t: i18n.t('sm.motion-blur.medium') },
            { v: '16', t: i18n.t('sm.motion-blur.high') }
        ]);
        const motionBlurRow = stereoRow('sm.motion-blur.title', motionBlurSelect, 'sm.motion-blur.tip');
        motionBlurRow.hidden = false;
        const shutterSlider = new SliderInput({ class: 'slider', min: 0.1, max: 1, precision: 2, value: 0.5 });
        const shutterRow = stereoRow('sm.motion-blur.shutter', shutterSlider, 'sm.motion-blur.shutter-tip');
        const syncMotionBlur = () => {
            const is360 = projectionSelect.value !== 'standard';
            motionBlurRow.hidden = is360;
            shutterRow.hidden = is360 || motionBlurSelect.value === '1';
        };
        motionBlurSelect.on('change', syncMotionBlur);

        // transparent background

        const transparentBgLabel = new Label({ class: 'label' });
        i18n.bindText(transparentBgLabel, 'popup.render-video.transparent-background');
        const transparentBgBoolean = new BooleanInput({ class: 'boolean', value: false });
        const transparentBgRow = new Container({ class: 'row' });
        transparentBgRow.append(transparentBgLabel);
        transparentBgRow.append(transparentBgBoolean);

        i18n.bindDom(transparentBgRow.dom, 'sm.video.alpha-tip', 'title');

        // exr: camera depth as a Z channel
        const depthBoolean = new BooleanInput({ class: 'boolean', value: true });
        const depthRow = stereoRow('sm.video.depth', depthBoolean, 'sm.video.depth-tip');
        // greyscale depth map per frame (png / exr sequences, standard projection)
        const depthMap = createDepthMapOptions();

        // show debug overlays

        const showDebugLabel = new Label({ class: 'label' });
        i18n.bindText(showDebugLabel, 'popup.render-video.show-debug-overlays');
        const showDebugBoolean = new BooleanInput({ class: 'boolean', value: false });
        const showDebugRow = new Container({ class: 'row' });
        showDebugRow.append(showDebugLabel);
        showDebugRow.append(showDebugBoolean);

        // transparency: webm (vp9 / av1 with an alpha stream), quicktime
        // png and the sequences; depth: exr in standard projection
        const syncOutputRows = () => {
            const format = formatSelect.value;
            const raw = isRaw();
            transparentBgRow.hidden = !(format === 'webm' || raw);
            depthRow.hidden = !(format === 'exr-seq' && projectionSelect.value === 'standard');
            depthMap.setAvailable((format === 'exr-seq' || format === 'png-seq') && projectionSelect.value === 'standard');
            codecRow.hidden = format.endsWith('-seq');
            bitrateRow.hidden = raw;
        };
        codecSelect.on('change', syncOutputRows);

        // sync the ui to the selected projection: 360 renders are 2:1
        // equirectangular without portrait mode or debug overlays
        const syncProjection = () => {
            const isStereo = projectionSelect.value === 'stereo';
            const is360 = projectionSelect.value === 'equirect' || isStereo;
            resolutionSelect.options = isStereo ? stereoResolutions : (is360 ? equirectResolutions : standardResolutions);
            resolutionSelect.value = isStereo ? 'tb-2048' : (is360 ? '360-4k' : '1080');
            portraitRow.hidden = is360;
            showDebugRow.hidden = is360;
            levelHorizonRow.hidden = !is360;
            [ipdRow, poleRow, segmentRow].forEach((r) => {
                r.hidden = !isStereo;
            });
            syncMotionBlur();
            syncOutputRows();
        };

        // content

        const content = new Container({ id: 'content' });
        content.append(shotRow);
        content.append(projectionRow);
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(codecRow);
        content.append(frameRateRow);
        content.append(bitrateRow);
        content.append(frameRangeRow);
        content.append(portraitRow);
        content.append(levelHorizonRow);
        content.append(ipdRow);
        content.append(poleRow);
        content.append(segmentRow);
        content.append(motionBlurRow);
        content.append(shutterRow);
        content.append(transparentBgRow);
        content.append(depthRow);
        depthMap.rows.forEach(r => content.append(r));
        content.append(showDebugRow);

        const compatibilityMessage = new Label({
            class: 'video-compatibility-message',
            hidden: true
        });
        compatibilityMessage.dom.setAttribute('aria-live', 'polite');
        compatibilityMessage.dom.setAttribute('role', 'status');
        content.append(compatibilityMessage);

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

        type ProbeState = 'idle' | 'checking' | 'ready' | 'unavailable' | 'error';

        let probeGeneration = 0;
        let checkingTimer: ReturnType<typeof setTimeout> | null = null;
        let checkingVisible = false;
        let probeState: ProbeState = 'idle';
        let supportByResolution = new Map<string, boolean>();

        const activeResolutionOptions = () => {
            if (projectionSelect.value === 'stereo') return stereoResolutions;
            return projectionSelect.value === 'equirect' ? equirectResolutions : standardResolutions;
        };

        const dimensionsFor = (resolution: string) => {
            const is360 = projectionSelect.value !== 'standard';
            const portrait = !is360 && portraitBoolean.value;
            return {
                width: (portrait ? heights : widths)[resolution],
                height: (portrait ? widths : heights)[resolution]
            };
        };

        const encodingSettingsFor = (resolution: string) => {
            const { width, height } = dimensionsFor(resolution);
            const frameRate = frameRates[frameRateSelect.value];
            const bppf = bppfs[bitrateSelect.value] * bppfFactors[resolution];

            return {
                codec: codecSelect.value as VideoCodecChoice,
                width,
                height,
                frameRate,
                // bitrate (bps) = 100m * (width x height x frame rate x bppf) / 1m
                bitrate: Math.floor(10 * width * height * frameRate * bppf)
            };
        };

        const formatResolution = (resolution: string) => {
            const { width, height } = dimensionsFor(resolution);
            return `${width}×${height}`;
        };

        const clearCheckingTimer = () => {
            if (checkingTimer !== null) {
                clearTimeout(checkingTimer);
                checkingTimer = null;
            }
        };

        type CompatibilityMessageType = 'info' | 'warning' | 'error';

        const setCompatibilityMessage = (text: string, type: CompatibilityMessageType = 'info') => {
            compatibilityMessage.text = text;
            compatibilityMessage.hidden = !text;
            compatibilityMessage.class.remove('warning', 'error');
            if (type !== 'info') {
                compatibilityMessage.class.add(type);
            }
        };

        const compatibilityDescription = () => {
            const codec = codecSelect.value as VideoCodecChoice;
            return {
                resolution: formatResolution(resolutionSelect.value),
                codec: codecNames[codec],
                frameRate: frameRates[frameRateSelect.value],
                bitrate: i18n.t(`popup.render-video.bitrate-value.${bitrateSelect.value}`)
            };
        };

        const updateCompatibilityUI = () => {
            const options = activeResolutionOptions();
            const selected = resolutionSelect.value;
            const disabledOptions: Record<string, string> = {};

            if (probeState === 'ready') {
                for (const option of options) {
                    // Keep an already-selected unsupported resolution visible so
                    // changing another setting never silently downgrades output.
                    if (option.v !== selected && supportByResolution.get(option.v) === false) {
                        disabledOptions[option.v] = `${formatResolution(option.v)} — ${i18n.t('popup.render-video.compatibility.option-disabled')}`;
                    }
                }
            } else if (probeState === 'unavailable' || probeState === 'error') {
                for (const option of options) {
                    if (option.v !== selected) {
                        disabledOptions[option.v] = `${formatResolution(option.v)} — ${i18n.t('popup.render-video.compatibility.option-unavailable')}`;
                    }
                }
            }
            resolutionSelect.disabledOptions = disabledOptions;

            if (probeState === 'checking') {
                okButton.disabled = true;
                setCompatibilityMessage(checkingVisible ? i18n.t('popup.render-video.compatibility.checking') : '');
                return;
            }

            if (probeState === 'unavailable') {
                okButton.disabled = true;
                setCompatibilityMessage(i18n.t('popup.render-video.compatibility.unavailable'), 'error');
                return;
            }

            if (probeState === 'error') {
                okButton.disabled = true;
                setCompatibilityMessage(i18n.t('popup.render-video.compatibility.check-failed'), 'error');
                return;
            }

            if (probeState !== 'ready') {
                okButton.disabled = true;
                setCompatibilityMessage('');
                return;
            }

            const selectedSupported = supportByResolution.get(selected) === true;
            okButton.disabled = !selectedSupported;

            const unsupportedCount = options.filter(option => supportByResolution.get(option.v) === false).length;
            if (selectedSupported && unsupportedCount === 0) {
                setCompatibilityMessage('');
                return;
            }

            const description = compatibilityDescription();
            const workarounds = i18n.t('popup.render-video.compatibility.workarounds');

            if (!selectedSupported) {
                const selectedPixels = dimensionsFor(selected).width * dimensionsFor(selected).height;
                const fallback = options
                .filter((option) => {
                    const dimensions = dimensionsFor(option.v);
                    return supportByResolution.get(option.v) === true &&
                        dimensions.width * dimensions.height < selectedPixels;
                })
                .sort((a, b) => {
                    const aDimensions = dimensionsFor(a.v);
                    const bDimensions = dimensionsFor(b.v);
                    return bDimensions.width * bDimensions.height - aDimensions.width * aDimensions.height;
                })[0];

                let message = i18n.t('popup.render-video.compatibility.unsupported', description);
                if (fallback) {
                    message += ` ${i18n.t('popup.render-video.compatibility.fallback', {
                        resolution: formatResolution(fallback.v)
                    })}`;
                }
                setCompatibilityMessage(`${message} ${workarounds}`, 'error');
                return;
            }

            const message = i18n.t('popup.render-video.compatibility.some-disabled', {
                codec: description.codec,
                frameRate: description.frameRate,
                bitrate: description.bitrate
            });
            setCompatibilityMessage(`${message} ${workarounds}`, 'warning');
        };

        const refreshEncoderSupport = async () => {
            const generation = ++probeGeneration;
            clearCheckingTimer();
            checkingVisible = false;
            probeState = 'checking';
            supportByResolution = new Map();
            updateCompatibilityUI();

            if (typeof VideoEncoder === 'undefined' && !isRaw()) {
                probeState = 'unavailable';
                updateCompatibilityUI();
                return;
            }

            checkingTimer = setTimeout(() => {
                if (generation === probeGeneration && probeState === 'checking') {
                    checkingVisible = true;
                    updateCompatibilityUI();
                }
            }, 150);

            try {
                // the offscreen and equirect render targets allocate textures
                // at the output size, so resolutions beyond the device texture
                // limit can never render even when the encoder supports them
                const maxTextureSize = (events.invoke('render.maxTextureSize') as number) ?? Infinity;

                const results = await Promise.all(activeResolutionOptions().map(async (option) => {
                    const { width, height } = dimensionsFor(option.v);
                    if (Math.max(width, height) > maxTextureSize) {
                        return [option.v, false] as const;
                    }

                    if (isRaw()) {
                        return [option.v, true] as const;
                    }

                    const config = buildVideoEncoderConfig(encodingSettingsFor(option.v));
                    const support = await VideoEncoder.isConfigSupported(config);
                    return [option.v, support.supported] as const;
                }));

                if (generation !== probeGeneration) {
                    return;
                }

                supportByResolution = new Map(results);
                probeState = 'ready';
            } catch (error) {
                if (generation !== probeGeneration) {
                    return;
                }

                console.warn('failed to determine video encoder support', error);
                probeState = 'error';
            } finally {
                if (generation === probeGeneration) {
                    clearCheckingTimer();
                    updateCompatibilityUI();
                }
            }
        };

        const requestEncoderSupportRefresh = () => {
            if (!this.hidden) {
                refreshEncoderSupport();
            }
        };

        projectionSelect.on('change', () => {
            syncProjection();
            requestEncoderSupportRefresh();
        });

        // the projection is a camera property (src/camera-poses.ts): picking
        // a camera (or a cut whose cameras all share one) takes it over,
        // together with the stereo eye separation; it can still be changed
        // here for this export
        const applyShotProjection = () => {
            const cameras = (events.invoke('shotCameras.list') ?? []) as { id: number, projection: string, ipd: number }[];
            let source: { projection: string, ipd: number }[] = [];
            if (shotSelect.value.startsWith('camera:')) {
                const id = parseInt(shotSelect.value.slice(7), 10);
                source = cameras.filter(c => c.id === id);
            } else if (shotSelect.value === 'cut') {
                const ids = new Set((events.invoke('cut.segments') as { cameraId: number }[]).map(seg => seg.cameraId));
                source = cameras.filter(c => ids.has(c.id));
            } else {
                source = cameras;
            }
            if (source.length === 0 || !source.every(c => c.projection === source[0].projection)) return;
            if (projectionSelect.value !== source[0].projection) projectionSelect.value = source[0].projection;
            if (source[0].projection === 'stereo') ipdInput.value = source[0].ipd;
        };
        shotSelect.on('change', applyShotProjection);
        formatSelect.on('change', () => {
            syncFormat();
            syncOutputRows();
            requestEncoderSupportRefresh();
        });
        codecSelect.on('change', requestEncoderSupportRefresh);
        frameRateSelect.on('change', requestEncoderSupportRefresh);
        bitrateSelect.on('change', requestEncoderSupportRefresh);
        portraitBoolean.on('change', requestEncoderSupportRefresh);
        resolutionSelect.on('change', updateCompatibilityUI);
        i18n.onChange(updateCompatibilityUI, compatibilityMessage);

        syncProjection();

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
            const totalFrames = events.invoke('timeline.frames');
            frameRangeInput.max = totalFrames - 1;
            frameRangeInput.value = [0, totalFrames - 1];

            // shot source options from the current cameras
            const cameras = events.invoke('shotCameras.list') as { id: number, name: string }[];
            const hasCuts = (events.invoke('cut.segments') as unknown[]).length > 0;
            shotSelect.options = [
                { v: 'cut', t: i18n.t('sm.video.shot-cut') },
                ...cameras.map(c => ({ v: `camera:${c.id}`, t: i18n.t('sm.video.shot-camera', { camera: c.name }) })),
                { v: 'all', t: i18n.t('sm.video.shot-all') }
            ];
            const selectedCamera = events.invoke('shotCameras.selected') as { id: number };
            shotSelect.value = hasCuts ? 'cut' : `camera:${selectedCamera.id}`;
            applyShotProjection();
        };

        // function implementations

        this.show = () => {
            reset();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();
            refreshEncoderSupport();

            return new Promise<VideoSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = () => {
                    if (okButton.disabled) {
                        return;
                    }

                    const isStereo = projectionSelect.value === 'stereo';
                    const is360 = projectionSelect.value === 'equirect' || isStereo;
                    const encodingSettings = encodingSettingsFor(resolutionSelect.value);
                    const frameRange = frameRangeInput.value as number[];

                    const videoSettings: VideoSettings = {
                        startFrame: frameRange[0],
                        endFrame: frameRange[1],
                        ...encodingSettings,
                        transparentBg: !transparentBgRow.hidden && transparentBgBoolean.value,
                        depth: !depthRow.hidden && depthBoolean.value,
                        depthMap: depthMap.value(),
                        showDebug: !is360 && showDebugBoolean.value,
                        format: formatSelect.value as VideoSettings['format'],
                        projection: isStereo ? 'stereo' : (is360 ? 'equirect' : 'standard'),
                        levelHorizon: is360 && levelHorizonBoolean.value,
                        stereo: isStereo ? { ipd: ipdInput.value, poleStart: poleSlider.value, segments: parseInt(segmentSelect.value, 10) } : undefined,
                        motionBlur: !is360 && motionBlurSelect.value !== '1' ? { samples: parseInt(motionBlurSelect.value, 10), shutter: shutterSlider.value } : undefined,
                        // 'all' renders each camera in its own projection: the
                        // chosen resolution for this projection, defaults for
                        // the others
                        perProjection: shotSelect.value === 'all' ? Object.fromEntries((['standard', 'equirect', 'stereo'] as const).map((proj) => {
                            const current = (isStereo ? 'stereo' : (is360 ? 'equirect' : 'standard')) === proj;
                            const fallback = proj === 'stereo' ? 'tb-2048' : (proj === 'equirect' ? '360-4k' : '1080');
                            const { width, height, bitrate } = encodingSettingsFor(current ? resolutionSelect.value : fallback);
                            return [proj, { width, height, bitrate }];
                        })) : undefined,
                        shot: shotSelect.value.startsWith('camera:') ?
                            { mode: 'camera', cameraId: parseInt(shotSelect.value.slice(7), 10) } :
                            { mode: shotSelect.value as 'cut' | 'all' }
                    };

                    resolve(videoSettings);
                };
            }).finally(() => {
                document.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            probeGeneration++;
            clearCheckingTimer();
            probeState = 'idle';
            checkingVisible = false;
            supportByResolution = new Map();
            resolutionSelect.disabledOptions = {};
            setCompatibilityMessage('');
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { VideoSettingsDialog };
