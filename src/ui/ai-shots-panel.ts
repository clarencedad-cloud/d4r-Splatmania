import { BooleanInput, Button, Container, Label, SliderInput } from '@playcanvas/pcui';

import type { AiShotsStatus, ApplyOptions, GenerateOptions } from '../ai-shots/ai-shots';
import { aiAvailable, keyStore } from '../ai-shots/claude-client';
import { SHOT_LIMITS, SHOT_STYLES, SHOT_TEMPLATES, type ShotObject, type ShotProposal, type ShotStyle, type ShotTemplate } from '../ai-shots/shot-types';
import { Events } from '../events';
import { helpButton } from './help';
import { i18n } from './localization';
import aiShotsSvg from './svg/ai-shots.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type Card = {
    proposal: ShotProposal;
    root: Container;
    check: BooleanInput;
    applyButton: Button;
    applied: boolean;
    markApplied: () => void;
};

const MAX_ANCHORS = 3;

// i18next echoes unknown keys; show a generic text instead
const translate = (key: string, fallbackKey: string) => {
    const text = i18n.t(key);
    return text === key ? i18n.t(fallbackKey) : text;
};

// warnings aiShots.apply may report besides the new camera ids, as i18n keys:
// { warnings: [...] }, { warning: '...' } or { compressed: true }
const applyWarnings = (result: unknown): string[] => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const r = result as { warnings?: unknown; warning?: unknown; compressed?: unknown };
    const keys: string[] = [];
    if (Array.isArray(r.warnings)) keys.push(...r.warnings.filter((w): w is string => typeof w === 'string'));
    if (typeof r.warning === 'string') keys.push(r.warning);
    if (r.compressed === true) keys.push('sm.aishots.warn.compressed');
    return [...new Set(keys)];
};

const errorCode = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.startsWith('sm.aishots.') ? code : 'sm.aishots.err.api';
};

/**
 * Shot suggestions (src/ai-shots): proposes camera moves around the marked
 * object, optionally planned and rated by Claude, and turns the chosen ones
 * into shot cameras.
 */
class AiShotsPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ai-shots-panel',
            class: ['panel', 'options-panel'],
            hidden: true
        };

        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'keydown'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(aiShotsSvg));
        const label = new Label({ class: 'panel-header-label' });
        i18n.bindText(label, 'sm.aishots.title');
        header.append(icon);
        header.append(label);
        header.dom.appendChild(helpButton(events, 'aiShots'));
        this.append(header);

        const section = (key: string) => {
            const container = new Container({ class: ['panel-header', 'options-panel-section'] });
            const sectionLabel = new Label({ class: 'panel-header-label' });
            i18n.bindText(sectionLabel, key);
            container.append(sectionLabel);
            this.append(container);
        };

        const row = (labelKey: string, tipKey?: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            if (tipKey) tooltips.register(rowLabel, () => i18n.t(tipKey), 'left');
            container.append(rowLabel);
            this.append(container);
            return container;
        };

        const toggleRow = (labelKey: string, tipKey: string, value: boolean) => {
            const container = row(labelKey, tipKey);
            const toggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value });
            container.append(toggle);
            container.class.add('options-panel-row-clickable');
            container.dom.addEventListener('click', (event: MouseEvent) => {
                if (toggle.enabled && !toggle.dom.contains(event.target as Node)) {
                    toggle.value = !toggle.value;
                }
            });
            return toggle;
        };

        const button = (key: string, cls: string | string[], parent: Container, tipKey?: string) => {
            const b = new Button({ class: cls });
            i18n.bindText(b, key);
            if (tipKey) tooltips.register(b, () => i18n.t(tipKey), 'left');
            parent.append(b);
            return b;
        };

        // object

        section('sm.aishots.section-object');

        const objectRow = new Container({ class: 'ai-shots-row' });
        const objectInfo = new Label({ class: 'ai-shots-info' });
        objectRow.append(objectInfo);
        const captureButton = button('sm.aishots.capture', 'ai-shots-small', objectRow, 'sm.aishots.capture-tip');
        this.append(objectRow);

        let object: ShotObject | null = null;
        const renderObject = () => {
            if (!object) {
                objectInfo.text = i18n.t('sm.aishots.object-none');
                return;
            }
            const e = object.halfExtents;
            const size = [e.x, e.y, e.z].map(v => (v * 2).toFixed(2)).join(' × ');
            objectInfo.text = `${i18n.t(`sm.aishots.source.${object.source}`)} · ${size}`;
        };
        i18n.onChange(renderObject, objectInfo);

        // a taken object stays until the scene is cleared; without one,
        // generating uses the current box / sphere, selection or scene
        captureButton.on('click', () => {
            object = (events.invoke('aiShots.captureObject') as ShotObject | null) ?? null;
            renderObject();
        });
        events.on('scene.clear', () => {
            object = null;
            renderObject();
        });

        // favourite angles

        const anchorLabel = new Label({ class: 'ai-shots-info' });
        const anchorRow = new Container({ class: 'ai-shots-row' });
        anchorRow.append(anchorLabel);
        const anchorAdd = button('sm.aishots.anchor-add', 'ai-shots-small', anchorRow, 'sm.aishots.anchor-add-tip');
        const anchorClear = button('sm.aishots.anchor-clear', 'ai-shots-small', anchorRow);
        this.append(anchorRow);

        let anchorCount = 0;
        const renderAnchors = () => {
            anchorLabel.text = i18n.t('sm.aishots.anchors', { n: anchorCount, max: MAX_ANCHORS });
        };
        i18n.onChange(renderAnchors, anchorLabel);

        const setAnchorCount = (count: number) => {
            anchorCount = count;
            anchorClear.enabled = count > 0;
            renderAnchors();
        };
        const syncAnchors = () => {
            const anchors = events.functions.has('aiShots.anchors') ? events.invoke('aiShots.anchors') as unknown[] : [];
            setAnchorCount(anchors?.length ?? 0);
        };
        anchorAdd.on('click', () => events.fire('aiShots.addAnchor'));
        anchorClear.on('click', () => events.fire('aiShots.clearAnchors'));
        events.on('aiShots.anchorsChanged', (count: number) => setAnchorCount(count));

        // duration, defaults to the timeline length until the user picks one

        const [minDuration, maxDuration] = SHOT_LIMITS.durationSec;
        const durationRow = row('sm.aishots.duration');
        const duration = new SliderInput({
            class: 'settings-panel-row-slider',
            min: minDuration,
            max: maxDuration,
            precision: 0,
            step: 1,
            value: 10
        });
        durationRow.append(duration);

        let durationTouched = false;
        let syncingDuration = false;
        const syncDuration = () => {
            if (durationTouched) return;
            const fps = events.invoke('timeline.frameRate') ?? 30;
            const frames = events.invoke('timeline.frames') ?? 0;
            syncingDuration = true;
            // a move of T seconds takes round(T*fps)+1 frames: round down so
            // the default move fits into the current timeline
            duration.value = Math.min(maxDuration, Math.max(minDuration, Math.floor((frames - 1) / fps + 1e-6)));
            syncingDuration = false;
        };
        duration.on('change', () => {
            if (!syncingDuration) durationTouched = true;
        });
        events.on('timeline.frames', syncDuration);
        events.on('timeline.frameRate', syncDuration);

        // distance to the object, as a multiple of the automatic framing
        const distanceRow = row('sm.aishots.distance', 'sm.aishots.distance-tip');
        const distance = new SliderInput({
            class: 'settings-panel-row-slider',
            min: 0.5,
            max: 3,
            precision: 1,
            step: 0.1,
            value: 1
        });
        distanceRow.append(distance);

        // camera height and kind of move, like the camera presets of video
        // generators. Native selects: their list is never clipped by the panel
        const select = (labelKey: string, tipKey: string, options: [string, string][]) => {
            const container = row(labelKey, tipKey);
            const el = document.createElement('select');
            el.classList.add('ai-shots-select');
            const build = () => {
                const value = el.value;
                el.innerHTML = '';
                for (const [v, key] of options) {
                    const option = document.createElement('option');
                    option.value = v;
                    option.textContent = i18n.t(key);
                    el.appendChild(option);
                }
                el.value = value || options[0][0];
            };
            build();
            i18n.onChange(build);
            el.addEventListener('keydown', e => e.stopPropagation());
            container.dom.appendChild(el);
            return el;
        };
        const styleSelect = select('sm.aishots.style', 'sm.aishots.style-tip',
            SHOT_STYLES.map(s => [s, `sm.aishots.style.${s}`] as [string, string]));
        const moveSelect = select('sm.aishots.move', 'sm.aishots.move-tip',
            [['all', 'sm.aishots.move.all'] as [string, string], ...SHOT_TEMPLATES.map(t => [t, `sm.aishots.template.${t}`] as [string, string])]);

        // claude

        section('sm.aishots.section-ai');

        const wish = document.createElement('textarea');
        wish.className = 'ai-shots-wish';
        wish.rows = 3;
        i18n.onChange(() => {
            wish.placeholder = i18n.t('sm.aishots.wish-placeholder');
            wish.setAttribute('aria-label', i18n.t('sm.aishots.wish'));
        });
        this.dom.appendChild(wish);

        const useAi = toggleRow('sm.aishots.use-ai', 'sm.aishots.use-ai-tip', true);

        const aiHintRow = new Container({ class: 'ai-shots-row' });
        const aiHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'] });
        aiHintRow.append(aiHint);
        const openSettings = button('sm.aishots.open-settings', 'ai-shots-small', aiHintRow);
        openSettings.on('click', () => events.fire('settingsPanel.setVisible', true));
        this.append(aiHintRow);

        let aiHintKey = 'sm.aishots.ai-no-key';
        i18n.onChange(() => {
            aiHint.text = i18n.t(aiHintKey);
        }, aiHint);

        let wantAi = true;
        let syncingAi = false;
        const syncAi = () => {
            const available = aiAvailable();
            syncingAi = true;
            useAi.enabled = available;
            useAi.value = available && wantAi;
            syncingAi = false;
            wish.disabled = !useAi.value;
            const noKey = !keyStore.get();
            aiHintKey = noKey ? 'sm.aishots.ai-no-key' : 'sm.aishots.ai-offline';
            aiHint.text = i18n.t(aiHintKey);
            aiHintRow.hidden = available;
            openSettings.hidden = !noKey;
        };
        useAi.on('change', (value: boolean) => {
            if (syncingAi) return;
            wantAi = value;
            syncAi();
        });
        window.addEventListener('online', syncAi);
        window.addEventListener('offline', syncAi);
        // key saved / cleared in the settings, or removed in another tab
        events.on('aiShots.keyChanged', syncAi);
        keyStore.onChange(syncAi);

        // generate

        const actionRow = new Container({ class: 'ai-shots-actions' });
        const generateButton = button('sm.aishots.generate', 'ai-shots-generate', actionRow);
        const cancelButton = button('sm.aishots.cancel', 'ai-shots-cancel', actionRow);
        cancelButton.hidden = true;
        this.append(actionRow);

        const statusLine = new Container({ class: 'ai-shots-status', hidden: true });
        const spinner = document.createElement('div');
        spinner.className = 'ai-shots-spinner';
        statusLine.dom.appendChild(spinner);
        const statusLabel = new Label({ class: 'ai-shots-status-label' });
        statusLine.append(statusLabel);
        this.append(statusLine);

        let busy = false;
        let cancelled = false;
        let aiError: string | null = null;
        let statusKey: string | null = null;
        let statusKind: 'info' | 'error' | 'warn' = 'info';

        const renderStatus = () => {
            statusLabel.text = !statusKey ? '' :
                statusKind === 'error' ? translate(statusKey, 'sm.aishots.err.api') :
                    statusKind === 'warn' ? translate(statusKey, 'sm.aishots.warn.generic') :
                        i18n.t(statusKey);
        };
        i18n.onChange(renderStatus, statusLabel);

        const setStatus = (key: string | null, kind: 'info' | 'error' | 'warn' = 'info') => {
            statusKey = key;
            statusKind = kind;
            statusLine.hidden = !key;
            statusLine.class[kind === 'error' ? 'add' : 'remove']('ai-shots-error');
            statusLine.class[kind === 'warn' ? 'add' : 'remove']('ai-shots-warn');
            spinner.hidden = !busy || kind !== 'info';
            renderStatus();
        };

        const setBusy = (value: boolean) => {
            busy = value;
            generateButton.enabled = !value;
            cancelButton.hidden = !value;
            captureButton.enabled = !value;
        };

        // statuses beyond AiShotsStatus (e.g. 'waitingVisible' while the tab is
        // in the background) map to sm.aishots.status.<status> as well
        events.on('aiShots.status', (status: AiShotsStatus | string, detail?: string) => {
            if (status === 'error') {
                aiError = detail ?? 'sm.aishots.err.api';
                setStatus(aiError, 'error');
            } else if (busy && status !== 'idle') {
                setStatus(`sm.aishots.status.${status}`);
            }
        });

        // warnings from the core as i18n keys, e.g. sm.aishots.warn.compressed
        // when a move was squeezed into the timeline length
        const showWarning = (key: string) => {
            if (typeof key !== 'string' || !key.startsWith('sm.aishots.')) return;
            if (key.startsWith('sm.aishots.status.')) {
                if (busy) setStatus(key);
            } else {
                setStatus(key, 'warn');
            }
        };
        events.on('aiShots.warning', showWarning);

        // results

        const resultsHeader = new Container({ class: ['panel-header', 'options-panel-section'] });
        const resultsLabel = new Label({ class: 'panel-header-label' });
        resultsHeader.append(resultsLabel);
        this.append(resultsHeader);

        const empty = new Label({ class: 'ai-shots-empty' });
        i18n.bindText(empty, 'sm.aishots.empty');
        this.append(empty);
        const list = new Container({ class: 'ai-shots-list' });
        this.append(list);

        let cards: Card[] = [];

        const renderResultsLabel = () => {
            resultsLabel.text = cards.length ? i18n.t('sm.aishots.result-count', { n: cards.length }) : i18n.t('sm.aishots.section-results');
        };
        i18n.onChange(renderResultsLabel, resultsLabel);

        // footer: apply the checked suggestions

        const footer = new Container({ class: 'ai-shots-footer', hidden: true });
        this.append(footer);

        const footerToggle = (labelKey: string, tipKey: string) => {
            const container = new Container({ class: 'settings-panel-row' });
            const rowLabel = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(rowLabel, labelKey);
            tooltips.register(rowLabel, () => i18n.t(tipKey), 'left');
            const toggle = new BooleanInput({ type: 'toggle', class: 'settings-panel-row-toggle', value: true });
            container.append(rowLabel);
            container.append(toggle);
            footer.append(container);
            return { row: container, toggle };
        };
        const setTimeline = footerToggle('sm.aishots.set-timeline', 'sm.aishots.set-timeline-tip').toggle;
        const disableLoop = footerToggle('sm.aishots.disable-loop', 'sm.aishots.disable-loop-tip').toggle;
        const loopHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'] });
        i18n.bindText(loopHint, 'sm.aishots.disable-loop-tip');
        footer.append(loopHint);
        // only offered when a suggestion carries a focus pull
        const enableDof = footerToggle('sm.aishots.enable-dof', 'sm.aishots.enable-dof-tip');

        // applying a suggestion again only goes through "apply selected"
        const reapplyHint = new Label({ class: ['ai-shots-info', 'ai-shots-hint'], hidden: true });
        i18n.bindText(reapplyHint, 'sm.aishots.reapply-hint');
        footer.append(reapplyHint);

        const applySelectedButton = new Button({ class: 'ai-shots-generate' });
        footer.append(applySelectedButton);

        let applying = false;

        const syncSelection = () => {
            const checked = cards.filter(c => c.check.value);
            applySelectedButton.enabled = !applying && checked.length > 0;
            applySelectedButton.text = i18n.t('sm.aishots.apply-selected', { n: checked.length });
            reapplyHint.hidden = !checked.some(c => c.applied);
            cards.forEach((c) => {
                c.applyButton.enabled = !applying && !c.applied;
            });
        };
        i18n.onChange(syncSelection, applySelectedButton);

        const titleOf = (proposal: ShotProposal) => {
            if (proposal.params.label) return proposal.params.label;
            return proposal.title.startsWith('sm.') ? translate(proposal.title, 'sm.aishots.title') : proposal.title;
        };

        const apply = async (proposals: ShotProposal[]) => {
            if (applying || !proposals.length || !events.functions.has('aiShots.apply')) return;
            // all apply buttons stay locked while a call runs (no double clicks)
            applying = true;
            syncSelection();
            if (!busy && statusKind === 'warn') setStatus(null);
            try {
                const options: ApplyOptions = {
                    setTimeline: setTimeline.value,
                    disableLoop: disableLoop.value,
                    enableDof: !enableDof.row.hidden && enableDof.toggle.value
                };
                const result = await events.invoke('aiShots.apply', proposals, options);
                cards.filter(c => proposals.includes(c.proposal)).forEach(c => c.markApplied());
                applyWarnings(result).forEach(showWarning);
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('sm.aishots.apply-failed'),
                    message: `'${(error as Error)?.message ?? error}'`
                });
            } finally {
                applying = false;
                syncSelection();
            }
        };
        applySelectedButton.on('click', () => apply(cards.filter(c => c.check.value).map(c => c.proposal)));

        const createCard = (proposal: ShotProposal): Card => {
            const root = new Container({ class: 'ai-shots-card' });

            const thumb = document.createElement('div');
            thumb.className = 'ai-shots-thumb';
            if (proposal.thumbnail) {
                const img = document.createElement('img');
                img.src = proposal.thumbnail;
                img.alt = '';
                thumb.appendChild(img);
            }
            root.dom.appendChild(thumb);

            const head = new Container({ class: 'ai-shots-card-head' });
            const check = new BooleanInput({ class: 'ai-shots-check' });
            const title = new Label({ class: 'ai-shots-card-title' });
            i18n.bindText(title, () => titleOf(proposal));
            const badge = new Label({ class: 'ai-shots-badge', hidden: true });
            i18n.bindText(badge, 'sm.aishots.applied');
            head.append(check);
            head.append(title);
            head.append(badge);
            root.append(head);
            check.on('change', syncSelection);

            const meta = new Label({ class: 'ai-shots-card-meta' });
            i18n.bindText(meta, 'sm.aishots.frames', {
                seconds: Math.round(proposal.params.durationSec * 10) / 10,
                frames: proposal.frames
            });
            root.append(meta);

            const percent = Math.round(Math.min(1, Math.max(0, proposal.score)) * 100);
            const scoreRow = new Container({ class: 'ai-shots-score' });
            const scoreLabel = new Label({ class: 'ai-shots-score-label' });
            i18n.bindText(scoreLabel, 'sm.aishots.score');
            scoreRow.append(scoreLabel);
            const bar = document.createElement('div');
            bar.className = 'ai-shots-bar';
            const fill = document.createElement('div');
            fill.style.width = `${percent}%`;
            bar.appendChild(fill);
            scoreRow.dom.appendChild(bar);
            tooltips.register(scoreRow, () => i18n.t('sm.aishots.score-tip', { percent }), 'left');
            root.append(scoreRow);

            if (proposal.aiScore !== undefined) {
                const aiScore = new Label({ class: 'ai-shots-ai-score' });
                i18n.bindText(aiScore, 'sm.aishots.ai-score', { score: Math.round(proposal.aiScore * 10) / 10 });
                root.append(aiScore);
            }

            const comment = proposal.aiComment ?? proposal.params.rationale;
            if (comment) {
                root.append(new Label({ class: 'ai-shots-comment', text: comment }));
            }

            proposal.warnings.forEach((warning) => {
                const w = new Label({ class: 'ai-shots-warning' });
                i18n.bindText(w, () => translate(warning, 'sm.aishots.warn.generic'));
                root.append(w);
            });

            const applyButton = button('sm.aishots.apply', 'ai-shots-small', root, 'sm.aishots.apply-tip');
            applyButton.on('click', () => apply([proposal]));

            const card: Card = {
                proposal,
                root,
                check,
                applyButton,
                applied: false,
                markApplied: () => {
                    card.applied = true;
                    root.class.add('applied');
                    badge.hidden = false;
                    applyButton.enabled = false;
                    check.value = false;
                }
            };
            return card;
        };

        const showProposals = (proposals: ShotProposal[]) => {
            cards.forEach(c => c.root.destroy());
            cards = proposals.map(createCard);
            cards.forEach(c => list.append(c.root));
            empty.hidden = cards.length > 0;
            footer.hidden = cards.length === 0;
            enableDof.row.hidden = !proposals.some(p => p.keys.some(k => k.focus !== undefined));
            renderResultsLabel();
            syncSelection();
        };

        // run

        const generate = async () => {
            if (busy || !events.functions.has('aiShots.generate')) return;
            cancelled = false;
            aiError = null;
            setBusy(true);
            setStatus('sm.aishots.status.generating');
            showProposals([]);
            try {
                const options: GenerateOptions = {
                    wish: useAi.value ? wish.value.trim() || undefined : undefined,
                    useAi: useAi.value,
                    durationSec: duration.value,
                    distanceScale: distance.value,
                    style: styleSelect.value as ShotStyle,
                    templates: moveSelect.value === 'all' ? undefined : [moveSelect.value as ShotTemplate]
                };
                const proposals = await events.invoke('aiShots.generate', options) as ShotProposal[] | null;
                if (!cancelled) showProposals(proposals ?? []);
            } catch (error) {
                if (!cancelled) aiError = errorCode(error);
            }
            setBusy(false);
            if (cancelled) {
                setStatus('sm.aishots.status.cancelled');
            } else {
                setStatus(aiError, aiError ? 'error' : 'info');
            }
        };
        generateButton.on('click', () => generate());
        cancelButton.on('click', () => {
            cancelled = true;
            events.fire('aiShots.cancel');
        });

        // visibility: one options panel at a time

        const others = ['appearancePanel', 'overlaysPanel', 'settingsPanel', 'lookPanel', 'titlesPanel', 'lightPanel'];
        const setVisible = (visible: boolean) => {
            if (visible !== this.hidden) return;
            if (visible) {
                syncAi();
                syncAnchors();
                syncDuration();
            }
            this.hidden = !visible;
            events.fire('aiShotsPanel.visible', visible);
            if (visible) others.forEach(name => events.fire(`${name}.setVisible`, false));
        };
        events.function('aiShotsPanel.visible', () => !this.hidden);
        events.on('aiShotsPanel.setVisible', setVisible);
        events.on('aiShotsPanel.toggleVisible', () => setVisible(this.hidden));
        others.forEach((name) => {
            events.on(`${name}.visible`, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });

        showProposals([]);
    }
}

export { AiShotsPanel };
