import { Container, Label, SelectInput } from '@playcanvas/pcui';

import { biasOf, CellState, DETAIL, gridCell, type CellProbe, type LoserNumbers, type PairInfo, type ProbePair, type Rejected } from './compose-detail';
import { button, el, formatArea, formatDims, formatFactor, formatInt, inView, percent, percentText, scrollIntoPanel, segmented, splatLen, swatch } from './compose-dom';
import type { Card, ComposeSuggest, GridMode } from './compose-suggest';
import { Events } from '../events';
import { formatNumber, type SceneScale } from '../scene-scale';
import type { Splat } from '../splat';
import { i18n } from '../ui/localization';

// Panel of the scan composition's steps 3 "Analyse" and 4 "Vorschläge"
// (compose-tool.ts rebuilds the body and calls in here): options, results,
// map legend, probe box, the suggestion cards with their checklists, the
// rejected list, and the pills over the viewport.

type PanelContext = {
    events: Events,
    suggest: ComposeSuggest,
    sceneScale: () => SceneScale,
    len: (v: number) => string,
    colorOf: (splat: Splat) => string,
    // a scan's name in every text (compose-dom scanName: numbered when two
    // layers share it)
    nameOf: (splat: Splat) => string,
    included: () => Splat[],
    // included scans (not the reference) without a fresh phase-1 result
    unaligned: () => Splat[],
    step: () => string,
    busy: () => boolean,
    onChange: () => void
};

type Projected = { x: number, y: number, visible: boolean };

type Box = { min: number[], max: number[], color: string };

// cards shown before the rest folds away; rejected clusters listed
const CARDS_SHOWN = 30;
const SKIP_SHOWN = 8;
// other cards' hides listed in a probe and on a skip row (largest first)
const PROBE_HIDES = 3;
const SKIP_HIDES = 2;
// a general difference below this (octaves) reads as "equally fine"
const BIAS_SHOWN = 0.15;
// the grey of the map's tie class (projector: 0.62)
const GREY = '#9e9e9e';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`sm.compose.${key}`, options);

class SuggestPanel {
    private c: PanelContext;
    private showAll = false;
    private scrollTo = -1;
    private pills: HTMLElement[] = [];
    // cards in the panel right now (their pills show)
    private shownIds = new Set<number>();

    constructor(c: PanelContext) {
        this.c = c;
        // a card made with "Trotzdem übernehmen" shows at once, also past the
        // fold (the panel rebuilds when the run ends)
        c.events.on('compose.forced', (id: number) => this.reveal(id));
    }

    // ------------------------------------------------------------ step 3

    buildAnalyse(body: HTMLElement, transient: Container[]) {
        const { suggest, events } = this.c;
        const a = suggest.analysis;
        const busy = this.c.busy();
        const scale = this.c.sceneScale();
        const len = this.c.len;
        body.appendChild(el('div', 'compose-hint', t('analyse.hint', { cell: a ? len(a.cell) : t('analyse.cell-auto') })));
        if (this.c.included().length < 2) {
            body.appendChild(el('div', 'compose-note', t('need-two')));
            this.nav(body, i18n.t('sm.compose.back'), 'align', null);
            return;
        }
        const unaligned = this.c.unaligned();
        if (unaligned.length) {
            body.appendChild(el('div', ['compose-note', 'warn'], t('analyse.unaligned', { names: unaligned.map(s => this.c.nameOf(s)).join(', ') })));
        }

        // options (pcui elements, destroyed on the next rebuild)
        const options = new Container({ class: 'compose-options' });
        transient.push(options);
        const auto = a?.auto.cell;
        const sized = (text: string, mode: GridMode) => (auto ? `${text} (${len(gridCell(auto, mode))})` : text);
        options.append(this.selectRow(t('analyse.grid'), t('analyse.grid-tip'), suggest.grid, [
            { v: 'auto', t: sized(t('analyse.grid-auto'), 'auto') },
            { v: 'fine', t: sized(t('analyse.grid-fine'), 'fine') },
            { v: 'coarse', t: sized(t('analyse.grid-coarse'), 'coarse') }
        ], busy, (v: string) => events.fire('compose.setAnalysisOptions', { grid: v })));
        options.append(this.selectRow(t('analyse.lead'), t('analyse.lead-tip'), String(suggest.lead), ['1.4', '1.6', '2'].map(v => ({ v, t: `${formatFactor(Number(v))}×` })), busy,
            (v: string) => events.fire('compose.setAnalysisOptions', { lead: Number(v) })));
        body.appendChild(options.dom);

        const run = el('div', 'compose-row');
        run.appendChild(button(t(a ? 'analyse.rerun' : 'analyse.run'), () => events.invoke('compose.analyse'), ['primary', ...(busy ? ['disabled'] : [])], undefined, 'analyse-run'));
        body.appendChild(run);

        if (!a) {
            this.nav(body, i18n.t('sm.compose.back'), 'align', null);
            return;
        }
        const stale = suggest.isStale();
        if (stale) body.appendChild(el('div', ['compose-note', 'warn'], t('analyse.stale')));

        // per scan
        body.appendChild(el('div', 'compose-subheading', t('analyse.result')));
        const list = el('div', 'compose-results');
        a.scans.forEach((splat, s) => {
            const info = a.detail.scans[s];
            const card = el('div', 'compose-result');
            const head = el('div', 'compose-result-head');
            head.append(swatch(this.c.colorOf(splat)), el('span', 'compose-name', this.c.nameOf(splat)));
            card.appendChild(head);
            card.appendChild(el('div', 'compose-info', t('analyse.scan', {
                size: splatLen(info.s50, scale),
                win: percentText(info.finest),
                tie: percentText(info.tie),
                lose: percentText(info.coarser)
            })));
            card.appendChild(el('div', 'compose-info', t('analyse.alone', { alone: percentText(info.alone) })));
            list.appendChild(card);
        });
        body.appendChild(list);

        // per pair
        a.detail.pairs.forEach(p => body.appendChild(this.pairRow(p)));
        body.appendChild(el('div', 'compose-note', t('analyse.base-note')));
        if (a.auto.forcedBy >= 0) {
            const others = a.auto.perScan.filter((_, i) => i !== a.auto.forcedBy).sort((x, y) => x - y);
            const other = others[(others.length - 1) >> 1];
            body.appendChild(el('div', ['compose-note', 'warn'], t('analyse.forced', { name: this.c.nameOf(a.scans[a.auto.forcedBy]), cell: len(a.auto.cell), other: len(other) })));
        }

        const base = a.cards.filter(c => c.region.scope === 'base').length;
        body.appendChild(el('div', 'compose-note', t('analyse.summary', { count: a.cards.length, s: formatNumber(a.seconds, 1), n: a.cards.length, base, skip: a.detail.rejected.length })));

        // the scans lie apart in places: not compared there
        if (a.apartShare >= 0.02) {
            const index = a.detail.rejected.findIndex(r => r.reason === 'apart');
            const row = el('div', ['compose-zone', 'q-bad']);
            row.appendChild(el('span', 'compose-zone-text', t('analyse.apart', { v: percentText(a.apartShare), d: len(DETAIL.apartSep * a.cell) })));
            if (index >= 0) {
                row.appendChild(button('⌖', () => suggest.focusRejected(index), ['small'], t('card.fly-tip'), 'apart:fly'));
                const target = suggest.alignTarget(index);
                if (target) {
                    const centre = a.detail.rejected[index].centre;
                    row.appendChild(button(t('zone.here'), () => events.invoke('compose.alignAt', target, centre), ['small', ...(busy ? ['disabled'] : [])], t('zone.here-tip'), 'apart:align'));
                }
                this.hoverable(row, index);
            }
            body.appendChild(row);
        }
        if (a.cards.some(c => c.status !== 'open' || c.handHidden)) body.appendChild(el('div', 'compose-note', t('analyse.locked-note')));

        if (suggest.map && !stale) body.appendChild(this.legend());

        body.appendChild(el('div', 'compose-note', t('probe.hint')));
        if (suggest.probeResult) body.appendChild(this.probeBox(suggest.probeResult.probe));

        this.nav(body, i18n.t('sm.compose.back'), 'align', { step: 'suggest', text: t('analyse.next', { count: a.cards.filter(c => !c.rejected).length }) });
    }

