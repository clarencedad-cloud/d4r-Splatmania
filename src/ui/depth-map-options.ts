import { BooleanInput, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

import type { DepthMapSettings } from '../depth-map';
import { i18n } from './localization';

// The greyscale depth map rows of the image and video export dialogs: on/off,
// range (automatic or near / far by hand) and which end is white.
const createDepthMapOptions = () => {
    const row = (labelKey: string, tipKey: string) => {
        const r = new Container({ class: 'row' });
        i18n.bindDom(r.dom, tipKey, 'title');
        const label = new Label({ class: 'label' });
        i18n.bindText(label, labelKey);
        r.append(label);
        return r;
    };

    const enabled = new BooleanInput({ class: 'boolean', value: false });
    const enabledRow = row('sm.depthmap.enabled', 'sm.depthmap.enabled-tip');
    enabledRow.append(enabled);

    const range = new SelectInput({ class: 'select', defaultValue: 'auto', options: [] });
    const syncRangeOptions = () => {
        const value = range.value || 'auto';
        range.options = [
            { v: 'auto', t: i18n.t('sm.depthmap.range-auto') },
            { v: 'manual', t: i18n.t('sm.depthmap.range-manual') }
        ];
        range.value = value;
    };
    syncRangeOptions();
    i18n.onChange(syncRangeOptions);
    const rangeRow = row('sm.depthmap.range', 'sm.depthmap.range-tip');
    rangeRow.append(range);

    const near = new NumericInput({ class: 'numeric-input', min: 0, max: 100000, precision: 2, step: 0.1, value: 0.5 });
    const far = new NumericInput({ class: 'numeric-input', min: 0.01, max: 100000, precision: 2, step: 0.5, value: 20 });
    const nearRow = row('sm.depthmap.near', 'sm.depthmap.near-tip');
    nearRow.append(near);
    const farRow = row('sm.depthmap.far', 'sm.depthmap.far-tip');
    farRow.append(far);

    const nearWhite = new BooleanInput({ class: 'boolean', value: true });
    const whiteRow = row('sm.depthmap.near-white', 'sm.depthmap.near-white-tip');
    whiteRow.append(nearWhite);

    const rows = [enabledRow, rangeRow, nearRow, farRow, whiteRow];
    let available = false;

    const sync = () => {
        enabledRow.hidden = !available;
        const on = available && enabled.value;
        rangeRow.hidden = !on;
        whiteRow.hidden = !on;
        nearRow.hidden = farRow.hidden = !on || range.value !== 'manual';
    };
    enabled.on('change', sync);
    range.on('change', sync);
    sync();

    return {
        rows,
        // the rows only show where a depth map can be made
        setAvailable: (value: boolean) => {
            available = value;
            sync();
        },
        value: (): DepthMapSettings | undefined => (available && enabled.value ? {
            range: range.value === 'manual' ? 'manual' : 'auto',
            near: near.value,
            far: Math.max(far.value, near.value + 0.01),
            nearWhite: nearWhite.value
        } : undefined)
    };
};

export { createDepthMapOptions };