    private selectRow(label: string, tip: string, value: string, options: { v: string, t: string }[], disabled: boolean, onChange: (v: string) => void) {
        const row = new Container({ class: 'compose-row' });
        const l = new Label({ class: 'compose-label', text: label });
        l.dom.title = tip;
        const input = new SelectInput({ class: 'compose-select', value, options });
        input.dom.title = tip;
        input.enabled = !disabled;
        // the change rebuilds the panel, which destroys this input: not from
        // inside its own event
        input.on('change', (v: string) => setTimeout(() => onChange(v), 0));
        row.append(l);
        row.append(input);
        return row;
    }

    private pairRow(p: PairInfo) {
        const a = this.c.suggest.analysis;
        const scale = this.c.sceneScale();
        const A = a.scans[p.a], B = a.scans[p.b];
        const line = el('div', 'compose-pair');
        line.append(swatch(this.c.colorOf(A), 'compose-dot'), swatch(this.c.colorOf(B), 'compose-dot'));
        const parts = [t('analyse.shared', { area: formatArea(p.sharedArea, scale) })];
        if (!Number.isFinite(p.biasRaw)) parts.push(t('analyse.bias-few'));
        else if (Math.abs(p.bias) < BIAS_SHOWN) parts.push(t('analyse.bias-equal'));
        else parts.push(t('analyse.bias', { a: this.c.nameOf(p.bias > 0 ? A : B), f: formatFactor(2 ** Math.abs(p.bias)) }));
        parts.push(t('analyse.clearly', { a: this.c.nameOf(A), pa: percentText(p.clearA), b: this.c.nameOf(B), pb: percentText(p.clearB) }));
        // exposure: median ln-luminance difference b - a (< 0: b darker)
        if (Number.isFinite(p.exposure) && p.exposure !== 0) {
            const e = percent(1 - Math.exp(-Math.abs(p.exposure)));
            if (e >= 2) parts.push(t('analyse.darker', { name: this.c.nameOf(p.exposure < 0 ? B : A), e }));
        }
        line.appendChild(el('span', '', parts.join(' · ')));
        return line;
    }

    private legend() {
        const a = this.c.suggest.analysis;
        const box = el('div', 'compose-legend');
        const chip = (color: string, pale: boolean, text: string) => {
            const c = el('span', ['compose-chip', ...(pale ? ['pale'] : [])]);
            c.append(swatch(color, 'compose-chip-dot'), el('span', '', text));
            box.appendChild(c);
        };
        a.scans.forEach((splat) => {
            const color = this.c.colorOf(splat);
            chip(color, false, t('map.finer', { name: this.c.nameOf(splat) }));
            chip(color, true, t('map.somewhat', { name: this.c.nameOf(splat) }));
        });
        chip(GREY, false, t('map.equal'));
        box.appendChild(el('div', 'compose-note', t('map.none')));
        return box;
    }

    // the other scan a probe row compares with: the owner, or for the owner
    // the scan it beats most, else the first other scan with surface there
    private partnerOf(p: CellProbe, s: number) {
        if (p.owner >= 0 && p.owner !== s && p.scans[p.owner]?.present) return p.owner;
        if (p.owner === s) {
            let best = -1, lead = -Infinity;
            p.pairs.forEach((q) => {
                if (q.winner === s && (q.strong || q.weak) && q.lead > lead) {
                    lead = q.lead;
                    best = q.loser;
                }
            });
            if (best >= 0) return best;
        }
        const other = p.scans.find(q => q.present && q.scan !== s);
        return other ? other.scan : -1;
    }

    private probeBox(p: CellProbe) {
        const { suggest } = this.c;
        const a = suggest.analysis;
        const scale = this.c.sceneScale();
        const box = el('div', 'compose-probe');
        const head = el('div', 'compose-probe-head');
        head.appendChild(el('span', 'compose-probe-title', t('probe.title', {
            c: this.c.len(a.cell),
            q: p.pooled ? t('probe.cells', { n: p.measured }) : t('probe.one-cell')
        })));
        head.appendChild(button('✕', () => suggest.closeProbe(), ['small'], i18n.t('sm.help.close'), 'probe:close'));
        box.appendChild(head);
        p.scans.filter(ps => ps.present).forEach((ps) => {
            const splat = a.scans[ps.scan];
            const partner = this.partnerOf(p, ps.scan);
            const pair = partner >= 0 ? p.pairs.find(q => q.winner === ps.scan && q.loser === partner) : null;
            const parts = [Number.isFinite(ps.size) ? t('probe.size', { size: splatLen(ps.size, scale) }) : t('probe.few')];
            if (pair && Number.isFinite(pair.density)) parts.push(t('probe.density', { f: formatFactor(pair.density) }));
            if (Number.isFinite(ps.texture)) parts.push(t('probe.texture', { v: percent(ps.texture) }));
            if (pair) parts.push(t('probe.covers', { name: this.c.nameOf(a.scans[partner]), v: percent(pair.cover) }));
            const row = el('div', 'compose-probe-row');
            row.append(swatch(this.c.colorOf(splat)), el('span', 'compose-probe-text', `${this.c.nameOf(splat)}: ${parts.join(' · ')}`));
            box.appendChild(row);
        });
        box.appendChild(this.verdict(p));
        return box;
    }

    // the verdict line, and the link to the suggestion the cell belongs to,
    // whatever the cell's own state (a region made with "Trotzdem
    // übernehmen" has only texture or sparse cells, a region may hold ties
    // and uncovered cells): "– Vorschlag n" after a phrase, a sentence of its
    // own after a sentence
    private verdict(p: CellProbe) {
        const { suggest } = this.c;
        const a = suggest.analysis;
        // what the cards hide in this cell: the cell's own card (an
        // uncovered cell may still lose its blur haze), and other cards
        // whose ring or haze zone reaches here (a cell in no region, or of
        // another one: its state says nothing about those)
        const hides = p.cell >= 0 ? suggest.hidesIn([p.cell]) : [];
        const own = hides.find(h => h.card === p.region) ?? null;
        const { text, phrase } = this.verdictText(p, own);
        const link = (id: number, key: string) => {
            const span = el('span', 'compose-link', t(key, { n: id + 1 }));
            span.setAttribute('role', 'button');
            span.addEventListener('click', () => this.open(id));
            return span;
        };
        const line = el('div', 'verdict', text);
        if (p.cell >= 0 && p.region >= 0 && suggest.card(p.region)) line.append(' ', link(p.region, phrase ? 'probe.card' : 'probe.in-card'));
        const others = hides.filter(h => h.card !== p.region).slice(0, PROBE_HIDES);
        if (!others.length) return line;
        const box = el('div', '');
        box.appendChild(line);
        others.forEach((h) => {
            const card = suggest.card(h.card);
            const row = el('div', 'verdict', t('probe.hides', {
                h: formatInt(h.n),
                l: this.c.nameOf(a.scans[h.scan]),
                w: this.c.nameOf(a.scans[card.region.winner])
            }));
            row.append(' ', link(h.card, 'probe.card'));
            box.appendChild(row);
        });
        return box;
    }

    private verdictText(p: CellProbe, own: { card: number, scan: number, n: number } | null = null): { text: string, phrase?: boolean } {
        const a = this.c.suggest.analysis;
        const name = (s: number) => this.c.nameOf(a.scans[s]);
        const present = p.scans.filter(s => s.present);
        if (p.cell < 0 || !present.length) return { text: t('probe.empty') };
        if (present.length === 1) return { text: t('probe.single', { name: name(present[0].scan) }) };
        if (p.state === CellState.apart) {
            return { text: t('probe.apart', { d: this.apartText(this.clusterAt(p.cell, 'apart')?.value) }) };
        }
        // the finer scan has no surface near the coarser one's splats here:
        // they stay, and nothing points to a misalignment (no align hint)
        // unless the cell's card hides some of them all the same (the blur
        // haze: coarse splats on or in front of the winner's surface)
        if (p.state === CellState.uncovered) {
            const card = own ? this.c.suggest.card(own.card) : null;
            if (!card) return { text: t('probe.uncovered') };
            return { text: t('probe.uncovered-haze', { h: formatInt(own.n), l: name(own.scan), w: name(card.region.winner) }) };
        }
        const best = (test: (q: ProbePair) => boolean) => {
            let pick: ProbePair = null;
            p.pairs.forEach((q) => {
                if (test(q) && (!pick || q.lead > pick.lead)) pick = q;
            });
            return pick;
        };
        if (p.owner >= 0 && (p.state === CellState.strong || p.state === CellState.weak)) {
            const win = best(q => q.winner === p.owner && (q.strong || q.weak));
            // finer here, but in no suggestion: the area is too small (listed
            // under "Nicht vorgeschlagen", or below its 4-cell minimum), or
            // has too few clearly finer cells; say so, else the verdict reads
            // "deutlich feiner" with no card and no reason
            if (p.region < 0) {
                const few = this.clusterAt(p.cell, 'small')?.few;
                return { text: t(few ? 'probe.finer-few' : 'probe.finer-small', { name: name(p.owner), f: formatFactor(2 ** (win ? win.lead : 0)) }) };
            }
            return { text: t(p.state === CellState.strong ? 'probe.finer' : 'probe.somewhat', { name: name(p.owner), f: formatFactor(2 ** (win ? win.lead : 0)) }), phrase: true };
        }
        // a region dropped as a whole (compose-detail's loserCheck: over all
        // its hide cells the loser is hardly coarser, or the winner is too
        // sparse) is listed under "Nicht vorgeschlagen" with its cells as
        // ties or sparse ones, which may pass on their own: the verdict then
        // says what the list says, not the cell's own lead
        if (p.state === CellState.tie) {
            const equal = this.clusterAt(p.cell, 'equal');
            if (equal && equal.winner >= 0) return { text: this.equalText(equal, 'probe.equal-area', { w: name(equal.winner) }) };
            const top = best(q => q.evidence);
            return { text: t('probe.equal', { f: formatFactor(2 ** Math.max(0, top ? top.lead : 0)) }), phrase: true };
        }
        if (p.state === CellState.partial || p.state === CellState.sparse || p.state === CellState.texture) {
            const reason = p.state === CellState.partial ? 'partial' : p.state === CellState.sparse ? 'sparse' : 'texture';
            const fail = best(q => q.reason === reason);
            if (fail) {
                const names = { w: name(fail.winner), l: name(fail.loser) };
                if (reason !== 'partial') return { text: t(reason === 'sparse' ? 'probe.sparse' : 'probe.texture-fail', names) };
                // too little of the winner's surface lies on the loser's, or
                // the winner covers too little of the loser's surface
                return { text: fail.gate === 'onsurf' ? t('probe.onsurf', { ...names, v: percent(fail.onsurf) }) : t('probe.partial', { ...names, v: percent(fail.cover) }) };
            }
            const sparse = reason === 'sparse' ? this.clusterAt(p.cell, 'sparse') : null;
            if (sparse && sparse.winner >= 0) return { text: t('probe.sparse-area', { w: name(sparse.winner) }) };
        }
        return { text: t('probe.thin') };
    }

    // the listed rejected cluster of this reason that holds a cell
    private clusterAt(cell: number, reason: Rejected['reason']) {
        return this.c.suggest.analysis.detail.rejected.find(r => r.reason === reason && r.cells.includes(cell)) ?? null;
    }

    // an 'equal' cluster's text (skip list, probe): its value is W's lead
    // over all hide cells in octaves. At 0 or below (museum 1<->3: 6 of its
    // 18 clusters, down to -0.47 = 0.72×) W is not finer there at all, and
    // "kaum feiner (0,7×)" would contradict itself: the "-none" key has no
    // factor
    private equalText(r: Rejected, key: string, options: Record<string, unknown> = {}) {
        return r.value > 0 ? t(key, { ...options, f: formatFactor(2 ** r.value) }) : t(`${key}-none`, options);
    }

    // ------------------------------------------------------------ step 4

    buildSuggest(body: HTMLElement) {
        const { suggest, events } = this.c;
        const a = suggest.analysis;
        const busy = this.c.busy();
        body.appendChild(el('div', 'compose-hint', t('suggest.hint')));
        if (!a) {
            body.appendChild(el('div', 'compose-note', t('suggest.none-yet')));
            this.nav(body, t('suggest.back'), 'analyse', this.gapsNext());
            return;
        }
        const stale = suggest.isStale();
        if (stale) body.appendChild(el('div', ['compose-note', 'warn'], t('analyse.stale')));

        const cards = a.cards;
        const accepted = cards.filter(c => c.status === 'accepted').length;
        const rejected = cards.filter(c => c.rejected).length;
        const hidden = cards.reduce((sum, c) => sum + c.locked, 0);
        body.appendChild(el('div', 'compose-note', t('suggest.summary', { count: cards.length, n: cards.length, a: accepted, r: rejected, h: formatInt(hidden) })));

        const display = el('div', 'compose-row');
        display.appendChild(el('span', 'compose-label', t('suggest.display')));
        display.appendChild(segmented([
            { value: 'normal', text: t('suggest.display-normal') },
            { value: 'mark', text: t('suggest.display-mark') }
        ], suggest.display, (v: string) => events.fire('compose.setDisplay', v), t('suggest.display-tip'), 'display'));
        body.appendChild(display);

        this.shownIds.clear();
        const base = cards.filter(c => c.region.scope === 'base');
        if (base.length) {
            body.appendChild(el('div', 'compose-subheading', t('suggest.base-title')));
            base.forEach((card) => {
                body.appendChild(el('div', 'compose-note', this.baseText(card)));
                body.appendChild(this.cardView(card, stale, busy));
                this.shownIds.add(card.id);
            });
        }
        const local = cards.filter(c => c.region.scope !== 'base');
        // ticked and open: what "Angehakte übernehmen" takes
        const takes = (c: Card) => c.ticked && suggest.tickable(c);
        if (local.length) {
            if (base.length) body.appendChild(el('div', 'compose-subheading', t('suggest.local-title')));
            if (local.length > 1) body.appendChild(this.tickAllRow(local, stale));
            const shown = this.showAll ? local : local.slice(0, CARDS_SHOWN);
            shown.forEach((card) => {
                body.appendChild(this.cardView(card, stale, busy));
                this.shownIds.add(card.id);
            });
            const rest = local.slice(shown.length);
            if (rest.length) {
                const splats = rest.reduce((sum, c) => sum + this.hiddenOf(c), 0);
                const more = el('div', 'compose-row');
                more.appendChild(button(t('suggest.more', { count: rest.length, splats: formatInt(splats), ticked: rest.filter(takes).length }), () => {
                    this.showAll = true;
                    this.c.onChange();
                }, ['small'], undefined, 'more'));
                body.appendChild(more);
            }
        }
        if (!cards.length) body.appendChild(el('div', 'compose-note', t('suggest.empty')));

        if (cards.length) {
            const ticked = cards.filter(takes).length;
            const footer = el('div', 'compose-row');
            footer.appendChild(button(t('suggest.accept-ticked', { n: ticked }), () => events.invoke('compose.accept', 'ticked'),
                ['primary', ...(!ticked || stale || busy ? ['disabled'] : [])], stale ? t('analyse.stale') : undefined, 'accept-ticked'));
            // like each card's "Zurücknehmen": something compose hid is still
            // hidden, in an instance list the analysis still fits
            footer.appendChild(button(t('suggest.revert-all'), () => events.invoke('compose.revert', 'all'),
                [...(!cards.some(c => suggest.canRevert(c.id)) || busy ? ['disabled'] : [])], undefined, 'revert-all'));
            body.appendChild(footer);
            body.appendChild(el('div', 'compose-note', t('suggest.note-export')));
            body.appendChild(el('div', 'compose-note', t('suggest.note-unhide')));
        }

        this.skipList(body, stale, busy);

        this.nav(body, t('suggest.back'), 'analyse', this.gapsNext());
        body.appendChild(el('div', 'compose-note', t('later')));

        // a card opened from a pill or the probe, or made with "Trotzdem
        // übernehmen": looked up again at the next frame (a rebuild in
        // between replaces it), and only the panel scrolls
        if (this.scrollTo >= 0) {
            const id = this.scrollTo;
            this.scrollTo = -1;
            requestAnimationFrame(() => {
                const target = body.querySelector<HTMLElement>(`[data-card="${id}"]`);
                if (target) scrollIntoPanel(target);
            });
        }
    }

    private gapsNext() {
        return { step: 'gaps', text: t('next', { step: t('step.gaps') }), disabled: true, title: t('step-later') };
    }

    private hiddenOf(card: Card) {
        return card.region.perLoser.reduce((sum, p) => sum + (p.hidden ?? 0), 0);
    }

    // "Alle anhaken" at the head of the local cards: ticked when all open
    // ones are, mixed when some are; a click ticks them all (the folded ones
    // too), or unticks them when all were
    private tickAllRow(local: Card[], stale: boolean) {
        const { suggest, events } = this.c;
        const open = local.filter(c => suggest.tickable(c));
        const ticked = open.filter(c => c.ticked).length;
        const row = el('label', ['compose-row', 'compose-tick-all']);
        row.title = t('suggest.tick-all-tip');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = open.length > 0 && ticked === open.length;
        box.indeterminate = ticked > 0 && ticked < open.length;
        box.disabled = !open.length || stale;
        box.dataset.key = 'tick-all';
        box.addEventListener('change', () => events.fire('compose.tickAll', ticked < open.length));
        row.append(box, el('span', '', t('suggest.tick-all', { n: ticked, m: open.length })));
        return row;
    }

    // the text above a large-area card: its share of the pair's shared cells
    private baseText(card: Card) {
        const a = this.c.suggest.analysis;
        const r = card.region;
        const W = r.winner, L = r.losers[0];
        const pair = a.detail.pairs.find(p => (p.a === W && p.b === L) || (p.a === L && p.b === W));
        let inPair = 0;
        r.cells.forEach((g) => {
            const pm = a.detail.present[g];
            if ((pm >> W) & 1 && (pm >> L) & 1) inPair++;
        });
        return t('suggest.base-text', {
            w: this.c.nameOf(a.scans[W]),
            p: percent(pair?.sharedCells ? inPair / pair.sharedCells : 0),
            f: formatFactor(2 ** r.lead),
            l: r.losers.map(l => this.c.nameOf(a.scans[l])).join(', ')
        });
    }

    private cardView(card: Card, stale: boolean, busy: boolean) {
        const { suggest, events } = this.c;
        const a = suggest.analysis;
        const r = card.region;
        const scale = this.c.sceneScale();
        const W = a.scans[r.winner];
        const losers = r.losers.map(l => this.c.nameOf(a.scans[l])).join(', ');
        const accepted = card.status === 'accepted';
        // hidden by hand already (never with accepted): nothing to accept,
        // and 'before' would draw a hole
        const hand = card.handHidden;
        const handTip = hand ? t('card.hand-tip') : undefined;
        const box = el('div', ['compose-card', card.rejected ? 'rejected' : accepted ? 'accepted' : hand ? 'hand' : card.status === 'partly' ? 'partial' : '',
            suggest.picked === card.id ? 'picked' : '']);
        box.style.borderLeftColor = this.c.colorOf(W);
        box.dataset.card = String(card.id);
        box.addEventListener('pointerenter', () => events.fire('compose.hover', card.id));
        box.addEventListener('pointerleave', () => events.fire('compose.hover', null));
        box.addEventListener('click', e => this.pickCard(box, card.id, e));
        // a stable name per control of this card (focus after a rebuild)
        const key = (action: string) => `card:${card.id}:${action}`;

        const head = el('div', 'compose-card-head');
        if (!card.rejected) {
            const tick = document.createElement('input');
            tick.type = 'checkbox';
            tick.checked = card.ticked;
            tick.disabled = !suggest.tickable(card) || stale;
            tick.title = handTip ?? t('card.tick-tip');
            tick.dataset.key = key('tick');
            tick.addEventListener('change', () => events.fire('compose.tick', card.id, tick.checked));
            head.appendChild(tick);
        }
        head.appendChild(el('span', ['compose-badge', 'num'], String(card.id + 1)));
        const title = el('span', 'compose-card-title', t('card.replaces', { w: this.c.nameOf(W), l: losers }));
        title.title = t('card.pick-tip');
        head.appendChild(title);
        if (card.rejected) {
            box.appendChild(head);
            const status = el('div', 'compose-card-status');
            status.appendChild(el('span', '', t('card.rejected')));
            status.appendChild(button(t('card.restore'), () => events.fire('compose.restore', card.id), ['small'], undefined, key('restore')));
            box.appendChild(status);
            return box;
        }
        if (r.scope === 'base') head.appendChild(el('span', ['compose-badge', 'base'], t('card.base')));
        const clear = r.confidence === 'clear';
        head.appendChild(el('span', ['compose-badge', clear ? 'clear' : 'check'], t(clear ? 'card.clear' : 'card.check')));
        head.appendChild(button('⌖', () => {
            this.markPicked(box);
            events.fire('compose.focusSuggestion', card.id);
        }, ['small'], t('card.fly-tip'), key('fly')));
        box.appendChild(head);

        box.appendChild(el('div', 'compose-info', t(r.shape === 'surface' ? 'card.surface' : 'card.object', { dims: formatDims(r.dims, scale) })));

        r.perLoser.forEach((pl) => {
            const name = this.c.nameOf(a.scans[pl.scan]);
            if (r.losers.length > 1) box.appendChild(el('div', 'compose-subheading', t('card.loser', { name })));
            box.appendChild(this.checklist(card, pl));
            // what of the loser stays in the area: the splats the winner has
            // nothing next to, and the held ones - covered, but where the
            // winner is hardly finer on its own (compose-detail holdOwn)
            // hidden includes the blur haze (compose-detail DETAIL haze):
            // coarse splats on or in front of the winner's surface, also in
            // the cells around the area
            const names = { n: formatInt(pl.hidden ?? 0), l: name, k: formatInt(pl.kept ?? 0), w: this.c.nameOf(W) };
            const effect = [pl.haze > 0 ? t('card.effect-haze', { ...names, m: formatInt(pl.haze) }) : t('card.effect', names)];
            if (pl.held > 0) effect.push(t('card.effect-held', { h: formatInt(pl.held), w: this.c.nameOf(W) }));
            const line = el('div', 'compose-effect', effect.join(' · '));
            if (pl.haze > 0) line.title = t('card.haze-tip', { l: name, w: this.c.nameOf(W) });
            box.appendChild(line);
        });

        // the revert shows again what compose hid (hidden by hand: only when
        // compose hid some of it)
        if (accepted || hand || card.status === 'partly') {
            const status = el('div', 'compose-card-status');
            status.appendChild(el('span', '', t(accepted ? 'card.accepted' : hand ? 'card.hand' : 'card.partly')));
            if (!hand || card.locked > 0) {
                status.appendChild(button(t('card.revert'), () => events.invoke('compose.revert', card.id),
                    ['small', ...(!suggest.canRevert(card.id) || busy ? ['disabled'] : [])], accepted ? t('card.accepted-tip') : undefined, key('revert')));
            }
            box.appendChild(status);
        }

        const actions = el('div', 'compose-row');
        const current = suggest.preview?.id === card.id ? suggest.preview.mode : null;
        actions.appendChild(segmented([
            { value: 'before', text: t('card.before'), disabled: accepted || hand, title: accepted ? t('card.accepted-tip') : handTip },
            { value: 'after', text: t('card.after') }
        ], current, (v: string) => events.fire('compose.preview', current === v ? null : card.id, v), t('card.preview-tip'), key('preview')));
        // while this card's preview is up the selection is not drawn (see
        // ComposeSuggest.selectionHidden); unticked, it draws again
        if (current) actions.appendChild(this.selectionToggle(key('hide-selection')));
        // an accepted card is reverted first (rejecting would leave it hidden)
        if (!accepted) {
            actions.appendChild(button(t('card.select'), () => events.fire('compose.selectSuggestion', card.id), ['small'], t('card.select-tip'), key('select')));
            if (card.status === 'open') actions.appendChild(button(t('card.reject'), () => events.fire('compose.reject', card.id), ['small'], undefined, key('reject')));
            actions.appendChild(button(t('card.accept'), () => events.invoke('compose.accept', [card.id]),
                ['small', 'primary', ...(stale || busy || hand ? ['disabled'] : [])], stale ? t('analyse.stale') : handTip, key('accept')));
        }
        box.appendChild(actions);
        return box;
    }

    // a click on a card's text or head (not on one of its controls, not the
    // end of a text selection) marks it as the picked card and flies the
    // camera to its region
    private pickCard(box: HTMLElement, id: number, e: MouseEvent) {
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('.compose-button, .compose-seg, .compose-link, input, label, select, textarea, a, [role="button"]')) return;
        const selected = window.getSelection?.();
        if (selected && !selected.isCollapsed && box.contains(selected.anchorNode)) return;
        this.markPicked(box);
        this.c.suggest.pick(id);
    }

    private markPicked(box: HTMLElement) {
        box.parentElement?.querySelectorAll('.compose-card.picked').forEach(c => c !== box && c.classList.remove('picked'));
        box.classList.add('picked');
    }

    // "Auswahl ausblenden" next to Vorher/Nachher, ticked by default: the
    // preview shows the scene without the selection drawn over it
    private selectionToggle(key: string) {
        const { suggest, events } = this.c;
        const label = el('label', 'compose-hide-selection');
        label.title = t('card.hide-selection-tip');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !suggest.showSelection;
        box.dataset.key = key;
        box.addEventListener('change', () => events.fire('compose.setShowSelection', !box.checked));
        label.append(box, el('span', '', t('card.hide-selection')));
        return label;
    }

    // ✓ pass, ✗ fail, · info, against the strong pair gates and the 'clear'
    // register limit. A card made with "Trotzdem übernehmen" keeps the check
    // its cluster failed (cell by cell) as ✗, whatever the region as a whole
    // gives, and says where it came from. That line shows the number it
    // failed on, the cluster's own (Card.forcedValue), next to the region's
    // when that one passes (bus fine grid, lead 1.4×, the 7-cell texture
    // cluster: colour detail 0.94× for the region, 0.23× cell by cell), so
    // the ✗ does not stand next to a passing number alone
    private checklist(card: Card, pl: LoserNumbers) {
        const a = this.c.suggest.analysis;
        const r = card.region;
        const scale = this.c.sceneScale();
        const wName = this.c.nameOf(a.scans[r.winner]);
        const lName = this.c.nameOf(a.scans[pl.scan]);
        const list = el('div', 'compose-checks');
        const line = (state: 'pass' | 'fail' | 'info', text: string) => {
            const row = el('div', ['compose-check', state]);
            row.append(el('span', 'compose-check-mark', state === 'pass' ? '✓' : state === 'fail' ? '✗' : '·'), el('span', '', text));
            list.appendChild(row);
        };
        line(pl.lead >= a.detail.lead * DETAIL.weakLead ? 'pass' : 'fail', t('check.finer', {
            w: splatLen(pl.sizeW, scale),
            l: splatLen(pl.sizeL, scale),
            f: formatFactor(pl.sizeL / pl.sizeW)
        }));
        const forced = card.forcedReason;
        // the forced check's text: the region's number when it fails too (it
        // explains the ✗ itself), both when it passes, the cluster's alone
        // when the region has none
        const forcedText = (key: string, region: number, fails: boolean, options: Record<string, unknown>) => {
            const cells = card.forcedValue;
            if (!Number.isFinite(cells) || (Number.isFinite(region) && fails)) return t(key, { ...options, f: formatFactor(region) });
            if (!Number.isFinite(region)) return t(key, { ...options, f: formatFactor(cells) });
            return t(`${key}-forced`, { ...options, f: formatFactor(region), c: formatFactor(cells) });
        };
        if (Number.isFinite(pl.density) || forced === 'sparse') {
            const fails = pl.density < DETAIL.densityStrong;
            line(forced === 'sparse' || fails ? 'fail' : 'pass', forced === 'sparse' ?
                forcedText('check.density', pl.density, fails, {}) :
                t('check.density', { f: formatFactor(pl.density) }));
        }
        if (Number.isFinite(pl.texture) || forced === 'texture') {
            const veto = pl.tauL >= DETAIL.textureMin && pl.texture < DETAIL.textureRatio;
            const options = { l: lName, tl: percent(pl.tauL), w: wName, tw: percent(pl.tauW) };
            line(veto || forced === 'texture' ? 'fail' : 'pass', forced === 'texture' ?
                forcedText('check.texture', pl.texture, veto, options) :
                t('check.texture', { ...options, f: formatFactor(pl.texture) }));
        }
        if (Number.isFinite(pl.cover)) line(pl.cover >= DETAIL.coverStrong ? 'pass' : 'fail', t('check.cover', { v: percent(pl.cover), l: lName }));
        if (Number.isFinite(pl.sep50)) line(pl.sep50 <= DETAIL.clearSep * a.cell ? 'pass' : 'fail', t('check.register', { d: this.c.len(pl.sep50) }));
        if (Number.isFinite(pl.big)) line('info', t('check.big', { l: lName, v: percent(pl.big) }));
        const b = biasOf(a.detail, r.winner, pl.scan);
        if (Math.abs(b) >= BIAS_SHOWN) {
            line('info', t('check.bias', { name: b > 0 ? wName : lName, f: formatFactor(2 ** Math.abs(b)), h: formatFactor(2 ** pl.lead) }));
        }
        if (forced) line('info', t('check.forced', { reason: t(forced === 'sparse' ? 'skip.sparse' : 'skip.texture') }));
        return list;
    }

    private skipList(body: HTMLElement, stale: boolean, busy: boolean) {
        const { suggest, events } = this.c;
        const a = suggest.analysis;
        const list = a.detail.rejected.slice(0, SKIP_SHOWN);
        if (!list.length) return;
        body.appendChild(el('div', 'compose-subheading', t('skip.title')));
        list.forEach((r, index) => {
            const row = el('div', ['compose-skip', `r-${r.reason}`]);
            // keyed by the cluster, not its place in the list: after
            // "Trotzdem übernehmen" removes a row, the focus must not land
            // on the same button of the row that moves up (a second Space
            // would force that one too)
            const key = (action: string) => `skip:${r.reason}:${r.winner}:${r.loser}:${r.cells.length ? r.cells[0] : -1}:${action}`;
            if (r.winner >= 0) row.appendChild(swatch(this.c.colorOf(a.scans[r.winner]), 'compose-dot'));
            if (r.loser >= 0) row.appendChild(swatch(this.c.colorOf(a.scans[r.loser]), 'compose-dot'));
            row.appendChild(el('span', 'compose-zone-text', this.skipText(r)));
            row.appendChild(button('⌖', () => suggest.focusRejected(index), ['small'], t('card.fly-tip'), key('fly')));
            // texture and sparse misses only (a sparse one may be a whole
            // region the loser check dropped); an 'equal' one has no lead
            // worth forcing
            if ((r.reason === 'texture' || r.reason === 'sparse') && r.winner >= 0 && r.loser >= 0) {
                row.appendChild(button(t('skip.force'), () => events.fire('compose.force', index), ['small', ...(stale || busy ? ['disabled'] : [])], t('skip.force-tip'), key('force')));
            }
            if (r.reason === 'apart') {
                const target = suggest.alignTarget(index);
                if (target) {
                    row.appendChild(button(t('zone.here'), () => events.invoke('compose.alignAt', target, r.centre), ['small', ...(busy ? ['disabled'] : [])], t('zone.here-tip'), key('align')));
                }
            }
            this.hoverable(row, index);
            body.appendChild(row);
        });
    }

    // the reason, and what cards hide in the cluster's cells all the same:
    // not suggested itself, but a card's ring or blur haze (compose-detail
    // DETAIL haze, up to 6 cells around its area) may reach in
    private skipText(r: Rejected) {
        const { suggest } = this.c;
        const a = suggest.analysis;
        const hides = suggest.hidesIn(r.cells).slice(0, SKIP_HIDES).map(h => t('skip.edge', {
            n: h.card + 1,
            h: formatInt(h.n),
            l: this.c.nameOf(a.scans[h.scan])
        }));
        return [this.skipReason(r), ...hides].join(' · ');
    }

    private skipReason(r: Rejected) {
        const a = this.c.suggest.analysis;
        const w = r.winner >= 0 ? this.c.nameOf(a.scans[r.winner]) : '';
        const l = r.loser >= 0 ? this.c.nameOf(a.scans[r.loser]) : '';
        const pair = w && l ? `${t('skip.pair', { w, l })} ` : '';
        // partial: the value is the share of the gate that failed
        if (r.reason === 'partial') return t(r.gate === 'onsurf' ? 'skip.onsurf' : 'skip.partial', { w, l, v: percent(r.value) });
        if (r.reason === 'sparse') return `${pair}${t('skip.sparse')}`;
        if (r.reason === 'texture') return `${pair}${t('skip.texture')}`;
        if (r.reason === 'apart') return `${pair}${t('skip.apart', { d: this.apartText(r.value) })}`;
        // a region the loser check dropped: its lead over all hide cells
        // (octaves, may be 0 or below, see equalText)
        if (r.reason === 'equal') return `${pair}${this.equalText(r, 'skip.equal')}`;
        return `${pair}${t(r.few ? 'skip.few' : 'skip.small')}`;
    }

    // the separation of an apart cluster: its own median plane distance over
    // its apart cells; unknown, or (rarely, the median of pooled cells) not
    // above the apart limit, it reads "> c/6"
    private apartText(value: number) {
        const a = this.c.suggest.analysis;
        const limit = DETAIL.apartSep * a.cell;
        return Number.isFinite(value) && value > limit ? this.c.len(value) : `> ${this.c.len(limit)}`;
    }

    // hovering a rejected cluster outlines it in the view
    private hoverable(row: HTMLElement, index: number) {
        row.addEventListener('pointerenter', () => this.c.suggest.setHover({ kind: 'skip', index }));
        row.addEventListener('pointerleave', () => this.c.suggest.setHover(null));
    }

    private nav(body: HTMLElement, backText: string, back: string, next: { step: string, text: string, disabled?: boolean, title?: string } | null) {
        const { events } = this.c;
        // keyed per step: after a step change the focus does not land on the
        // new step's navigation
        const step = this.c.step();
        const nav = el('div', 'compose-row');
        nav.appendChild(button(backText, () => events.fire('compose.setStep', back), [], undefined, `nav:${step}:back`));
        if (next) {
            nav.appendChild(button(next.text, () => events.fire('compose.setStep', next.step), ['primary', ...(next.disabled ? ['disabled'] : [])], next.title, `nav:${step}:next`));
        }
        body.appendChild(nav);
    }

    // ------------------------------------------------------------ viewport

    // show a card in step 4 (unfolded) and fly there
    open(id: number) {
        if (!this.reveal(id)) return;
        this.c.events.fire('compose.focusSuggestion', id);
        if (this.c.step() !== 'suggest') this.c.events.fire('compose.setStep', 'suggest');
        else this.c.onChange();
    }

    // the next build of step 4 shows the card: the list unfolds when it lies
    // past the fold (with more than CARDS_SHOWN local cards a forced card is
    // appended there: Steinbeis card 100 behind "+70 kleinere"), and the
    // panel scrolls to it
    private reveal(id: number) {
        const a = this.c.suggest.analysis;
        if (!a) return false;
        const local = a.cards.filter(c => c.region.scope !== 'base');
        if (local.findIndex(c => c.id === id) >= CARDS_SHOWN) this.showAll = true;
        this.scrollTo = id;
        return true;
    }

    // pills "n · f×" over the region markers of the cards in the panel
    updatePills(overlay: HTMLElement, show: boolean, w: number, h: number, project: (p: number[], w: number, h: number) => Projected) {
        const { suggest, events } = this.c;
        const a = suggest.analysis;
        const cards = show && a && this.c.step() === 'suggest' && !suggest.staleState ? a.cards.filter(c => !c.rejected && this.shownIds.has(c.id)) : [];
        let i = 0;
        for (const card of cards) {
            let pill = this.pills[i];
            if (!pill) {
                const created = document.createElement('div');
                created.addEventListener('click', () => this.open(Number(created.dataset.card)));
                created.addEventListener('pointerenter', () => events.fire('compose.hover', Number(created.dataset.card)));
                created.addEventListener('pointerleave', () => events.fire('compose.hover', null));
                overlay.appendChild(created);
                this.pills.push(created);
                pill = created;
            }
            const r = card.region;
            const p = project(r.marker, w, h);
            // one far outside the view would widen the scroll area of the
            // canvas container (Steinbeis: pills at up to 6,241 px, scroll
            // height 6,299 against 872); the overlay clips too (scss)
            pill.style.display = inView(p, w, h) ? '' : 'none';
            pill.style.left = `${p.x}px`;
            pill.style.top = `${p.y}px`;
            pill.style.borderColor = this.c.colorOf(a.scans[r.winner]);
            const accepted = card.status === 'accepted';
            // grey once nothing is left to do: accepted (with ✓), or hidden
            // by hand already
            const cls = `compose-pill ${accepted || card.handHidden ? 'accepted' : r.confidence === 'clear' ? 'clear' : 'check'}`;
            if (pill.className !== cls) pill.className = cls;
            const text = `${accepted ? '✓ ' : ''}${card.id + 1} · ${formatFactor(2 ** r.lead)}×`;
            if (pill.textContent !== text) pill.textContent = text;
            // checked every frame: a renamed layer changes it without a new text
            const title = t('card.replaces', { w: this.c.nameOf(a.scans[r.winner]), l: r.losers.map(l => this.c.nameOf(a.scans[l])).join(', ') });
            if (pill.title !== title) pill.title = title;
            pill.dataset.card = String(card.id);
            i++;
        }
        for (; i < this.pills.length; i++) this.pills[i].style.display = 'none';
    }

    // the dashed box of the hovered card or rejected cluster
    hoverBox(): Box | null {
        const { suggest } = this.c;
        const a = suggest.analysis;
        const hover = suggest.hover;
        if (!a || !hover) return null;
        if (hover.kind === 'card') {
            const card = suggest.card(hover.id);
            return card ? { min: card.region.min, max: card.region.max, color: this.c.colorOf(a.scans[card.region.winner]) } : null;
        }
        const r = a.detail.rejected[hover.index];
        if (!r) return null;
        return { min: r.min, max: r.max, color: r.winner >= 0 ? this.c.colorOf(a.scans[r.winner]) : '#ff6b6b' };
    }

    // a new analysis starts folded
    reset() {
        this.showAll = false;
        this.scrollTo = -1;
    }
}

export { SuggestPanel, type PanelContext };
