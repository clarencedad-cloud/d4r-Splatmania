// Scan composition, phase 2: which scan is finer where, and what replacing the
// coarser version means in splats ("Feinere Splats mit Deckungsnachweis").
// Pure typed-array code like compose-core, so it runs in the analysis worker
// and in node tests (scripts/test-compose-detail.mjs). Deterministic: every
// loop runs in ascending key / index order, ties are broken explicitly.
//
// 1. scanCells (one per scan): every row into one shared grid of cells of
//    edge c: opaque count, a size histogram, colour-detail sums and a 4x4x4
//    sub-voxel occupancy mask (big splats mark the area they cover).
// 2. composeDetail (all scans): per cell where 2+ scans have surface, which
//    one is clearly finer - smaller splats, at least as dense, not less colour
//    detail, on the same surface (masks) - pooled over the 3x3x3 cells where a
//    scan has too few splats there. Then regions of one finer scan, their
//    losers and numbers, the rejected clusters, the general difference per
//    pair.
// 3. paintInputs (main thread) gathers the rows per region, composePaint
//    proves cover per loser splat at full resolution (the winner must have its
//    own splats on that spot, at half its usual density) and applyPaint turns
//    that into one Uint16 per row (id + 1, 0x8000 = kept).
//
// Positions are world space. Sizes are footprints: sqrt(largest * middle
// scale), the quality-score sizeOf definition. Leads are in octaves (log2).

import { decode, keyOf, robustBox, spacingOf } from './compose-core';
import { smallestEigenvector } from '../align/icp';

type V3 = [number, number, number];

// ---------------------------------------------------------------- constants

// All lengths are relative to the cell edge c or to measured splat sizes, so
// they work in metric and in unit-less scenes. The measured figures come from
// read-only probes on the Steinbeis, museum and bus scans (FORK-NOTES).
const DETAIL = {
    // opacity from which a splat counts as surface (statistics, masks, winner
    // points): 67-80 % of real splats pass, faint dust and haze drop out.
    // Paint candidates still include every opacity.
    opaque: 0.2,

    // auto grid: the smallest nice cell at which the splat-weighted median
    // count of opaque splats per occupied cell is at least autoTarget in every
    // scan (on at most autoSamples opaque samples per scan), clamped to
    // [diagonal / 600, diagonal / 60]
    autoTarget: 40,
    autoSamples: 200000,
    autoDiagMin: 1 / 600,
    autoDiagMax: 1 / 60,
    // panel options: 'Fein' = nice(0.7 c), 'Grob' = nice(1.4 c)
    fine: 0.7,
    coarse: 1.4,

    // presence and evidence: a scan is present in a cell with at least 2
    // opaque splats there; a cell would decide alone when every present scan
    // has `single` there, else the 3x3x3 cells are pooled. The design's 30
    // is off (Infinity, always pooled): a surface within a few cm of a cell
    // boundary lands in different cells per scan when they are 1-2 cm
    // apart (synthetic drift of 0.1 degree at a piece end: 197 rows of one
    // scan by position vs 135 by source in one cell), so a cell alone saw
    // fake leads of 1.5-1.9x (regions with 98 % neutral rows); pooled, both
    // scans' surfaces are in the 27 cells. A winner needs 40 pooled
    // splats, a loser 20 (cell medians have a standard error of about
    // 0.89 / sqrt(n) octave: 0.25 octave on the lead at 40 / 20) - or only 4
    // when the winner has 8x as many (very rough versions must be replaceable)
    present: 2,
    single: Infinity,
    // a cell would pool only its 6 face neighbours (7 cells) when every
    // present scan has this many opaque splats there - sharper for objects of
    // 3-4 cells (1 m balls at 25 cm: lead p50 0.74 octave over 27 cells for a
    // true 1.29). Off (Infinity): at 30 it brought the boundary artefact back
    // (3-piece cases 22-37 % neutral hidden rows instead of 3-9 %)
    facePool: Infinity,
    // a strong win must be confirmed cell by cell (confirm 1): its lead is
    // at most the weighted median of the pair's per-cell leads (cell median
    // of L - cell median of W over the pooled cells both have splats in)
    // plus confirmMargin * the strong lead, so the per-cell leads must reach
    // half the strong lead - or the decided cell alone (confirmCentre opaque
    // splats of each scan there) the full one. Weak wins, which only grow
    // regions from strong seeds, keep the pooled lead (confirmWeak 0).
    // Why: with fixed 27-cell pools a dense surface just inside the pool for
    // one scan and just outside for the other (scans 1-3 cm apart) moves the
    // pooled medians by 0.5-1.3 octave between equally fine scans; the
    // per-cell leads stay at 0 there (each comparison stays in one cell),
    // and their own artefact (a surface crossing a cell face) sits in other
    // cells than the pool's. Measured, bus twin + offset (piece 2 = piece 1
    // moved up; 2 pieces x 3 seeds): suggestions between the twins with the
    // pooled lead alone (confirm 0) 1.5 cm: 0/0/3, 3 cm: 1/3/3, at a fixed
    // 20 cm grid 3 cm: 3/3/3; confirmed: 0 in every case, also at 15 / 20 cm
    // grids and 5 cm. The per-cell leads on true strong cells (bus pieces,
    // 2-3 pieces): p5 0.67-1.06 octave; on the twin artefact cells p50
    // 0.00-0.21. Weights (confirmArea): 1 the smaller sub-voxel count of the
    // two scans in the cell, 0 the smaller opaque count; LOD box 2 hides
    // 66.9 % with 1, 64.8 % with 0 (66.95 % unconfirmed). Margin 0.35: LOD
    // box 1 74.7 / box 2 60.2 %; 0.5: 79.2 / 66.9 %; 0.65: 78.9 / 67.0 %
    // (twins 0 for all). Tried and worse: matched pools (every pooled cell
    // with the smallest opaque count of the present scans) - a surface
    // crossing an inner cell face no longer cancels, twins got one
    // suggestion each (99.9 % neutral, 72 567 rows); the per-cell leads alone
    // - twins 1 suggestion each, LOD 56 / 51 % (count) or 71 / 63 % (area);
    // min(pooled, per-cell) - twins 0, LOD 56 / 51 %. Confirming weak wins
    // too (confirmWeak 1) cut region borders at stretch ends: bus 18 cases
    // mean recall 74.9 % (3 pieces #5: 75.6 -> 69.3 %) against 75.4 % with
    // 0, unconfirmed 75.4 %; twins 0 either way. The decided cell
    // (confirmCentre 20, the loser's evidence): 3 pieces #4 recall 78.6 ->
    // 81.4 %, twins 0; it cannot save 1 m balls on forced 60-80 cm grids,
    // which got their 3 strong cells from the boundary artefact (focus balls
    // 18/30 -> 13/30, all misses at 40-80 cm)
    confirm: 1,
    confirmArea: 1,
    confirmMargin: 0.5,
    confirmCentre: 20,
    confirmWeak: 0,
    // a weak win could also need the decided cell's own lead (count medians
    // of the cell alone) to reach weakOwn * the strong lead (-Infinity:
    // off). It cuts the overgrowth holdOwn keeps from being hidden (bus 18
    // cases with 0.25: wrong 3.29 -> 1.83 %, neutral 15.11 -> 8.32 %), but it
    // changes the regions: a region loserCheck had dropped (its weak cells
    // diluted the lead) passes once they are gone and brings boundary cells
    // with it (2 pieces #3: +10 wrong rows, #4: +2; every value 0-0.5 has a
    // case like that), focus balls 12/30 from 0.3, and the real pairs lose
    // suggestions (Steinbeis 40.82 -> 34.27 %, museum 1<->2 56.86 -> 50.48 % of
    // the shared cells). Off; holdOwn keeps the regions
    weakOwn: -Infinity,
    minWinner: 40,
    minLoser: 20,
    roughMin: 4,
    roughRatio: 8,

    // lead: 'clearly finer' from this factor (panel 1.4 / 1.6 / 2); weak wins
    // (growth only, never a seed) from half of it in octaves
    lead: 1.6,
    weakLead: 0.5,

    // pair gates, strong / weak: density n_W / n_L (not sparser per area),
    // cover (share of the loser's sub-voxels next to the winner's), onsurf
    // (share of the winner's next to the loser's), colour-detail veto
    densityStrong: 1.0,
    densityWeak: 0.7,
    coverStrong: 0.8,
    coverWeak: 0.65,
    onsurfStrong: 0.5,
    onsurfWeak: 0.4,
    textureRatio: 0.5,
    textureMin: 0.05,
    // owner: ties of the benefit within this (octaves) go to the finer scan
    ownerTie: 0.05,

    // general difference per pair: median lead over the cells where both
    // have 40 splats; at least 200 such cells, capped at +-0.75 octave
    biasCells: 200,
    biasCap: 0.75,

    // regions: closing adds a cell when 60 % (and 4) of its surface
    // neighbours are in the region; losers are beaten in half of the region
    // cells where present and strongly in 3; filters 6 cells, 3 strong cells,
    // 200 loser rows; base scope above 25 % of the pair's shared cells
    closeShare: 0.6,
    closeMin: 4,
    // closing may also take cells without evidence: the winner present (2+
    // opaque splats), a loser with rows but too few to be present or to
    // compare (the 1/6-thinned coarse version leaves most of its cells so);
    // 0 = only shared cells where the winner has evidence (the design).
    // Measured on the bus pieces: +0.4-0.6 points of candidate recall
    closeThin: 1,
    // closing could also take a tie with at least closeMin (not closeShare)
    // of its surface neighbours in the region when W wins the cell alone (see
    // ownWin in composeDetail): its own median closeOwnLead * the strong
    // lead smaller, closeOwnDensity times as dense, the strong mask gates
    // (a tie there: the pooled cells around it, outside a finer object and
    // the same in both scans, outweigh the cell). Measured with closeOwn 1:
    // LOD box 2 66.95 -> 69.35 %; but twins moved 5 cm next to a third scan
    // (three bus layers) got 2 / 2 suggestions between them instead of 0 / 0:
    // cell-face artefacts pass the cell alone, closing let small twin seeds
    // grow past the region filters. Off (centreScale reaches the LOD aim)
    closeOwn: 0,
    closeOwnLead: 0.5,
    closeOwnDensity: 2,
    // a hide cell W does not win strongly over L (a weak win, a closing
    // addition) and where the cell alone shows W finer by less than holdOwn *
    // the strong lead (count medians of that cell; 0.5: the weak lead) keeps
    // L's rows: they stay paint candidates, so the batch's numbers (sep,
    // r_n, references) and every other candidate's verdict do not change,
    // but are 'held', never hidden. holdMatch 1: only when, matched in
    // space, W is not finer either - the median over the cell's candidates
    // of log2(own footprint / the mean footprint of the winner splats in its
    // reach) is below the same lead (paintBatch). holdRing 1: L's big ring
    // splats by the ring cell's own lead alone (they are picked for their
    // size). holdPool 1 would take the cell and its 6 face neighbours for the
    // own lead (-Infinity: off).
    // Why: regions grow 1-2 cells past the end of the winner's advantage
    // on weak wins, which keep the unconfirmed pooled lead; there both scans
    // are equally coarse (or fine). Measured on the bus pieces (18 cases,
    // hidden rows by truth before: right / neutral / wrong 423 319 / 78 415
    // / 17 071): 58 275 of the neutral and 11 154 of the wrong ones lay in
    // weak-win cells, 6121 / 2275 in the ring; those cells' own lead p25 /
    // p50 / p75 is 1.02 / 1.25 / 1.44 octave where their rows are mostly
    // right, -0.08 / 0.25 / 1.03 where wrong, -0.01 / 0.10 / 0.36 where
    // neutral (the pooled and the confirmed leads do not separate them).
    // With 0.5, the ring and holdMatch: bus wrong 3.29 -> 1.51 %, neutral
    // 15.11 -> 7.19 % of the hidden rows (518 805 -> 457 594), no case with
    // more wrong or neutral rows (held rows can only leave the hidden set),
    // mean recall 76.95 -> 76.87 %, focus balls 13/30 either way; museum
    // pieces (2 cases each) wrong 23.72 -> 4.20 %, neutral 16.13 -> 7.17 %;
    // LOD box 1 84.50 -> 82.04 %, box 2 72.00 -> 72.00 %, wrong 0, rows
    // hidden outside the boxes 669 -> 41, its main card still clear; the
    // suggestions themselves (cells, twins, coverage of the real pairs) do
    // not change. Without holdMatch: 1.35 / 6.15 %, recall 76.22 %, but a
    // piece moved up 3 cm (--offset 0.03, 2 pieces #1) loses recall 77.5 ->
    // 60.7 %: its floor lands in the cell above, so truly finer weak cells
    // show own leads of -1.2 to -0.3 octave (pooled 1.1-1.6); holdPool 1:
    // 66.6 % there, bus wrong 2.54 %. Hide cells only, no match: 0.25 1.82 /
    // 8.37 %, 0.5 1.67 / 7.19 %, 0.75 1.62 / 6.08 % (LOD box 2 70.37 %), 1:
    // LOD box 2 69.11 %.
    // holdRelease: the cell median holds the truly coarse rows with the
    // normal ones where a coarse stretch or a focus ball fills only part of
    // a cell (focus-coarse recall on the bus pieces 40.08 -> 37.34 %, lower
    // in 12 of 17 cases, 3 pieces #6 44.37 -> 29.80 %; 5523 right rows
    // held). So a candidate of a hold cell is let go on its own where the
    // loser is clearly coarser matched in space: log2 of the mean footprint
    // of L's splats in its reach over that of W's at least holdRelease * the
    // strong lead (holdReleaseLocal 1; 0: the candidate's own footprint
    // instead of L's mean; fewer than 3 L splats there: its own). Measured,
    // bus pieces: focus recall 38.81 % (below r4 in 12 cases, by 0.06-4.70
    // points, 2 pieces #3 45.76 against 50.46 %), right rows 419 345 (r4
    // 423 319), neutral 7.43 %, wrong 1.61 %, overlap recall 76.87 %; its own
    // footprint at 1: 38.79 / 8.25 / 1.71 %; the local mean at 0.75: 39.04 /
    // 7.72 / 1.70 %, 1.25: 38.43 / 7.31 / 1.56 %; both tests at once (its own
    // footprint and L's mean): 38.50 / 7.32 / 1.56 %. The release's cost:
    // against no release the bus pieces hide 3467 more rows, 1549 right, 1381
    // neutral and 537 wrong; the LOD main card 532 more, 495 of them neutral
    // (its neutral share 11.0 -> 15.6 %; both tests: 13.7 %); the museum pieces
    // 1837 more, 719 of them wrong in 3 pieces #2 (wrong 4.20 -> 5.40 %; both
    // tests 4.83 %, holdRelease 1.25 4.83 %), no recall gained there. Ring
    // candidates are picked for their size (sigma >= c / 4), so on their own
    // they always look coarser than the winner splats around them: let go at 1 /
    // 1.5 / 2 / 2.5 times the strong lead, focus recall 39.58 / 39.55 / 39.45 /
    // 39.29 %, but bus + bus-blur (design test C) then hides 0.105 / 0.103 /
    // 0.102 / 0.100 % of its unchanged rows (limit 0.1 %; 0.095 % with the ring
    // held, holdReleaseRing Infinity). bus + bus-blur: held sphere rows 229 ->
    // 101, its rows hidden 86.49 -> 87.08 %; LOD box 1 82.04 -> 82.42 %, box 2
    // 72.00 %, outside the boxes 41 -> 78 rows, wrong 0; offset 0.03 (2 cases)
    // recall drop <= 10 points 5/5 either way. The rest of the focus recall
    // stays a measured limit of the hold: coarse rows within the reach (about 6
    // cm) of normal ones are judged with them
    holdOwn: 0.5,
    holdRing: 1,
    holdPool: 0,
    holdMatch: 1,
    holdRelease: 1,
    holdReleaseRing: Infinity,
    holdReleaseLocal: 1,
    loserShare: 0.5,
    loserStrong: 3,
    // and over its hide cells as a whole W is finer by the weak lead (count
    // medians) and at least densityWeak as dense (loserCheck 1): a region of
    // weak pooled-lead wins whose loser is not coarser as a whole drops that
    // loser (and is built again with the rest), or is listed as 'equal' /
    // 'sparse' when none is left (composeDetail 5b). Measured with the final
    // constants: with the confirmation on it changes no harness twin case -
    // 0 suggestions between the twins without it too (bus 2-4 pieces x 3
    // seeds, museum 2-3 pieces x 2 seeds, three bus layers with a twin, each
    // at 0 / 1.5 / 3 / 5 cm; the claim of an earlier snapshot, 1 twin
    // suggestion of three layers at 5 cm without it, does not reproduce). It
    // is the second guard for B4: bus twins moved 3 cm with the unconfirmed
    // pooled lead (confirm 0) had 2 / 3 / 3 suggestions between them in the
    // 2-piece cases without it (6 of 9 cases pass), 0 in all 9 with it (the
    // strong twin seeds stay: 45 / 33 / 97 cells, but no region of them has
    // a coarser loser). On the real pairs it drops weakly coarser regions:
    // museum 1<->3 (the same capture twice) 4 -> 1 suggestions, covering 0.79
    // -> 0.18 % of the shared cells (18 raw regions listed as 'equal', 602
    // cells, their loser 1.08x coarser in the median); Steinbeis 104 -> 103,
    // 41.10 -> 40.82 % (the dropped one: 144 cells, its loser 1.24x coarser
    // by count medians, 1.47x by the area-weighted pooled lead; 2 'equal', 1
    // 'sparse' listed). No change of the suggestions on the bus pieces (18
    // cases; 2 raw regions listed instead of 'small'), LOD and museum 1<->2
    // (2 'small' become 'equal')
    loserCheck: 1,
    minCells: 6,
    minStrong: 3,
    minRows: 200,
    baseShare: 0.25,
    // shape: 'surface' when the thinnest box side is at most 2 c and the
    // middle one at least 4 c
    surfaceThin: 2,
    surfaceWide: 4,
    // benefit = sum of area * min(lead, 2)
    benefitCap: 2,
    // 'clear' (pre-ticked): strong share, lead (octaves), lead over the
    // general difference, cells, sep50 (in c), covered share. Cells 100
    // (the design: 10): the scenes with a twin layer (bus layers 3 / 4 with
    // a twin at 0 / 1.5 cm) had 5 clear cards of 35-77 cells (1 m balls at
    // 20-25 cm), right but hiding 11.1-31.6 % neutral rows at their border;
    // with 100 they are 'check', and no card becomes clear. Still clear: the
    // LOD truth test's main card (263 cells, lead 1.31 octave, covered
    // 90.8 %, 0 wrong, 15.6 % neutral) and the blurred sphere of bus +
    // bus-blur (420 cells). The other gates are as designed: of the rules
    // that make more cards clear (a grid search over the harness's card
    // records), covered 0.8 instead of 0.9 (cells 10) clears 24 cards of the
    // bus and museum pieces, 12 of them above 0.5 % wrong or 5 % neutral
    // rows (37 / 21 with the layer, offset 0.03 and floaters cases); every
    // rule that clears more with no such card needs lead >= 1.3 octave, and
    // the one with the most real cards (cells 100, covered 0.5) clears 4
    // synthetic cards at leads of 1.307-1.326 (the generator's blur is
    // 1.29), one of them the 3 cm moved piece of offset 0.03, Steinbeis 1 and
    // museum 1<->2 2 cards. On the real pairs the covered share (p50
    // 0.49-0.74) keeps every card 'check'
    clearStrong: 0.6,
    clearLead: 1,
    clearOverBias: 0.5,
    clearCells: 100,
    clearSep: 1 / 10,
    clearCovered: 0.9,
    // rejected clusters need this many cells
    rejectMin: 4,

    // paint (cover proof): winner grid 0.3 c; r_t = 2 winner spacings;
    // r_n = clamp(2 sep75, c / 12, c / 5); per splat r_n(p) = min(max(r_n,
    // 0.5 sigma), c / 4), disk rho = clamp(sigma, r_t, c / 4); neighbours
    // within 1.2 max(rho, r_n(p)); PCA from 5 points, planar when
    // lambda_min / sum <= 0.1. The design's count test (coverTest 0):
    // covered when count >= max(3, ceil(0.5 m_self (rho / r_t)^2))
    paintGrid: 0.3,
    rt: 2,
    rnSep: 2,
    rnMin: 1 / 12,
    rnMax: 1 / 5,
    blob: 0.5,
    rhoMax: 1 / 4,
    reach: 1.2,
    pcaMin: 5,
    // with fewer than pcaMin winner points in reach, look again this many
    // times as far (at most widenGrid * c, on a grid of that size) before
    // calling it no surface. Measured: on the real Steinbeis pair (c 15 cm)
    // the winner's local spacing in the top regions is 2.2-2.7 cm, so 0.3 c
    // = 4.5 cm held fewer than 5 of its points for 66-73 % of the
    // candidates; at 7.5 cm the top regions hide 1.7-2.3x more, and the bus
    // 2-piece recall rises from 70 to 76 %
    widen: 2,
    widenGrid: 0.5,
    planar: 0.1,
    coverShare: 0.5,
    coverMin: 3,
    sepSamples: 2000,
    selfSamples: 1000,
    // cover test: 1 = the winner's footprints cover the candidate's (centre
    // and ringNeed of 6 spots at ringRadius * sigma within footprintScale *
    // sigma of a winner splat on the local plane); 0 = the count test above.
    // Measured on the bus pieces: with the count test 97 % of the kept truly
    // coarse candidates sat where the winner covers the spot at 2 sigma
    // (7764 + 5515 vs 421 real gaps in the main region): a disk of 2 winner
    // spacings holds about 3 winner centres, so "half the usual count" is
    // Poisson noise. Footprint test: recall 58 -> 70 %, rows hidden without
    // a winner point nearby 2.1 -> 1.0 %, hole coverage loss <= 0.13 pp.
    // ringNeed 4 gave 3 more points of recall at 0.13 instead of 0.02 pp
    // hole loss; 5 keeps at most one uncovered ring spot
    coverTest: 1,
    footprintScale: 2,
    ringRadius: 1,
    ringNeed: 5,
    // the centre spot also needs a winner splat within this many winner
    // spacings (the local one with localRef): a big winner splat at the edge
    // of a gap does not stand for the surface inside it (onesided focus ball:
    // rows hidden in the dropped half 357 -> 282 with 2). On real data 2 is
    // too strict: in the LOD truth test, where LOD0 covers all of LOD3 (its
    // merge), 2 kept 1414 of box 2's 6672 coarse rows as uncovered with
    // their plane distance at the hidden ones' (8.0 vs 7.6 mm; winner
    // spacing 9 mm). Measured (LOD box 1 / box 2 hidden, 0 wrong in each;
    // bus 18 cases: wrong, mean recall, max coverage loss / holes): 2:
    // 79.2 / 67.0 %, 3.16 %, 75.4 %, 0.022 / 0.51 pp; 2.5: 84.5 / 72.0 %,
    // 3.29 %, 77.0 %, 0.027 / 0.64 pp; 3: 87.5 / 75.6 %, 3.35 %, 77.7 %,
    // 0.032 / 0.78 pp (neutral 15.12 % in all three)
    centreScale: 2.5,
    // reference per candidate cell instead of per batch: the winner's median
    // spacing and own count from up to localSamples of its points in the
    // cell (or its 3x3x3 cells when the cell has fewer than localMin). A
    // region spans dense and sparse parts of a scan; measured on the bus
    // pieces: recall 72 -> 76 %, rows hidden without a winner point nearby
    // 5.0 -> 1.9 %; costs 1.8 s of paint on the Steinbeis pair
    localRef: 1,
    localSamples: 8,
    localMin: 8,
    // per hide cell (5+ candidates), from the candidates' plane distances to
    // the winner's local plane:
    // - uncovered: most of them have no winner surface in the paint's reach
    //   (distance Infinity) - kept, nothing to align;
    // - apart: the median of their signed distances (normals oriented like
    //   the cell's first one; > 60 degrees off it not compared) is above
    //   apartSep * c - kept, "Hier ausrichten".
    // A region is dropped as apart when more than apartDrop of its hide
    // cells are apart, or when it holds a coherent patch: connected cells
    // above apartLow * c, grown from apart cells (hysteresis), of at least
    // apartCluster cells and apartPatch of its hide cells.
    // Measured (shares of the shared cells; earlier rule: unsigned median,
    // apartSearch 1, c / 6, 30 % drop): Steinbeis apart 5.5 -> 0.66 %
    // (uncovered 4.0 %), museum 1<->2 7.3 -> 1.48 % (uncovered 3.2 %),
    // museum 1<->3 0.06 -> 0.00 %; bus piece moved up 10 cm, rows hidden on
    // its horizontal surfaces <= 0.5 %: 3/6 -> 5/6 (the miss: an 80 cm
    // grid, 406 of 80 670, where 10 cm is below c / 6). Unsigned medians
    // count the scatter of big loser splats around the winner's surface
    // (cell medians 27-35 mm on Steinbeis at a 25 mm limit, candidate sigma
    // p50 46 mm); signed ones only a systematic offset: c / 6 signed
    // Steinbeis 1.17 / museum 2.52 %, c / 5 0.65 / 1.47 %. The drop share
    // alone cannot tell a moved piece from noise (moved: 0.19-0.51 of a
    // region's hide cells apart, aligned real pairs up to 0.22); coherent
    // patches can: moved regions hold patches of 23-353 cells at 5.4-37 % of
    // their hide cells, aligned real pairs at most 24 cells at <= 2.0 %
    // (Steinbeis 11). Patches of seeds only at 25 cells: 4/6
    apartMin: 5,
    apartSep: 1 / 5,
    apartLow: 1 / 6,
    apartDrop: 0.3,
    apartCluster: 20,
    apartPatch: 0.03,
    // a candidate without winner surface in the paint's reach has the plane
    // distance Infinity (the earlier apartSearch 1 measured the plane within
    // a whole cell instead: almost no candidate of an aligned pair was then
    // Infinity, Steinbeis p90 0 %, and the plane 7.5-15 cm away put them off
    // the surface - 5.5 % of Steinbeis' shared cells apart). So a loser
    // moved farther off the winner's surface than the paint's widened reach
    // (at most c / 2; about 7 cm for 3 cm splats at 25 cm cells) is
    // 'uncovered', not 'apart': kept as well, but without the align hint.
    // The far tier (apartFar cells, 0 = off) would keep the whole-cell
    // measurement for the apart test alone: such a cell is apart when at
    // least apartMin of its candidates find a winner plane at one signed
    // offset beyond apartSep * c (interquartile range within apartCoherence
    // of the median). Measured with apartFar 1: three bus layers, the last
    // one 10 cm off a plane (no other surface on that side): apart clusters
    // listed 0/3 -> 3/3; but aligned real pairs hold such parallel layers
    // too - Steinbeis apart 0.66 -> 1.57 %, museum 1<->2 1.48 -> 2.33 % of
    // the shared cells (targets 1 / 1.5 %, warning row from 2 %). Off
    apartFar: 0,
    apartCoherence: 0.5,
    // border candidates: loser rows in the ring with sigma >= c / 4
    ringSize: 1 / 4,

    // blur haze ("Unschärfe-Schleier", paintBatch): where a loser is clearly
    // coarser over a large region (count medians over the hide cells hazeLead
    // octaves, at least hazeCells cells; never a forced region), its coarse
    // splats - at least hazeRingSize * c and 2^hazeOwn x the winner's median
    // footprint - that the cover proof left kept (uncovered / no surface, not
    // in an apart or near cell) or that lie in the haze zone (cells 2 to
    // hazeZone off the region in no region, Region.haze) are hidden as haze
    // when, within their reach (hazeReach x footprint, at most hazeFar
    // cells; voxel means of both scans, edge hazeVoxel * c, for the far
    // reach hazeVoxelFar * c):
    // 1. the winner has surface there, hazeOwn octaves finer (mean footprint);
    // 2. not off to one side of the splat along its plane (beyond the end of
    //    its scan): mean voxel offset along the plane < hazeEdge x reach;
    // 3. either a blurred copy of it - a candidate whose own footprint test
    //    passed in a cell that went uncovered, a zone row with a winner voxel
    //    within hazeCentre * c - or floating off it by more than hazeOff x the
    //    paint's normal tolerance; in the surface without the winner at its
    //    centre it fills a hole and stays;
    // 4. floating, the winner has surface on both sides along one of 13 axes
    //    within hazeSee cells (the open space it saw through);
    // 5. the loser's mean footprint there >= hazeLocal octaves above the
    //    winner's, and the winner has a voxel within hazeCoverDist * c of
    //    hazeCover of the loser's rows there (count-weighted): the loser's
    //    surroundings are the winner's, not content the winner lacks.
    // Gross blur: where the loser's splats in the reach are hazeGross octaves
    // above the winner's (mean footprints) and the splat too, the loser is
    // not a coarser version of the winner's surface (the bus' coarse
    // stretches are 1.29 octaves, an LOD step about 1) but a blur of another
    // order (A towards the Nuremberg bridge: loser / winner 2.3-3.8 octaves
    // around the splats the views still showed): rule 2 at hazeGrossEdge
    // (past the end of a scan the offset is 0.42 and more), rule 3 floating
    // already beyond hazeGrossOff x the winner's mean footprint off its plane
    // (its surface is that thin; the paint's tolerance grows with the
    // loser's splat - Nuremberg's 20-60 cm blobs 2-8 cm over B's 2 cm deck
    // counted as in it), no rule 5. In the surface it still needs the winner
    // at its centre (rule 3), so it does not fill a hole (--unit: 0 of 44
    // rows in a 15 cm hole; a looser centre test, W within the splat's
    // footprint, hid 32 of 44).
    // Hidden like the cover proof's rows, with the region's id (one undo per
    // card); counted as LoserNumbers.haze (of them hazeRing from the zone).
    // Measured on the Nuremberg pair (A 4.1 M splats, blurry towards the
    // bridge, B 1.74 M, sharp there; c 40 cm), every card accepted: A's
    // share of the lower half of 6 views on the bridge (z-buffered discs,
    // opacity >= 0.35; B alone 0 %): no haze 43.9 % (53.6 / 42.8 / 62.4 /
    // 44.4 / 9.9 / 59.3), the earlier rule (rules 1-5, hazeLocal = the
    // strong lead, zone 6) 40.5 %, these constants 22.6 % (30.8 / 17.4 /
    // 17.5 / 27.4 / 4.4 / 58.6 - the last looks over the river, where only A
    // has splats); in the app the deck and the railing then look like B
    // alone but for a few smears near the camera. The harness's box
    // (-18,-42,-4 .. 12,-6,10) keeps 77.7 % of A's visual weight (opacity x
    // footprint^2) without haze, 58.8 % with the earlier rule, 50.9 % now -
    // 30 % of it in the haze zone where B has no surface (giants over the
    // water). Steps (zone 12): the gross tier with W within the splat's
    // footprint of its centre instead of rule 3 22.1 % (but 32 of 44 hole
    // rows hidden), with rule 3 27.5 %, + the thin surface (hazeGrossOff)
    // 24.8 %, + floating gross rows anywhere in their reach (not only within
    // 2 footprints of W) 23.3 %; zone 6 / 8 / 10 / 12: 25.6 / 24.9 / 22.6 /
    // 23.3 %. The zone reaches hazeZone cells, the reach stays at hazeFar.
    // Time: Steinbeis 11.8 -> 12.6 s (zone 12: 13.4 s, over the 13 s gate;
    // hazeZoneOf by columns instead of a breadth-first search over every key:
    // 0.78 -> 0.15 s at zone 10, same cells), Nuremberg 15.5 -> 16.4 s.
    // hazeLocal 1 octave (was the strong lead, 0.68): bus haze rows wrong 156
    // -> 91 (3 pieces #2, where the winner is coarse itself: 89 -> 43),
    // neutral 290 -> 66, right 13 663 -> 15 082 (zone 12); 1.2 octaves: wrong
    // 59 but right 13 497. A guard on the winner's own coarseness (its mean
    // footprint there against its scan median, 1 octave) cut wrong rows to 65
    // but right ones to 9541. With these constants the bus' haze rows are
    // 14 739: right 14 533, neutral 73, wrong 133 (0.90 %; the cover proof's
    // own rows 1.6 %), all hidden rows wrong 1.5984 -> 1.5914 %, neutral
    // 7.2747 -> 7.2195 %; without the gross tier 14 623 haze rows, wrong 90
    // (on the bus it adds 116 rows, 43 of them wrong). LOD box 1 82.70 ->
    // 83.01 %, box 2 72.00 %, wrong 0; bus-blur changed rows 89.69 -> 89.59 %,
    // unchanged 0.0958 -> 0.0952 %; twins 0, swap checks identical.
    // The earlier rule's gates (bus pieces, 18 cases, hidden rows wrong /
    // neutral; layers 3 with the 6 cm shifted layer, its hidden horizontal
    // rows <= 5 %): no haze 1.6135 / 7.4344 %. Its variants, cover / distance:
    // 0.7 / c/4 1.6027 / 7.25 %, Nuremberg 60.7 %, shifted layer 15 of 185
    // hidden (MISS: the layer lies 6 cm off, within c/4 of the winner); 0.65
    // / c/4 1.6125 %, 58.7 %, MISS; 0.7 / c/8 1.5966 / 7.28 %, 62.6 %, ok;
    // 0.65 / c/8 (kept) 1.5984 / 7.27 %, 61.1 %, ok. On the way
    // (earlier snapshots): floating alone with reach 2 and giant splats
    // (>= c) exempt from rules 2 and 5 - bus 2.02 % wrong, Nuremberg 45.7 %;
    // + rule 2 at 0.3: 1.87 %, 46.8 %; + rule 4: 1.74 %, 48.4 % (the wrong
    // rows: loser rows past the end of the winner's piece, giants among
    // them); no giant exemption, reach 2 vs 3 (edge 0.25, cover 0.7): 1.60 vs
    // 1.59 % wrong, 7.29 vs 7.19 % neutral; hazeFar 8 instead of 6 (the zone
    // too): no gain (+0.6 s); copies by footprint test 1 too (centre
    // covered, ring not): 12 of 44 rows in a 15 cm hole of the winner hidden
    // (--unit), Nuremberg the same within 0.1 point - so only test 2. The
    // giants over the water look
    // like the end of a scan (the winner has surface on one side only): no
    // rule that keeps the bus' scan ends hides them
    haze: 1,
    hazeLead: 1,
    hazeCells: 50,
    hazeFar: 6,
    hazeZone: 10,
    hazeRingSize: 1 / 8,
    hazeReach: 3,
    hazeVoxel: 1 / 8,
    hazeVoxelFar: 1 / 2,
    hazeOwn: 1,
    hazeLocal: 1,
    hazeEdge: 0.25,
    hazeOff: 1,
    hazeCentre: 1 / 8,
    hazeSee: 60,
    hazeCover: 0.65,
    hazeCoverDist: 1 / 8,
    hazeGross: 2,
    hazeGrossEdge: 0.4,
    hazeGrossOff: 2,

    // free views (freeViews): elevations of the 8 directions each around the
    // up axis (rad; the design's 0.35, 0.75 and -0.2, and -0.75 to see a
    // ceiling from below), the margin of the scanned volume and the
    // camera's least distance (cells), the share of the free line the camera
    // stands at, and the cells of the region a line may pass (more: it
    // grazes the region; its ring's cells pass, they are its neighbourhood,
    // not its surface: Steinbeis 204 -> 205 views, museum 1<->2 154 -> 155).
    // Why: the earlier march started at 1.1 r + c, ignored everything closer
    // and counted a line without a hit up to `want` as the longest, and the
    // views aimed at the box centre; on the Steinbeis hall (z up, ceiling at
    // 7.35-8.4 m) 3 of the top 4 cameras stood above the roof (z 10.8-15.8 m)
    // or behind a wall and showed the back of the splats. Harness check
    // (camera in the scanned volume, on an empty cell, nothing but the
    // region and its ring between it and the target, and the first present
    // cell it sees towards the target the region's), Steinbeis with +y / z
    // up: before 57 / 33 cameras outside, 64 / 64 looking through another
    // surface, 134 / 121 seeing another surface first, of 206; now 0 of 205 /
    // 201 (museum 1<->2 before 39 / 52 / 97 of 158, now 0 of 155; LOD 0 / 2
    // / 2 of 4, now 0; bus + bus-blur 2 / 1 / 2 of 2, now 0)
    viewElevations: [0.35, 0.75, -0.2, -0.75],
    viewMargin: 2,
    viewMin: 2,
    viewBack: 0.85,
    viewGraze: 6,
    // a camera stands enclosed when the rays of at least this share of the
    // 26 directions around it meet a present cell in the scanned volume (a
    // camera in a scanned room, not behind its wall); enclosed cameras go
    // first. The first views (the card flies there) whose rays meet
    // something in at most 17 of 26 directions (harness --view-diag, rays up
    // to 25 m): Steinbeis +y / z up 28 / 30 of 103 without the rule, 4 / 0
    // with it (the views before this round: 57 / 49, mean share 0.61 /
    // 0.64; now 0.88 / 0.89), museum 1<->2 24 -> 3 of 78 (before 47 of 79);
    // detail time +0.1-0.2 s (measured only where it decides)
    viewEnclosed: 0.75,
    // the 8 azimuths turned by this much (rad): from the marker (a cell
    // centre) a 45 degree line crosses cell edges exactly, where a traversal
    // visits only one of the two cells there - the harness's traversal,
    // which visits the other, saw another surface first in 5 / 4 Steinbeis
    // views and 6 museum 1<->2 views without the turn, 0 with it
    viewTurn: 0.01
};

type DetailConstants = typeof DETAIL;

type DetailOptions = Partial<DetailConstants> & {
    // up axis of the scene (0 x, 1 y, 2 z) and its sign: horizontal x
    // horizontal x height labels, free views
    upAxis?: 0 | 1 | 2,
    upSign?: 1 | -1,
    // robust diagonal of the scene (free views reach at most 0.3 of it)
    sceneSize?: number
};

// cell states (DetailResult.state per shared cell; single and none follow
// from the present bits, apart and uncovered are set by applyPaint: apart =
// the loser lies off the winner's surface there (finite plane distances,
// "Hier ausrichten"), uncovered = the winner has no surface near most of
// the loser's splats there (plane distance Infinity: none in the paint's
// reach, up to c / 2) - kept, nothing to align)
const CellState = {
    none: 0,
    strong: 1,
    weak: 2,
    tie: 3,
    partial: 4,
    sparse: 5,
    texture: 6,
    thin: 7,
    single: 8,
    apart: 9,
    uncovered: 10
} as const;

// cell states the closing pass never adds to a region
const CLOSING_BLOCKED = (() => {
    const t = new Uint8Array(16);
    [CellState.partial, CellState.sparse, CellState.texture, CellState.apart, CellState.uncovered].forEach((st) => {
        t[st] = 1;
    });
    return t;
})();

// candidate states (PaintBatchResult.state); held = covered, but in a hide or
// ring cell where the winner does not win on its own (holdOwn): it stays and
// is not the card's
const PaintState = {
    hidden: 1,
    uncovered: 2,
    apart: 3,
    noSurface: 4,
    held: 5,
    // blur haze (DETAIL haze): hidden like hidden, counted apart (a
    // candidate the cover proof left uncovered / without surface, or a row of
    // the haze zone)
    haze: 6
} as const;

const KEPT = 0x8000;

// the 13 axes of the 3 x 3 x 3 neighbourhood (unit vectors; the haze's
// bracket test looks both ways along each)
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
});

// size histogram: half-octave bins of log2(sigma / c) over [-10, 2); the end
// bins are open
const BINS = 24;
const HIST_LO = -10;
const BIN_WIDTH = 0.5;

// ---------------------------------------------------------------- types

// the rows of one scan as the reader (splat-data readLayerCompact) gives them
type CompactRows = {
    // world centres, xyz per row
    positions: Float32Array,
    // footprint sqrt(largest * middle scale) in world units (footprintOf)
    footprint: Float32Array,
    // opacityByte(alpha)
    opacity: Uint8Array,
    // lumCode(base colour)
    lum: Uint8Array,
    // instance index per row (main thread only)
    instances?: Uint32Array
};

type ScanCells = {
    cell: number,
    // number of rows
    rows: number,
    // occupied cells, ascending keys (compose-core keyOf of floor(p / c))
    keys: Float64Array,
    // opaque splats and all rows per cell
    n: Uint32Array,
    nAll: Uint32Array,
    // 24 half-octave bins of log2(sigma / c) per cell (opaque, saturating)
    hist: Uint16Array,
    // sum and sum of squares of ln luminance (opaque)
    lum1: Float32Array,
    lum2: Float32Array,
    // 4x4x4 sub-voxel occupancy (bit x + 4y + 16z; lo holds z = 0-1)
    maskLo: Uint32Array,
    maskHi: Uint32Array,
    // cell index per row (-1: position not finite)
    rowCell: Int32Array,
    // median opaque footprint
    s50: number,
    seconds: number
};

// what composeDetail needs of a scan (rowCell stays on the main thread)
type ScanCellsLike = Omit<ScanCells, 'rowCell'> & { rowCell?: Int32Array };

type CellSample = {
    // opaque centres, evenly picked
    positions: Float32Array,
    // rows each sample stands for
    weight: number
};

type AutoCell = {
    // the grid: the largest of the scans' own cells
    cell: number,
    // each scan's own nice cell
    perScan: number[],
    // splat-weighted median opaque count per occupied cell at `cell`
    counts: number[],
    // the scan that forces a grid more than 1.5x the median scan's (-1: none)
    forcedBy: number
};

type PairInfo = {
    a: number,
    b: number,
    // cells where both are present, and their approximate area
    sharedCells: number,
    sharedArea: number,
    // general difference b^ in octaves, > 0: a is finer (capped, 0 when fewer
    // than biasCells cells); raw median (NaN when too few) and its cells
    bias: number,
    biasRaw: number,
    biasCells: number,
    // share of the shared cells where a (b) is at least `lead` finer
    clearA: number,
    clearB: number,
    // median of mean ln luminance b - a over the shared cells (< 0: b darker)
    exposure: number
};

type ScanInfo = {
    s50: number,
    // approximate area of the cells where the scan is present
    area: number,
    // shares of its shared cells: owner there, equal (tie), beaten there
    finest: number,
    tie: number,
    coarser: number,
    // share of its present cells where no other scan is present
    alone: number,
    presentCells: number,
    sharedCells: number
};

type LoserNumbers = {
    scan: number,
    // count medians and quartiles of the opaque footprints over the hide
    // cells (world units)
    sizeW: number,
    sizeL: number,
    q25W: number,
    q75W: number,
    q25L: number,
    q75L: number,
    // n_W / n_L and colour detail tau_W / tau_L over the hide cells
    density: number,
    texture: number,
    tauW: number,
    tauL: number,
    // share of L's opaque splats more than twice W's median
    big: number,
    // median cover of L by W over the hide cells
    cover: number,
    // L rows in the hide cells
    rows: number,
    // area-weighted median lead over the hide cells (octaves)
    lead: number,
    // after applyPaint: hidden, kept (not covered, apart, no surface) and
    // held (covered rows of hold cells, holdOwn; set only when there are
    // any) add up to the candidates; covered = (hidden - haze + held) /
    // candidates, the cover proof's own share (the haze does not move it)
    hidden?: number,
    kept?: number,
    held?: number,
    // of hidden: blur-haze rows (DETAIL haze; set only when there are any):
    // coarse loser splats the winner shows as blur - blurred copies of its
    // surface and splats floating in front of it - from the candidates the
    // cover proof left kept and from the haze zone (Region.haze); "davon n
    // Schleier-Splats". hidden + kept + held = candidates + hazeRing
    haze?: number,
    // of haze: rows of the haze zone (no candidates of the cover proof)
    hazeRing?: number,
    covered?: number,
    sep25?: number,
    sep50?: number,
    sep75?: number,
    rn?: number,
    rt?: number,
    sW?: number,
    mSelf?: number,
    apartCells?: number,
    uncoveredCells?: number
};

type FreeView = { position: V3, target: V3 };

type Region = {
    // rank: base regions first, then by benefit; ties by the smallest key
    id: number,
    winner: number,
    losers: number[],
    // global cell indices, ascending
    cells: Int32Array,
    ring: Int32Array,
    // per loser (losers order)
    hideCells: Int32Array[],
    // per loser: the hide cells, and with holdRing the ring cells, whose rows
    // are held (holdOwn; ascending; absent when off)
    holdCells?: Int32Array[],
    strongCells: number,
    shape: 'surface' | 'object',
    scope: 'local' | 'base',
    // horizontal, horizontal (larger first), height - world units
    dims: V3,
    min: V3,
    max: V3,
    marker: V3,
    benefit: number,
    lead: number,
    perLoser: LoserNumbers[],
    views: FreeView[],
    // set by paintInputs when a loser qualifies for the blur haze (DETAIL
    // haze): the haze zone, the cells 2 to hazeZone cells off the region's
    // cells (beyond its ring) that are in no region (ascending). Hidden haze
    // rows lie in the region's cells, its ring or these cells
    haze?: Int32Array,
    // set by applyPaint ('check' for forced regions)
    confidence?: 'clear' | 'check',
    forced?: boolean
};

// equal: a region of W's wins whose losers are, over its hide cells as a
// whole, not coarser (loserCheck): "über den ganzen Bereich kaum feiner"
type RejectReason = 'partial' | 'sparse' | 'texture' | 'small' | 'apart' | 'equal';

type Rejected = {
    reason: RejectReason,
    winner: number,
    loser: number,
    cells: Int32Array,
    min: V3,
    max: V3,
    centre: V3,
    // partial: the median share of the gate that failed (gate) over the
    // cells where it failed; sparse: median density W / L; texture: median
    // colour-detail ratio W / L; small: loser rows (a region the filters
    // reject, also one with too few strong cells for any loser: then named
    // after the scan W beats strongly most often); apart: the cluster's own
    // separation, the median of the finite plane distances of the loser's
    // candidates in its apart cells (world units); equal: the count-median
    // lead of W over the loser across the region's hide cells (octaves, may
    // be <= 0). A region loserCheck drops is 'sparse' when its loser failed
    // the density test there (value: that test's density, W / L opaque
    // splats over the loser's hide cells, below densityWeak), else 'equal'
    // (its cells: those W owned)
    value: number,
    // small only: a region with too few strong cells for any loser (not too
    // few cells or rows); listed after the other entries
    few?: boolean,
    // partial only: the gate that failed - 'cover' (W covers too little of
    // L's surface) or 'onsurf' (too little of W's surface lies on L's); when
    // both failed in the cluster, the one that failed in more of its cells
    // (equal counts: the smaller median share)
    gate?: 'cover' | 'onsurf'
};

type DetailResult = {
    cell: number,
    scanCount: number,
    // strong lead in octaves
    lead: number,
    upAxis: 0 | 1 | 2,
    upSign: 1 | -1,
    sceneSize: number,
    // global cells, ascending keys
    keys: Float64Array,
    // per scan: its cell index -> global cell index
    remap: Int32Array[],
    // per global cell: bit s = scan s present (2+ opaque splats in the cell)
    present: Uint8Array,
    // per global cell: shared index h (-1 when fewer than 2 scans present)
    sharedIndex: Int32Array,
    // per shared cell h: its global cell
    shared: Int32Array,
    // per shared cell: owner (-1), scans the owner beats strongly / weakly,
    // scans beaten by anyone, state (CellState), pooling (0 the cell alone,
    // 1 with its 6 face neighbours, 2 the 3x3x3 cells),
    // the failing pair with the largest lead (partial / sparse / texture)
    owner: Int8Array,
    strong: Uint8Array,
    weak: Uint8Array,
    beaten: Uint8Array,
    state: Uint8Array,
    pooled: Uint8Array,
    rival: Int8Array,
    rivalLoser: Int8Array,
    // per (h, s) at [h * scanCount + s]: median footprint (world, NaN = no
    // evidence), pooled opaque count, colour detail tau (ln units), cover of
    // s by the owner (or the rival; NaN for that scan itself)
    size: Float32Array,
    count: Uint32Array,
    texture: Float32Array,
    cover: Float32Array,
    // per global cell: region id (-1)
    regionOf: Int32Array,
    pairs: PairInfo[],
    scans: ScanInfo[],
    regions: Region[],
    rejected: Rejected[],
    // counts for the harness: shared cells where a pair had no per-cell lead
    // to confirm with (confirm on), raw regions loserCheck dropped (listed as
    // 'equal' / 'sparse') and rebuilt with fewer losers, raw regions without
    // any loser (listed as 'small')
    // loserlessStrong: strong cells of loserless regions below rejectMin (not listed)
    diag: { unconfirmed: number, loserDropped: number, loserRebuilt: number, loserless: number, loserlessStrong: number },
    seconds: number
};

type PaintBatch = {
    id: number,
    winner: number,
    loser: number,
    // the winner's opaque rows in the region cells and ring, xyz, and their
    // footprints
    winnerPoints: Float32Array,
    winnerSize: Float32Array,
    // loser rows: xyz, footprint, global cell, 1 = from the ring
    candidates: Float32Array,
    candidateSize: Float32Array,
    candidateCell: Int32Array,
    ring: Uint8Array,
    // 1 = a candidate of a hold cell (region.holdCells; absent: none)
    hold?: Uint8Array,
    // the blur haze runs for this batch (DETAIL haze): candidates from this
    // index on are rows of the haze zone (ring 1 too), outside the cover
    // proof; absent: no haze. With it the surroundings beyond the region and
    // its candidates, as voxel means (edge hazeVoxel * c: position, mean
    // footprint, number of rows): the winner's opaque rows in the haze zone,
    // the loser's in the zone and the ring that are no candidates
    hazeFrom?: number,
    hazeW?: Float32Array,
    hazeWSize?: Float32Array,
    hazeWCount?: Float32Array,
    hazeL?: Float32Array,
    hazeLSize?: Float32Array,
    hazeLCount?: Float32Array,
    // the winner's occupied cells (DETAIL present: 2+ opaque splats), keys
    // ascending - on the first haze batch of each winner in a job only;
    // composePaint hands them to the job's later batches of that winner
    hazeOcc?: Float64Array,
    s50W: number,
    // loser row index per candidate (main thread: applyPaint; the worker
    // does not need it)
    rows?: Uint32Array
};

type PaintJob = {
    loser: number,
    cell: number,
    batches: PaintBatch[]
};

type PaintBatchResult = {
    id: number,
    winner: number,
    loser: number,
    // per candidate: PaintState (0 for a row of the haze zone that is not
    // haze: no candidate)
    state: Uint8Array,
    // per candidate: distance to the winner's local plane (NaN: not
    // measured; Infinity: no winner surface in reach, or within apartSearch
    // cells when that is set)
    distance: Float32Array,
    // hidden by the cover proof and as haze (haze included)
    hidden: number,
    // kept: not covered, apart or no surface; held: covered candidates of
    // hold cells; hidden + kept + held = candidates of the cover proof +
    // hazeRing
    kept: number,
    held: number,
    // of hidden: blur haze (PaintState.haze), and of it rows of the haze zone
    haze: number,
    hazeRing: number,
    // hide cells with candidates, the global cells among them found apart
    // and their share
    candidateCells: number,
    // the candidates by hide cell (ring candidates not included): run i is
    // cell runCells[i], candidates [runStart[2 i], runStart[2 i + 1])
    runCells: Int32Array,
    runStart: Uint32Array,
    apartCells: Int32Array,
    apartShare: number,
    // the finite plane distances of the candidates in each apart cell
    // (apartCells order; cell i at [apartStart[i], apartStart[i + 1]))
    apartDist: Float32Array,
    apartStart: Uint32Array,
    // hide cells between apartLow and apartSep (not apart on their own; a
    // coherent patch of them grown from apart cells drops the region), and
    // their finite plane distances like apartDist
    nearCells: Int32Array,
    nearDist: Float32Array,
    nearStart: Uint32Array,
    // hide cells where most candidates have no winner surface (distance
    // Infinity): kept, but not apart
    uncoveredCells: Int32Array,
    sep25: number,
    sep50: number,
    sep75: number,
    rn: number,
    rt: number,
    sW: number,
    mSelf: number,
    // (hidden - haze + held) / candidates of the cover proof: the cover
    // proof's own share
    covered: number
};

type PaintResult = {
    batches: PaintBatchResult[],
    seconds: number
};

type PaintApplied = {
    // per scan, per row: region id + 1 in the low 15 bits, 0x8000 = kept
    // candidate (not covered, apart or no surface): phase 3's gap candidates;
    // held rows (holdOwn) are 0 like rows outside every region
    paint: Uint16Array[],
    // ids (before renumbering) of regions dropped as 'apart'
    dropped: number[],
    // global cells found apart, and uncovered (not apart)
    apartCells: Int32Array,
    uncoveredCells: Int32Array,
    seconds: number
};

type ProbeScan = {
    scan: number,
    present: boolean,
    // pooled opaque count, median footprint (world, NaN = no evidence),
    // colour detail, area of the cell itself
    count: number,
    size: number,
    texture: number,
    area: number
};

type ProbePair = {
    winner: number,
    loser: number,
    evidence: boolean,
    // octaves, > 0: winner finer
    lead: number,
    density: number,
    // share of the loser's sub-voxels next to the winner's (cover) and of
    // the winner's next to the loser's (onsurf); NaN when not measured
    cover: number,
    onsurf: number,
    // tau_W / tau_L
    texture: number,
    strong: boolean,
    weak: boolean,
    reason: 'partial' | 'sparse' | 'texture' | null,
    // partial only: the gate that failed (both failed: the smaller share)
    gate?: 'cover' | 'onsurf'
};

type CellProbe = {
    // global cell (-1: no scan has rows there)
    cell: number,
    centre: V3,
    pooled: boolean,
    // cells measured (1, or the existing ones of the 3x3x3)
    measured: number,
    state: number,
    owner: number,
    region: number,
    scans: ProbeScan[],
    pairs: ProbePair[]
};

// ---------------------------------------------------------------- helpers

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const settings = (options: DetailOptions = {}) => ({ ...DETAIL, ...options });

const SPAN = keyOf(0, 1, 0) - keyOf(0, 0, 0);
const SPAN2 = keyOf(1, 0, 0) - keyOf(0, 0, 0);

const cellKey = (x: number, y: number, z: number, c: number) => keyOf(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c));

// footprint of a splat from its linear scales (quality-score sizeOf)
const footprintOf = (sx: number, sy: number, sz: number) => {
    const a = Math.abs(sx), b = Math.abs(sy), c = Math.abs(sz);
    const hi = Math.max(a, b, c);
    const mid = a + b + c - hi - Math.min(a, b, c);
    return Math.sqrt(hi * mid);
};

const opacityByte = (alpha: number) => Math.max(0, Math.min(255, Math.round(alpha * 255)));

// ln(0.02 + Y) of the base colour (Rec.709 luma), in steps of 1/50 from -4
const lumCode = (r: number, g: number, b: number) => {
    const y = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    return Math.max(0, Math.min(255, Math.round((Math.log(0.02 + y) + 4) * 50)));
};
const lumValue = (code: number) => code / 50 - 4;

const NICE = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
// nice values around v: down (largest <= v), up (smallest >= v), nearest
const niceDown = (v: number) => {
    const e = Math.floor(Math.log10(v));
    for (let k = e + 1; k >= e - 1; k--) {
        for (let i = NICE.length - 1; i >= 0; i--) {
            const n = NICE[i] * 10 ** k;
            if (n <= v * (1 + 1e-9)) return n;
        }
    }
    return v;
};
const niceUp = (v: number) => {
    const e = Math.floor(Math.log10(v));
    for (let k = e - 1; k <= e + 1; k++) {
        for (let i = 0; i < NICE.length; i++) {
            const n = NICE[i] * 10 ** k;
            if (n >= v * (1 - 1e-9)) return n;
        }
    }
    return v;
};
const niceCell = (v: number) => {
    const d = niceDown(v), u = niceUp(v);
    return Math.log(v / d) <= Math.log(u / v) ? d : u;
};
const niceNext = (v: number) => niceUp(v * (1 + 1e-6));

const lowerBound = (keys: Float64Array, key: number, lo = 0, hi = keys.length) => {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keys[mid] < key) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};
const findKey = (keys: Float64Array, key: number) => {
    const i = lowerBound(keys, key);
    return i < keys.length && keys[i] === key ? i : -1;
};

const quantileSorted = (s: ArrayLike<number>, q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN);
const medianOf = (v: number[]) => quantileSorted(v.slice().sort((a, b) => a - b), 0.5);
// the median with the mean of the two middle values for an even count: the
// median of -v is exactly minus the median of v (the per-pair values that
// change sign with the scan order: general difference, exposure)
const medianSym = (v: number[]) => {
    const s = v.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return NaN;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// weighted median of values
const weightedMedian = (values: number[], weights: number[]) => {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    let total = 0;
    for (const w of weights) total += w;
    if (!(total > 0)) return NaN;
    let acc = 0;
    for (const i of order) {
        acc += weights[i];
        if (acc >= total / 2) return values[i];
    }
    return values[order[order.length - 1]];
};

// mass of a histogram. The cell bins saturate at 65535 (Uint16), so the
// quantiles take the histogram's own mass as the total, never the opaque
// count: a pile of more than 131k equal splats in one cell would otherwise
// put the median past the last bin (+2 octaves)
const histTotal = (h: ArrayLike<number>, off: number) => {
    let total = 0;
    for (let b = 0; b < BINS; b++) total += h[off + b];
    return total;
};

// quantile of a histogram (log2(sigma / c)), linearly inside the bin; NaN
// for an empty one
const histQuantile = (h: ArrayLike<number>, off: number, q: number) => {
    const total = histTotal(h, off);
    if (!(total > 0)) return NaN;
    const target = total * q;
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
        const v = h[off + b];
        if (v > 0 && acc + v >= target) return HIST_LO + (b + (target - acc) / v) * BIN_WIDTH;
        acc += v;
    }
    return HIST_LO + BINS * BIN_WIDTH;
};
// mass above log2(sigma / c) = x
const histAbove = (h: ArrayLike<number>, off: number, x: number) => {
    let mass = 0;
    for (let b = 0; b < BINS; b++) {
        const lo = HIST_LO + b * BIN_WIDTH, hi = lo + BIN_WIDTH;
        const v = h[off + b];
        if (!v || hi <= x) continue;
        mass += lo >= x ? v : v * (hi - x) / BIN_WIDTH;
    }
    return mass;
};

const popcount = (v: number) => {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
};
const bitCount8 = (v: number) => popcount(v & 0xff);

// ---------------------------------------------------------------- masks

// sub-voxel bit = x + 4y + 16z; lo word z = 0-1, hi word z = 2-3
const X0 = 0x11111111;
const X3 = 0x88888888 | 0;
const Y0 = 0x000F000F;
const Y3 = 0xF000F000 | 0;

const dilX = (m: number) => m | ((m << 1) & ~X0) | ((m >>> 1) & ~X3);
const dilY = (m: number) => m | ((m << 4) & ~Y0) | ((m >>> 4) & ~Y3);

// ball of radius 0 / 1 / 2 sub-voxels around each sub-voxel, clipped to the
// cell: [(sub * 3 + r) * 2] lo, [+1] hi
const BALL = (() => {
    const t = new Uint32Array(64 * 3 * 2);
    for (let s = 0; s < 64; s++) {
        const sx = s & 3, sy = (s >> 2) & 3, sz = s >> 4;
        for (let r = 0; r <= 2; r++) {
            let lo = 0, hi = 0;
            for (let q = 0; q < 64; q++) {
                const qx = q & 3, qy = (q >> 2) & 3, qz = q >> 4;
                const d2 = (qx - sx) ** 2 + (qy - sy) ** 2 + (qz - sz) ** 2;
                if (d2 > r * r) continue;
                if (q < 32) lo |= 1 << q;
                else hi |= 1 << (q - 32);
            }
            t[(s * 3 + r) * 2] = lo >>> 0;
            t[(s * 3 + r) * 2 + 1] = hi >>> 0;
        }
    }
    return t;
})();

// D(M) of one scan at one cell: the 26-dilation by one sub-voxel inside the
// cell plus the facing layers of the 6 face neighbours (dilated within the
// layer). faces: masks of the -x, +x, -y, +y, -z, +z neighbours (0 = none).
const dilate = (lo: number, hi: number, faces: Uint32Array, out: Uint32Array) => {
    let a = dilY(dilX(lo)), b = dilY(dilX(hi));
    let rl = a | (a << 16) | (a >>> 16) | (b << 16);
    let rh = b | (b << 16) | (b >>> 16) | (a >>> 16);
    // x faces: the neighbour's facing layer moved into ours, dilated in y, z
    for (let f = 0; f < 2; f++) {
        const nl = faces[f * 2], nh = faces[f * 2 + 1];
        if (!(nl | nh)) continue;
        const l = f === 0 ? (nl & X3) >>> 3 : (nl & X0) << 3;
        const h = f === 0 ? (nh & X3) >>> 3 : (nh & X0) << 3;
        a = dilY(l);
        b = dilY(h);
        rl |= a | (a << 16) | (a >>> 16) | (b << 16);
        rh |= b | (b << 16) | (b >>> 16) | (a >>> 16);
    }
    // y faces: dilated in x, z
    for (let f = 2; f < 4; f++) {
        const nl = faces[f * 2], nh = faces[f * 2 + 1];
        if (!(nl | nh)) continue;
        const l = f === 2 ? (nl & Y3) >>> 12 : (nl & Y0) << 12;
        const h = f === 2 ? (nh & Y3) >>> 12 : (nh & Y0) << 12;
        a = dilX(l);
        b = dilX(h);
        rl |= a | (a << 16) | (a >>> 16) | (b << 16);
        rh |= b | (b << 16) | (b >>> 16) | (a >>> 16);
    }
    // z faces: dilated in x, y
    if (faces[8] | faces[9]) rl |= dilY(dilX(faces[9] >>> 16));
    if (faces[10] | faces[11]) rh |= dilY(dilX(faces[10] << 16));
    out[0] = rl;
    out[1] = rh;
};

// ---------------------------------------------------------------- auto grid

// opaque centres of one scan, evenly picked (at most autoSamples)
const cellSample = (rows: CompactRows, options: DetailOptions = {}): CellSample => {
    const k = settings(options);
    const ob = opacityByte(k.opaque);
    const n = rows.opacity.length;
    let opaque = 0;
    for (let i = 0; i < n; i++) if (rows.opacity[i] >= ob) opaque++;
    const stride = Math.max(1, Math.ceil(opaque / k.autoSamples));
    const picked = Math.ceil(opaque / stride);
    const positions = new Float32Array(picked * 3);
    let seen = 0, o = 0;
    for (let i = 0; i < n && o < picked * 3; i++) {
        if (rows.opacity[i] < ob) continue;
        if (seen++ % stride) continue;
        positions[o++] = rows.positions[i * 3];
        positions[o++] = rows.positions[i * 3 + 1];
        positions[o++] = rows.positions[i * 3 + 2];
    }
    return { positions: positions.subarray(0, o), weight: o ? opaque / (o / 3) : 1 };
};

// splat-weighted median count of the cells the samples lie in
const weightedCount = (sample: CellSample, c: number) => {
    const p = sample.positions;
    const n = p.length / 3;
    if (!n) return 0;
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = cellKey(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], c);
    keys.sort();
    const runs: number[] = [];
    for (let i = 0; i < n;) {
        let j = i + 1;
        while (j < n && keys[j] === keys[i]) j++;
        runs.push(j - i);
        i = j;
    }
    runs.sort((a, b) => a - b);
    let acc = 0;
    for (const r of runs) {
        acc += r;
        if (acc >= n / 2) return r * sample.weight;
    }
    return runs[runs.length - 1] * sample.weight;
};

// robust diagonal of several scans together (compose-core robustBox each)
const sceneDiagonal = (positions: Float32Array[]) => {
    const boxes = positions.filter(p => p.length >= 3).map(robustBox);
    if (!boxes.length) return 1;
    const lo = [0, 1, 2].map(k => Math.min(...boxes.map(b => b.min[k])));
    const hi = [0, 1, 2].map(k => Math.max(...boxes.map(b => b.max[k])));
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
};

// the auto grid: per scan the smallest nice cell with a splat-weighted median
// of autoTarget opaque splats per occupied cell (three iterations as in
// compareLayers, then snapped), the grid is the largest of them
const autoCell = (samples: CellSample[], diag: number, options: DetailOptions = {}): AutoCell => {
    const k = settings(options);
    const lo = niceUp(diag * k.autoDiagMin);
    const hi = Math.max(lo, niceDown(diag * k.autoDiagMax));
    const perScan = samples.map((sample) => {
        if (sample.positions.length < 3) return lo;
        let v = diag / 120;
        for (let iter = 0; iter < 3; iter++) {
            const count = Math.max(1, weightedCount(sample, v));
            if (Math.abs(count / k.autoTarget - 1) < 0.1) break;
            v *= Math.min(4, Math.max(0.25, Math.sqrt(k.autoTarget / count)));
        }
        // the smallest nice value that reaches the target
        let c = Math.max(lo, Math.min(hi, niceDown(v / 1.6)));
        while (c < hi && weightedCount(sample, c) < k.autoTarget) c = niceNext(c);
        return Math.min(hi, c);
    });
    const cell = Math.max(lo, ...perScan);
    const sorted = perScan.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[(sorted.length - 1) >> 1] : cell;
    const forcedBy = perScan.length > 1 && cell > 1.5 * median ? perScan.indexOf(cell) : -1;
    return { cell, perScan, counts: samples.map(s => weightedCount(s, cell)), forcedBy };
};

// the panel's grid options
const gridCell = (auto: number, mode: 'auto' | 'fine' | 'coarse', options: DetailOptions = {}) => {
    const k = settings(options);
    return mode === 'fine' ? niceCell(auto * k.fine) : mode === 'coarse' ? niceCell(auto * k.coarse) : auto;
};

// ---------------------------------------------------------------- cells

const scanCells = (rows: CompactRows, cell: number, options: DetailOptions = {}): ScanCells => {
    const t0 = now();
    const k = settings(options);
    const c = cell;
    const f = c / 4;
    const ob = opacityByte(k.opaque);
    const p = rows.positions;
    const n = rows.footprint.length;

    // key per row; sorted unique keys; cell per row by binary search
    const rowKey = new Float64Array(n);
    for (let i = 0; i < n; i++) rowKey[i] = cellKey(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], c);
    const sorted = rowKey.slice().sort();
    let C = 0;
    for (let i = 0; i < n; i++) {
        const v = sorted[i];
        if (Number.isNaN(v)) break;
        if (C === 0 || v !== sorted[C - 1]) sorted[C++] = v;
    }
    const keys = sorted.slice(0, C);
    const rowCell = new Int32Array(n);
    let lastKey = NaN, lastCell = -1;
    for (let i = 0; i < n; i++) {
        const v = rowKey[i];
        if (v !== lastKey) {
            lastKey = v;
            lastCell = Number.isNaN(v) ? -1 : findKey(keys, v);
        }
        rowCell[i] = lastCell;
    }

    const cnt = new Uint32Array(C);
    const nAll = new Uint32Array(C);
    const hist = new Uint16Array(C * BINS);
    const lum1 = new Float64Array(C);
    const lum2 = new Float64Array(C);
    const maskLo = new Uint32Array(C);
    const maskHi = new Uint32Array(C);
    const log2c = Math.log2(c);
    const sample: number[] = [];
    let opaque = 0;
    for (let i = 0; i < n; i++) if (rows.opacity[i] >= ob) opaque++;
    const sampleStride = Math.max(1, Math.floor(opaque / 200000));
    let seen = 0;

    for (let i = 0; i < n; i++) {
        const g = rowCell[i];
        if (g < 0) continue;
        nAll[g]++;
        if (rows.opacity[i] < ob) continue;
        cnt[g]++;
        const s = rows.footprint[i];
        if (seen++ % sampleStride === 0) sample.push(s);
        const bin = s > 0 ? Math.max(0, Math.min(BINS - 1, Math.floor((Math.log2(s) - log2c - HIST_LO) / BIN_WIDTH))) : 0;
        const hi = g * BINS + bin;
        if (hist[hi] < 65535) hist[hi]++;
        const l = lumValue(rows.lum[i]);
        lum1[g] += l;
        lum2[g] += l * l;
        // sub-voxel of the centre, plus a ball for big splats
        const x = p[i * 3] / c, y = p[i * 3 + 1] / c, z = p[i * 3 + 2] / c;
        const sx = Math.min(3, Math.floor((x - Math.floor(x)) * 4));
        const sy = Math.min(3, Math.floor((y - Math.floor(y)) * 4));
        const sz = Math.min(3, Math.floor((z - Math.floor(z)) * 4));
        const r = s >= 2 * f ? 2 : s >= f ? 1 : 0;
        const b = ((sx + 4 * sy + 16 * sz) * 3 + r) * 2;
        maskLo[g] |= BALL[b];
        maskHi[g] |= BALL[b + 1];
    }
    sample.sort((a, b) => a - b);
    return {
        cell,
        rows: n,
        keys,
        n: cnt,
        nAll,
        hist,
        lum1: new Float32Array(lum1),
        lum2: new Float32Array(lum2),
        maskLo,
        maskHi,
        rowCell,
        s50: quantileSorted(sample, 0.5),
        seconds: (now() - t0) / 1000
    };
};

// ---------------------------------------------------------------- grid

// neighbours of successive ascending cells in the 27 offsets (dx, dy, dz in
// ascending key order, self at 13): monotone pointers per (dx, dy) column
class Sweep {
    keys: Float64Array;
    ptr = new Int32Array(9);
    out = new Int32Array(27);

    constructor(keys: Float64Array) {
        this.keys = keys;
    }

    at(g: number) {
        const { keys, ptr, out } = this;
        const G = keys.length;
        const key = keys[g];
        for (let col = 0; col < 9; col++) {
            const base = key + ((col / 3 | 0) - 1) * SPAN2 + (col % 3 - 1) * SPAN;
            let q = ptr[col];
            while (q < G && keys[q] < base - 1) q++;
            ptr[col] = q;
            for (let dz = 0; dz < 3; dz++) {
                const want = base + dz - 1;
                while (q < G && keys[q] < want) q++;
                out[col * 3 + dz] = q < G && keys[q] === want ? q : -1;
            }
        }
        return out;
    }
}

// the same for one cell by binary search
const neighbours27 = (keys: Float64Array, g: number, out: Int32Array) => {
    const G = keys.length;
    const key = keys[g];
    for (let col = 0; col < 9; col++) {
        const base = key + ((col / 3 | 0) - 1) * SPAN2 + (col % 3 - 1) * SPAN;
        let q = lowerBound(keys, base - 1);
        for (let dz = 0; dz < 3; dz++) {
            const want = base + dz - 1;
            while (q < G && keys[q] < want) q++;
            out[col * 3 + dz] = q < G && keys[q] === want ? q : -1;
        }
    }
    return out;
};

// face neighbours in the 27 offsets: -x, +x, -y, +y, -z, +z
const FACES = [4, 22, 10, 16, 12, 14];
// the cell and its face neighbours in ascending offset order
const PLUS = [4, 10, 12, 13, 14, 16, 22];

// the scans on one global grid: local cell per global cell, within-cell
// colour variance, popcounts of every mask and of every mask against every
// other scan's dilated mask
type Field = {
    S: number,
    G: number,
    cell: number,
    keys: Float64Array,
    scans: ScanCellsLike[],
    local: Int32Array[],
    ss: Float64Array[],
    // per scan cell: median log2(sigma / c) of its opaque splats (NaN: none)
    med: Float32Array[],
    present: Uint8Array
};

const makeField = (scans: ScanCellsLike[], keys: Float64Array, remap: Int32Array[], k: DetailConstants): Field => {
    const S = scans.length;
    const G = keys.length;
    const local = scans.map((sc, s) => {
        const l = new Int32Array(G).fill(-1);
        remap[s].forEach((g, i) => {
            l[g] = i;
        });
        return l;
    });
    const ss = scans.map((sc) => {
        const C = sc.keys.length;
        const v = new Float64Array(C);
        for (let i = 0; i < C; i++) {
            const n = sc.n[i];
            if (n >= 2) v[i] = Math.max(0, sc.lum2[i] - sc.lum1[i] * sc.lum1[i] / n);
        }
        return v;
    });
    const med = scans.map((sc) => {
        const C = sc.keys.length;
        const v = new Float32Array(C);
        for (let i = 0; i < C; i++) v[i] = histQuantile(sc.hist, i * BINS, 0.5);
        return v;
    });
    const present = new Uint8Array(G);
    for (let s = 0; s < S; s++) {
        const sc = scans[s];
        remap[s].forEach((g, i) => {
            if (sc.n[i] >= k.present) present[g] |= 1 << s;
        });
    }
    return { S, G, cell: scans[0].cell, keys, scans, local, ss, med, present };
};

// the dilated mask of scan t at global cell g with its 27 neighbours nb
const faceScratch = new Uint32Array(12);
const dilatedAt = (field: Field, t: number, g: number, nb: Int32Array, out: Uint32Array) => {
    const sc = field.scans[t];
    const loc = field.local[t];
    for (let f = 0; f < 6; f++) {
        const q = nb[FACES[f]];
        const i = q >= 0 ? loc[q] : -1;
        faceScratch[f * 2] = i >= 0 ? sc.maskLo[i] : 0;
        faceScratch[f * 2 + 1] = i >= 0 ? sc.maskHi[i] : 0;
    }
    const i = loc[g];
    dilate(i >= 0 ? sc.maskLo[i] : 0, i >= 0 ? sc.maskHi[i] : 0, faceScratch, out);
};

// popcounts at one global cell: own[s], inter[s * S + t] = |M_s & D(M_t)|
const dScratch = new Uint32Array(8 * 2);
const popcountsAt = (field: Field, g: number, nb: Int32Array, own: Uint8Array, ownOff: number, inter: Uint8Array, interOff: number) => {
    const { S, scans, local } = field;
    let any = 0;
    for (let s = 0; s < S; s++) {
        const i = local[s][g];
        const v = i >= 0 ? popcount(scans[s].maskLo[i]) + popcount(scans[s].maskHi[i]) : 0;
        own[ownOff + s] = v;
        if (v) any++;
    }
    if (!any) return;
    for (let t = 0; t < S; t++) dilatedAt(field, t, g, nb, dScratch.subarray(t * 2, t * 2 + 2));
    for (let s = 0; s < S; s++) {
        if (!own[ownOff + s]) continue;
        const i = local[s][g];
        const ml = scans[s].maskLo[i], mh = scans[s].maskHi[i];
        for (let t = 0; t < S; t++) {
            if (t === s) continue;
            inter[interOff + s * S + t] = popcount(ml & dScratch[t * 2]) + popcount(mh & dScratch[t * 2 + 1]);
        }
    }
};

// ---------------------------------------------------------------- one cell

// pooled sums of one cell and what follows from them
class Work {
    S: number;
    n: Float64Array;
    hist: Float64Array;
    lum: Float64Array;
    ss: Float64Array;
    own: Float64Array;
    inter: Float64Array;
    // results
    m: Float64Array;
    tau: Float64Array;
    ev: Uint8Array;
    pairEv: Uint8Array;
    // the (confirmed) lead of a pair, and the one weak wins grow on
    lead: Float64Array;
    grow: Float64Array;
    density: Float64Array;
    cover: Float64Array;
    onsurf: Float64Array;
    texRatio: Float64Array;
    pass: Uint8Array;
    reason: Uint8Array;
    // partial: the gates that failed (1 cover, 2 onsurf)
    gate: Uint8Array;
    owner = -1;
    strong = 0;
    weak = 0;
    beaten = 0;
    state = 0;
    rival = -1;
    rivalLoser = -1;
    // per pooled cell and scan: opaque splats and sub-voxels
    cellN: Float64Array;
    cellA: Float64Array;
    // per pair: the confirming per-cell lead (the weighted median of the
    // per-cell leads, or the decided cell's own), and the weighted median
    // alone (antisymmetric: [b * S + a] = -[a * S + b])
    cellLead: Float64Array;
    cellMid: Float64Array;
    // per pair: the decided cell's own lead (count medians of that cell
    // alone; NaN when one has no opaque splats there)
    ownLead: Float64Array;
    leadV = new Float64Array(27);
    leadW = new Float64Array(27);
    leadOrder = new Int32Array(27);
    // pairs of the last evaluate without a per-cell lead to confirm with
    // (confirm on; their lead is capped below the strong lead)
    unconfirmed = 0;

    constructor(S: number) {
        this.S = S;
        this.n = new Float64Array(S);
        this.hist = new Float64Array(S * BINS);
        this.lum = new Float64Array(S);
        this.ss = new Float64Array(S);
        this.own = new Float64Array(S);
        this.inter = new Float64Array(S * S);
        this.m = new Float64Array(S);
        this.tau = new Float64Array(S);
        this.ev = new Uint8Array(S);
        this.pairEv = new Uint8Array(S * S);
        this.lead = new Float64Array(S * S);
        this.grow = new Float64Array(S * S);
        this.density = new Float64Array(S * S);
        this.cover = new Float64Array(S * S);
        this.onsurf = new Float64Array(S * S);
        this.texRatio = new Float64Array(S * S);
        this.pass = new Uint8Array(S * S);
        this.reason = new Uint8Array(S * S);
        this.gate = new Uint8Array(S * S);
        this.cellN = new Float64Array(27 * S);
        this.cellA = new Float64Array(27 * S);
        this.cellLead = new Float64Array(S * S);
        this.cellMid = new Float64Array(S * S);
        this.ownLead = new Float64Array(S * S);
    }

    reset() {
        this.n.fill(0);
        this.hist.fill(0);
        this.lum.fill(0);
        this.ss.fill(0);
        this.own.fill(0);
        this.inter.fill(0);
    }
}

// add pooled cell j (global cell q) to the sums (own / inter: that cell's
// popcounts)
const addCell = (field: Field, w: Work, j: number, q: number, own: Uint8Array, ownOff: number, inter: Uint8Array, interOff: number) => {
    const { S, scans, local, ss } = field;
    for (let s = 0; s < S; s++) {
        const i = local[s][q];
        w.cellN[j * S + s] = i >= 0 ? scans[s].n[i] : 0;
        w.cellA[j * S + s] = i >= 0 ? own[ownOff + s] : 0;
        if (i < 0) continue;
        const sc = scans[s];
        const nq = sc.n[i];
        if (nq) {
            w.n[s] += nq;
            const ho = i * BINS, wo = s * BINS;
            for (let b = 0; b < BINS; b++) w.hist[wo + b] += sc.hist[ho + b];
            w.lum[s] += sc.lum1[i];
            w.ss[s] += ss[s][i];
        }
        w.own[s] += own[ownOff + s];
        for (let t = 0; t < S; t++) w.inter[s * S + t] += inter[interOff + s * S + t];
    }
};

// confirm: per pair of present scans, the weighted median of the per-cell
// leads (cell median of b - cell median of a) over the pooled cells both
// have opaque splats in, weighted by the smaller sub-voxel count of the two
// there (confirmArea; 0: the smaller opaque count). Every comparison stays
// inside one cell, so a surface one scan has just inside the pool and the
// other just outside moves one vote, not the pooled medians. When the weight
// up to a value is exactly half the total, the median is the mean of it and
// the next value: the median of -v is then exactly minus the median of v,
// so both directions of a pair and both scan orders agree (with the lower
// value alone, museum 1<->2 gave a general difference of -0.065 octave in
// one order and +0.027 in the other)
const poolLeads = (field: Field, w: Work, g: number, cells: Int32Array, count: number, pm: number, k: DetailConstants) => {
    const { S, local, med } = field;
    const { cellN, cellA, leadV, leadW, leadOrder, cellLead, cellMid, ownLead } = w;
    cellLead.fill(NaN);
    cellMid.fill(NaN);
    ownLead.fill(NaN);
    // the decided cell's own leads (for weakOwn)
    for (let a = 0; a < S; a++) {
        const ia = local[a][g];
        if (ia < 0) continue;
        for (let b = a + 1; b < S; b++) {
            const ib = local[b][g];
            if (ib < 0) continue;
            const v = med[b][ib] - med[a][ia];
            ownLead[a * S + b] = v;
            ownLead[b * S + a] = -v;
        }
    }
    if (!k.confirm) return;
    for (let a = 0; a < S; a++) {
        if (!((pm >> a) & 1)) continue;
        for (let b = a + 1; b < S; b++) {
            if (!((pm >> b) & 1)) continue;
            let m = 0, total = 0;
            for (let j = 0; j < count; j++) {
                const na = cellN[j * S + a], nb = cellN[j * S + b];
                if (!(na > 0 && nb > 0)) continue;
                const q = cells[j];
                const v = med[b][local[b][q]] - med[a][local[a][q]];
                const wt = k.confirmArea ? Math.min(cellA[j * S + a], cellA[j * S + b]) : Math.min(na, nb);
                if (!Number.isFinite(v) || !(wt > 0)) continue;
                leadV[m] = v;
                leadW[m] = wt;
                leadOrder[m] = m;
                total += wt;
                m++;
            }
            if (!m) continue;
            const idx = leadOrder.subarray(0, m);
            idx.sort((x, y) => leadV[x] - leadV[y] || x - y);
            // the weights are whole counts, so the sums and the half are exact
            let acc = 0, lead = leadV[idx[m - 1]];
            for (let t = 0; t < m; t++) {
                acc += leadW[idx[t]];
                if (acc >= total / 2) {
                    lead = acc === total / 2 && t + 1 < m ? (leadV[idx[t]] + leadV[idx[t + 1]]) / 2 : leadV[idx[t]];
                    break;
                }
            }
            cellMid[a * S + b] = lead;
            cellMid[b * S + a] = -lead;
            // the decided cell itself confirms on its own when it holds the
            // full strong lead with confirmCentre splats of each scan (a small
            // object can fill one coarse cell of the pool and no more)
            let up = lead, down = -lead;
            let self = -1;
            for (let j = 0; j < count; j++) if (cells[j] === g) self = j;
            if (k.confirmCentre > 0 && self >= 0 && cellN[self * S + a] >= k.confirmCentre && cellN[self * S + b] >= k.confirmCentre) {
                const v = med[b][local[b][g]] - med[a][local[a][g]];
                const strong = Math.log2(k.lead);
                if (v >= strong) up = Math.max(up, v - k.confirmMargin * strong);
                if (-v >= strong) down = Math.max(down, -v - k.confirmMargin * strong);
            }
            cellLead[a * S + b] = up;
            cellLead[b * S + a] = down;
        }
    }
};

// which cells a decision pools (into out, ascending offsets): the cell
// alone when every present scan has `single` opaque splats there (0), the
// cell and its 6 face neighbours when they have `facePool` there (1), else
// all 27 cells (2)
const poolSet = (field: Field, g: number, nb: Int32Array, pm: number, k: DetailConstants, out: Int32Array) => {
    const { S, scans, local } = field;
    let alone = true, plus = true;
    for (let s = 0; s < S; s++) {
        if (!((pm >> s) & 1)) continue;
        const sc = scans[s], loc = local[s];
        if (sc.n[loc[g]] < k.single) alone = false;
        let n = 0;
        for (const j of PLUS) {
            const q = nb[j];
            const i = q >= 0 ? loc[q] : -1;
            if (i >= 0) n += sc.n[i];
        }
        if (n < k.facePool) plus = false;
    }
    let count = 0;
    if (alone) {
        out[count++] = g;
        return { mode: 0, count };
    }
    if (plus) {
        for (const j of PLUS) if (nb[j] >= 0) out[count++] = nb[j];
        return { mode: 1, count };
    }
    for (let j = 0; j < 27; j++) if (nb[j] >= 0) out[count++] = nb[j];
    return { mode: 2, count };
};

// the decision for one cell from its pooled sums (pm: present scans)
const evaluate = (w: Work, pm: number, k: DetailConstants, A_S: number, A_W: number) => {
    const S = w.S;
    for (let s = 0; s < S; s++) {
        w.m[s] = histQuantile(w.hist, s * BINS, 0.5);
        w.tau[s] = w.n[s] >= 2 ? Math.sqrt(Math.max(0, w.ss[s]) / w.n[s]) : NaN;
    }
    // evidence for a size: 20 splats, or 4 next to a scan with 8x as many
    for (let s = 0; s < S; s++) {
        const n = w.n[s];
        let ev = n >= k.minLoser;
        if (!ev && n >= k.roughMin) {
            for (let t = 0; t < S; t++) {
                if (t !== s && (pm >> t) & 1 && w.n[t] >= k.minWinner && w.n[t] >= k.roughRatio * n) ev = true;
            }
        }
        w.ev[s] = ev ? 1 : 0;
    }
    w.pass.fill(0);
    w.reason.fill(0);
    w.gate.fill(0);
    w.pairEv.fill(0);
    w.beaten = 0;
    w.unconfirmed = 0;
    for (let a = 0; a < S; a++) {
        if (!((pm >> a) & 1)) continue;
        for (let b = 0; b < S; b++) {
            if (b === a || !((pm >> b) & 1)) continue;
            const o = a * S + b;
            const nw = w.n[a], nl = w.n[b];
            // the pooled lead, confirmed by the per-cell leads (see DETAIL).
            // Without a per-cell lead (no pooled cell with opaque splats of
            // both) it fails closed: counted as a per-cell lead of 0, so at
            // most confirmMargin * the strong lead - never a strong win (that
            // is the case the confirmation is for: two surfaces in disjoint
            // cells); weak growth keeps the pooled lead (confirmWeak 0).
            // Both scans are present in the decided cell itself, so it does
            // not happen there: 0 cells in every harness run (diag.unconfirmed)
            const pooled = w.m[b] - w.m[a];
            let lead = pooled;
            if (k.confirm) {
                const cellLead = w.cellLead[o];
                if (Number.isNaN(cellLead)) w.unconfirmed++;
                lead = Math.min(pooled, (Number.isNaN(cellLead) ? 0 : cellLead) + k.confirmMargin * A_S);
            }
            const density = nl > 0 ? nw / nl : Infinity;
            // a share that cannot be measured (no sub-voxels) fails its gate
            const cover = w.own[b] > 0 ? w.inter[b * S + a] / w.own[b] : 0;
            const onsurf = w.own[a] > 0 ? w.inter[a * S + b] / w.own[a] : 0;
            const tl = w.tau[b], tw = w.tau[a];
            const texRatio = tl > 0 ? (tw >= 0 ? tw : 0) / tl : Infinity;
            w.lead[o] = lead;
            w.density[o] = density;
            w.cover[o] = w.own[b] > 0 ? cover : NaN;
            w.onsurf[o] = w.own[a] > 0 ? onsurf : NaN;
            w.texRatio[o] = texRatio;
            const evid = nw >= k.minWinner && (nl >= k.minLoser || (nl >= k.roughMin && nw >= k.roughRatio * nl));
            if (!evid) continue;
            w.pairEv[o] = 1;
            const veto = tl >= k.textureMin && texRatio < k.textureRatio;
            const strong = lead >= A_S && density >= k.densityStrong && cover >= k.coverStrong && onsurf >= k.onsurfStrong && !veto;
            // weak wins only grow regions from strong seeds: confirmWeak 0
            // lets them grow on the pooled lead alone; with weakOwn the cell
            // itself must also show W finer by weakOwn * the strong lead (its
            // own count medians; see DETAIL)
            const growLead = k.confirmWeak ? lead : pooled;
            w.grow[o] = growLead;
            const own = w.ownLead[o];
            const ownOk = k.weakOwn === -Infinity || Number.isNaN(own) || own >= k.weakOwn * A_S;
            const weak = !strong && growLead >= A_W && ownOk && density >= k.densityWeak && cover >= k.coverWeak && onsurf >= k.onsurfWeak && !veto;
            if (strong || weak) {
                w.pass[o] = strong ? 2 : 1;
                w.beaten |= 1 << b;
            } else if (lead >= A_S) {
                // the check that failed (weak thresholds), in priority order
                const gate = (cover < k.coverWeak ? 1 : 0) | (onsurf < k.onsurfWeak ? 2 : 0);
                w.gate[o] = gate;
                w.reason[o] = gate ? CellState.partial : density < k.densityWeak ? CellState.sparse : CellState.texture;
            }
        }
    }
    // owner: the largest benefit over its beaten scans; ties to the finer
    // scan, then the lower index
    let owner = -1, best = -Infinity;
    for (let a = 0; a < S; a++) {
        let win = false, score = 0;
        for (let b = 0; b < S; b++) {
            const p = w.pass[a * S + b];
            if (!p) continue;
            win = true;
            score += (p === 2 ? w.lead[a * S + b] : w.grow[a * S + b]) * (p === 2 ? 1 : 0.5);
        }
        if (!win) continue;
        if (owner < 0 || score > best + k.ownerTie || (Math.abs(score - best) <= k.ownerTie && w.m[a] < w.m[owner])) {
            owner = a;
            best = score;
        }
    }
    w.owner = owner;
    w.strong = 0;
    w.weak = 0;
    w.rival = -1;
    w.rivalLoser = -1;
    if (owner >= 0) {
        for (let b = 0; b < S; b++) {
            const p = w.pass[owner * S + b];
            if (p === 2) w.strong |= 1 << b;
            else if (p === 1) w.weak |= 1 << b;
        }
        w.state = w.strong ? CellState.strong : CellState.weak;
        return;
    }
    let failLead = -Infinity, anyEv = false;
    for (let a = 0; a < S; a++) {
        for (let b = 0; b < S; b++) {
            const o = a * S + b;
            if (w.pairEv[o]) anyEv = true;
            if (w.reason[o] && w.lead[o] > failLead) {
                failLead = w.lead[o];
                w.rival = a;
                w.rivalLoser = b;
            }
        }
    }
    w.state = w.rival >= 0 ? w.reason[w.rival * S + w.rivalLoser] : anyEv ? CellState.tie : CellState.thin;
};

// a cell's lead of a over b for the general difference: the pooled lead,
// clamped to the weighted median of the per-cell leads +- confirmMargin *
// the strong lead. Unlike the one-sided confirmed lead of the decision
// (min(pooled, median + margin)), it is antisymmetric - lead(b, a) is
// exactly -lead(a, b) - so the median over the cells does not depend on
// which scan comes first
const biasLead = (w: Work, a: number, b: number, k: DetailConstants, A_S: number) => {
    const pooled = w.m[b] - w.m[a];
    const mid = w.cellMid[a * w.S + b];
    if (!k.confirm || Number.isNaN(mid)) return pooled;
    const margin = k.confirmMargin * A_S;
    return Math.max(mid - margin, Math.min(mid + margin, pooled));
};

// ---------------------------------------------------------------- views

// the robust box of the present cells: per axis the 1st-99th percentile of
// the cell coordinates (every step-th cell, at most about 50 000), world
// units; the scanned volume for the free views and the scene size
const presentBox = (keys: Float64Array, present: Uint8Array, c: number) => {
    const G = keys.length;
    const axes: number[][] = [[], [], []];
    const step = Math.max(1, Math.floor(G / 50000));
    for (let g = 0; g < G; g += step) {
        if (!present[g]) continue;
        const v = decode(keys[g]);
        for (let a = 0; a < 3; a++) axes[a].push(v[a]);
    }
    const min: V3 = [0, 0, 0], max: V3 = [c, c, c];
    axes.forEach((v, a) => {
        v.sort((x, y) => x - y);
        if (!v.length) return;
        min[a] = quantileSorted(v, 0.01) * c;
        max[a] = (quantileSorted(v, 0.99) + 1) * c;
    });
    return { min, max };
};

// free views on the cell grid (the floaters.ts scheme, made safe for scans
// of interiors; constants view* in DETAIL): of 8 azimuths around the up axis
// at each of viewElevations, the two directions that let the camera stand
// farthest off the region, at least 60 degrees apart, cameras in a scanned
// room first (viewEnclosed). Each line runs from `centre` (the caller
// passes the region's marker, which is also the target) through every cell
// it touches (3-D DDA) and ends at the first present cell that is neither
// the region's nor its ring's (an obstacle: the view would look through it)
// or where it leaves the robust box of the present cells (grown by
// viewMargin cells and by the region's own box: the scanned volume), at most
// at `want`; the camera stands at viewBack * that length, on an empty cell,
// at least viewMin cells off, and the first present cell it sees towards the
// target is the region's. A line through more than viewGraze cells of the
// region (its ring's do not count) grazes it and is not taken. No line
// left: no views (compose-suggest then focuses the marker)
const freeViews = (k: DetailConstants, keys: Float64Array, present: Uint8Array, own: Uint8Array, box: { min: V3, max: V3 }, c: number, centre: V3, radius: number, regionMin: V3, regionMax: V3, upAxis: number, upSign: number, sceneSize: number): FreeView[] => {
    const dirs: V3[] = [];
    for (const elevation of k.viewElevations) {
        for (let i = 0; i < 8; i++) {
            const azimuth = i * Math.PI / 4 + k.viewTurn;
            const ce = Math.cos(elevation);
            const d: V3 = [Math.cos(azimuth) * ce, Math.sin(elevation), Math.sin(azimuth) * ce];
            dirs.push(upAxis === 1 ? [d[0], d[1] * upSign, d[2]] : upAxis === 2 ? [d[0], d[2], d[1] * upSign] : [d[1] * upSign, d[0], d[2]]);
        }
    }
    const want = Math.min(Math.max(3 * radius, 4 * c), Math.max(4 * c, 0.3 * sceneSize));
    const lo = [0, 1, 2].map(a => Math.min(box.min[a], regionMin[a]) - k.viewMargin * c);
    const hi = [0, 1, 2].map(a => Math.max(box.max[a], regionMax[a]) + k.viewMargin * c);
    // a cell: 0 empty, 1 the region's, 3 its ring's (own: 1 region, 2
    // ring), 2 an obstacle (present, not the region's or its ring's)
    const kind = (ix: number, iy: number, iz: number) => {
        const g = findKey(keys, keyOf(ix, iy, iz));
        if (g < 0) return 0;
        if (own[g]) return own[g] === 1 ? 1 : 3;
        return present[g] ? 2 : 0;
    };
    // DDA scratch: the current cell, the distance to the next face per
    // axis, the distance between faces, the step, the point
    const cell = [0, 0, 0], next = [0, 0, 0], delta = [0, 0, 0], stepOf = [0, 0, 0], at = [0, 0, 0];
    // seen from the camera, the first present cell towards the centre must
    // be the region's: a line that left through its ring (where the region
    // meets a wall, say) would look at it from behind that surface
    const seesRegion = (d: V3, dist: number) => {
        const p = [centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist];
        for (let a = 0; a < 3; a++) {
            cell[a] = Math.floor(p[a] / c);
            stepOf[a] = d[a] > 0 ? -1 : 1;
            delta[a] = Math.abs(d[a]) > 1e-12 ? c / Math.abs(d[a]) : Infinity;
            next[a] = Math.abs(d[a]) > 1e-12 ? ((cell[a] + (d[a] > 0 ? 0 : 1)) * c - p[a]) / -d[a] : Infinity;
        }
        for (let t = 0; t <= dist;) {
            const g = findKey(keys, keyOf(cell[0], cell[1], cell[2]));
            if (g >= 0 && present[g]) return own[g] === 1;
            const a = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
            t = next[a];
            next[a] += delta[a];
            cell[a] += stepOf[a];
        }
        return true;
    };
    const inside = (p: number[]) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2];
    // does the ray from p along d meet a present cell before it leaves the
    // scanned volume (viewEnclosed)
    const meets = (p: number[], d: V3) => {
        for (let a = 0; a < 3; a++) {
            cell[a] = Math.floor(p[a] / c);
            stepOf[a] = d[a] > 0 ? 1 : -1;
            delta[a] = Math.abs(d[a]) > 1e-12 ? c / Math.abs(d[a]) : Infinity;
            next[a] = Math.abs(d[a]) > 1e-12 ? ((cell[a] + (d[a] > 0 ? 1 : 0)) * c - p[a]) / d[a] : Infinity;
        }
        for (let t = 0; ;) {
            for (let a = 0; a < 3; a++) at[a] = p[a] + d[a] * t;
            if (!inside(at)) return false;
            const g = findKey(keys, keyOf(cell[0], cell[1], cell[2]));
            if (g >= 0 && present[g]) return true;
            const a = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
            t = next[a];
            next[a] += delta[a];
            cell[a] += stepOf[a];
        }
    };
    const distance = dirs.map((d) => {
        // every cell the line passes, in order (3-D DDA): the free length
        // ends at the entry of an obstacle cell or exactly where the line
        // leaves the box (at most `want`)
        let exit = want;
        for (let a = 0; a < 3; a++) {
            cell[a] = Math.floor(centre[a] / c);
            stepOf[a] = d[a] > 0 ? 1 : -1;
            delta[a] = Math.abs(d[a]) > 1e-12 ? c / Math.abs(d[a]) : Infinity;
            next[a] = Math.abs(d[a]) > 1e-12 ? ((cell[a] + (d[a] > 0 ? 1 : 0)) * c - centre[a]) / d[a] : Infinity;
            if (Math.abs(d[a]) > 1e-12) exit = Math.min(exit, ((d[a] > 0 ? hi[a] : lo[a]) - centre[a]) / d[a]);
        }
        let graze = 0, free = exit, t = 0;
        for (;;) {
            const v = kind(cell[0], cell[1], cell[2]);
            if (v === 2) {
                free = t;
                break;
            }
            if (v === 1 && ++graze > k.viewGraze) return 0;
            const a = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
            t = next[a];
            if (t >= exit) break;
            next[a] += delta[a];
            cell[a] += stepOf[a];
        }
        // the camera on an empty cell before the end of the line
        let dist = k.viewBack * free;
        const step = 0.5 * c;
        const emptyAt = (s: number) => kind(Math.floor((centre[0] + d[0] * s) / c), Math.floor((centre[1] + d[1] * s) / c), Math.floor((centre[2] + d[2] * s) / c)) === 0;
        while (dist >= k.viewMin * c && !emptyAt(dist)) dist -= step;
        return dist >= k.viewMin * c && seesRegion(d, dist) ? dist : 0;
    });
    // is a camera enclosed: do the rays of at least viewEnclosed of the 26
    // directions of the 3 x 3 x 3 neighbourhood meet a present cell in the
    // scanned volume (a camera in a scanned room, not behind its wall or
    // above its roof)
    const around: V3[] = [];
    for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
            for (let z = -1; z <= 1; z++) {
                const l = Math.hypot(x, y, z);
                if (l) around.push([x / l, y / l, z / l]);
            }
        }
    }
    const need = Math.ceil(k.viewEnclosed * around.length);
    const enclosedAt = (i: number) => {
        const d = dirs[i], dist = distance[i];
        const p = [centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist];
        let hit = 0, miss = 0;
        for (const a of around) {
            if (meets(p, a)) hit++;
            else miss++;
            if (hit >= need) return true;
            if (miss > around.length - need) return false;
        }
        return false;
    };
    // the farthest cameras at least 60 degrees apart, enclosed ones first
    // (their enclosure is measured only where it could decide), then the
    // others
    const order = dirs.map((_, i) => i).filter(i => distance[i] > 0).sort((a, b) => distance[b] - distance[a] || a - b);
    const apart60 = (i: number, list: number[]) => !list.some(j => dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2] > 0.5);
    const picked: number[] = [];
    for (const i of order) {
        if (picked.length === 2) break;
        if (apart60(i, picked) && enclosedAt(i)) picked.push(i);
    }
    for (const i of order) {
        if (picked.length === 2) break;
        if (!picked.includes(i) && apart60(i, picked)) picked.push(i);
    }
    return picked.map((i) => {
        const d = dirs[i], t = distance[i];
        return { position: [centre[0] + d[0] * t, centre[1] + d[1] * t, centre[2] + d[2] * t], target: [centre[0], centre[1], centre[2]] };
    });
};

// ---------------------------------------------------------------- regions

type RegionContext = {
    field: Field,
    k: DetailConstants,
    sharedIndex: Int32Array,
    owner: Int8Array,
    strong: Uint8Array,
    size: Float32Array,
    cover: Float32Array,
    pairShared: Uint32Array,
    mark: Uint8Array,
    upAxis: number,
    upSign: number,
    sceneSize: number,
    // the robust box of the present cells (presentBox)
    box: { min: V3, max: V3 }
};

const cellCentre = (key: number, c: number): V3 => {
    const [x, y, z] = decode(key);
    return [(x + 0.5) * c, (y + 0.5) * c, (z + 0.5) * c];
};

// a region of winner W over the given cells (ascending): ring, hide cells
// and numbers per loser, shape, scope, benefit, marker, free views
const buildRegion = (ctx: RegionContext, W: number, losers: number[], cells: Int32Array): Region => {
    const { field, k, sharedIndex, owner, strong, size, cover, pairShared, mark } = ctx;
    const { S, keys, scans, local, ss, present, med } = field;
    const c = field.cell;
    const f = c / 4;
    const nb = new Int32Array(27);

    // ring: neighbours outside the region
    cells.forEach((g) => {
        mark[g] = 1;
    });
    const ringList: number[] = [];
    cells.forEach((g) => {
        neighbours27(keys, g, nb);
        for (let j = 0; j < 27; j++) {
            const q = nb[j];
            if (q >= 0 && !mark[q]) {
                mark[q] = 2;
                ringList.push(q);
            }
        }
    });
    ringList.sort((a, b) => a - b);
    ringList.forEach((g) => {
        mark[g] = 0;
    });
    cells.forEach((g) => {
        mark[g] = 0;
    });

    let strongCells = 0;
    cells.forEach((g) => {
        const h = sharedIndex[g];
        if (h >= 0 && owner[h] === W && strong[h]) strongCells++;
    });

    const scW = scans[W];
    const locW = local[W];
    const ownLead = k.closeOwnLead * Math.log2(k.lead);
    const holdLead = k.holdOwn * Math.log2(k.lead);
    // the hold test's lead of W over L at cell g (holdOwn): count medians
    // of the cell alone (holdPool 0) or of it and its 6 face neighbours (1);
    // NaN when one of the two has no opaque splats there
    const holdNb = new Int32Array(27);
    const holdW = new Float64Array(BINS), holdL = new Float64Array(BINS);
    const holdLeadAt = (L: number, g: number) => {
        const scL = scans[L], locL = local[L];
        holdW.fill(0);
        holdL.fill(0);
        let nW = 0, nL = 0;
        const add = (q: number) => {
            const iW = locW[q], iL = locL[q];
            if (iW >= 0 && scW.n[iW]) {
                nW += scW.n[iW];
                for (let b = 0; b < BINS; b++) holdW[b] += scW.hist[iW * BINS + b];
            }
            if (iL >= 0 && scL.n[iL]) {
                nL += scL.n[iL];
                for (let b = 0; b < BINS; b++) holdL[b] += scL.hist[iL * BINS + b];
            }
        };
        if (k.holdPool) {
            neighbours27(keys, g, holdNb);
            for (const j of PLUS) if (holdNb[j] >= 0) add(holdNb[j]);
        } else {
            add(g);
        }
        return nW && nL ? histQuantile(holdL, 0, 0.5) - histQuantile(holdW, 0, 0.5) : NaN;
    };
    const hideCells: Int32Array[] = [];
    const holdCells: Int32Array[] = [];
    const perLoser: LoserNumbers[] = [];
    const leadValues: number[] = [];
    const leadWeights: number[] = [];
    let benefit = 0;
    for (const L of losers) {
        const scL = scans[L];
        const locL = local[L];
        const hide: number[] = [];
        const hold: number[] = [];
        const histW = new Float64Array(BINS), histL = new Float64Array(BINS);
        let nW = 0, nL = 0, ssW = 0, ssL = 0, rows = 0;
        const covers: number[] = [];
        const lv: number[] = [], lw: number[] = [];
        for (let ci = 0; ci < cells.length; ci++) {
            const g = cells[ci];
            const iL = locL[g];
            if (iL < 0 || !scL.nAll[iL]) continue;
            const h = sharedIndex[g];
            const sL = h >= 0 ? size[h * S + L] : NaN, sW = h >= 0 ? size[h * S + W] : NaN;
            const iW = locW[g];
            // the loser is finer here itself: keep its rows - unless the cell
            // alone shows W finer by closeOwnLead * the strong lead (a tie
            // the closing took for that: the pool around it hides it)
            if (sL < sW && !(k.closeOwn && iW >= 0 && med[L][iL] - med[W][iW] >= ownLead)) continue;
            hide.push(g);
            // W does not beat L strongly here and the cell alone shows W
            // finer by less than holdOwn * the strong lead: L's rows are held
            if (holdLead > -Infinity && !(h >= 0 && owner[h] === W && (strong[h] >> L) & 1) && holdLeadAt(L, g) < holdLead) hold.push(g);
            rows += scL.nAll[iL];
            nL += scL.n[iL];
            ssL += ss[L][iL];
            for (let b = 0; b < BINS; b++) histL[b] += scL.hist[iL * BINS + b];
            let ml = scL.maskLo[iL], mh = scL.maskHi[iL];
            if (iW >= 0) {
                nW += scW.n[iW];
                ssW += ss[W][iW];
                for (let b = 0; b < BINS; b++) histW[b] += scW.hist[iW * BINS + b];
                ml |= scW.maskLo[iW];
                mh |= scW.maskHi[iW];
            }
            if (h >= 0 && Number.isFinite(cover[h * S + L])) covers.push(cover[h * S + L]);
            const area = (popcount(ml) + popcount(mh)) * f * f / 2;
            const a = Math.log2(sL / sW);
            if (Number.isFinite(a)) {
                lv.push(a);
                lw.push(area);
                benefit += area * Math.max(0, Math.min(k.benefitCap, a));
            }
        }
        const mW = histQuantile(histW, 0, 0.5);
        const tauW = nW ? Math.sqrt(ssW / nW) : NaN, tauL = nL ? Math.sqrt(ssL / nL) : NaN;
        // holdRing: L's big ring splats are held where the ring cell alone
        // shows W finer by less than holdOwn * the strong lead
        if (holdLead > -Infinity && k.holdRing) {
            ringList.forEach((g) => {
                if (holdLeadAt(L, g) < holdLead) hold.push(g);
            });
            hold.sort((a, b) => a - b);
        }
        const massL = histTotal(histL, 0);
        hideCells.push(new Int32Array(hide));
        holdCells.push(new Int32Array(hold));
        perLoser.push({
            scan: L,
            sizeW: c * 2 ** mW,
            sizeL: c * 2 ** histQuantile(histL, 0, 0.5),
            q25W: c * 2 ** histQuantile(histW, 0, 0.25),
            q75W: c * 2 ** histQuantile(histW, 0, 0.75),
            q25L: c * 2 ** histQuantile(histL, 0, 0.25),
            q75L: c * 2 ** histQuantile(histL, 0, 0.75),
            density: nL ? nW / nL : Infinity,
            texture: tauL > 0 ? tauW / tauL : NaN,
            tauW,
            tauL,
            big: massL > 0 && Number.isFinite(mW) ? histAbove(histL, 0, mW + 1) / massL : NaN,
            cover: covers.length ? medianOf(covers) : NaN,
            rows,
            lead: weightedMedian(lv, lw)
        });
        lv.forEach((v, i) => {
            leadValues.push(v);
            leadWeights.push(lw[i]);
        });
    }

    // box, shape, dims (horizontal x horizontal x height)
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const centroid = [0, 0, 0];
    let weight = 0;
    cells.forEach((g) => {
        const [x, y, z] = decode(keys[g]);
        const v = [x, y, z];
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], v[a] * c);
            max[a] = Math.max(max[a], (v[a] + 1) * c);
        }
        const i = locW[g];
        const wgt = i >= 0 ? scW.n[i] : 0;
        for (let a = 0; a < 3; a++) centroid[a] += (v[a] + 0.5) * c * wgt;
        weight += wgt;
    });
    const ext = [0, 1, 2].map(a => max[a] - min[a]);
    const d = ext.slice().sort((a, b) => b - a);
    const shape = d[2] <= k.surfaceThin * c && d[1] >= k.surfaceWide * c ? 'surface' : 'object';
    const up = ctx.upAxis;
    const horizontal = [0, 1, 2].filter(a => a !== up).map(a => ext[a]).sort((a, b) => b - a);
    const dims: V3 = [horizontal[0], horizontal[1], ext[up]];

    // base scope: more than baseShare of a pair's shared cells
    let base = false;
    losers.forEach((L) => {
        let inPair = 0;
        cells.forEach((g) => {
            if ((present[g] >> L) & 1 && (present[g] >> W) & 1) inPair++;
        });
        const total = pairShared[W * S + L];
        if (total && inPair / total > k.baseShare) base = true;
    });

    // marker: the region cell nearest to the n_W-weighted centroid
    if (weight > 0) for (let a = 0; a < 3; a++) centroid[a] /= weight;
    else for (let a = 0; a < 3; a++) centroid[a] = (min[a] + max[a]) / 2;
    let marker: V3 = cellCentre(keys[cells[0]], c);
    let bestD = Infinity;
    cells.forEach((g) => {
        const p = cellCentre(keys[g], c);
        const e = (p[0] - centroid[0]) ** 2 + (p[1] - centroid[1]) ** 2 + (p[2] - centroid[2]) ** 2;
        if (e < bestD) {
            bestD = e;
            marker = p;
        }
    });

    const radius = 0.5 * Math.hypot(ext[0], ext[1], ext[2]);
    // the views see through the region (mark 1) and its ring (2), not
    // through anything else, and look at the marker: a region cell, so the
    // camera faces the region's own surface (the box centre of a curved or
    // L-shaped region lies in the air: museum 1<->2 #0, 33 x 26 m, its
    // first view's rays within 8 degrees met nothing in 42 of 49)
    cells.forEach((g) => {
        mark[g] = 1;
    });
    ringList.forEach((g) => {
        mark[g] = 2;
    });
    const views = freeViews(k, keys, present, mark, ctx.box, c, marker, radius, min, max, ctx.upAxis, ctx.upSign, ctx.sceneSize);
    cells.forEach((g) => {
        mark[g] = 0;
    });
    ringList.forEach((g) => {
        mark[g] = 0;
    });
    return {
        id: -1,
        winner: W,
        losers: losers.slice(),
        cells,
        ring: new Int32Array(ringList),
        hideCells,
        ...(holdLead > -Infinity ? { holdCells } : {}),
        strongCells,
        shape,
        scope: base ? 'base' : 'local',
        dims,
        min,
        max,
        marker,
        benefit,
        lead: weightedMedian(leadValues, leadWeights),
        perLoser,
        views
    };
};

const boxOf = (keys: Float64Array, cells: ArrayLike<number>, c: number) => {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const centre: V3 = [0, 0, 0];
    for (let i = 0; i < cells.length; i++) {
        const v = decode(keys[cells[i]]);
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], v[a] * c);
            max[a] = Math.max(max[a], (v[a] + 1) * c);
            centre[a] += (v[a] + 0.5) * c / cells.length;
        }
    }
    return { min, max, centre };
};

// 26-connected groups of the given cells (ascending), in ascending order of
// their first cell
const connected = (keys: Float64Array, cells: number[], mark: Uint8Array) => {
    const nb = new Int32Array(27);
    cells.forEach((g) => {
        mark[g] = 1;
    });
    const groups: number[][] = [];
    for (const start of cells) {
        if (mark[start] !== 1) continue;
        mark[start] = 2;
        const group = [start];
        for (let i = 0; i < group.length; i++) {
            neighbours27(keys, group[i], nb);
            for (let j = 0; j < 27; j++) {
                const q = nb[j];
                if (q >= 0 && mark[q] === 1) {
                    mark[q] = 2;
                    group.push(q);
                }
            }
        }
        group.sort((a, b) => a - b);
        groups.push(group);
    }
    cells.forEach((g) => {
        mark[g] = 0;
    });
    return groups;
};

// ---------------------------------------------------------------- detail

const composeDetail = (scans: ScanCellsLike[], options: DetailOptions = {}): DetailResult => {
    const t0 = now();
    const k = settings(options);
    const S = scans.length;
    if (S < 2 || S > 8) throw new Error('composeDetail: 2-8 scans');
    const c = scans[0].cell;
    const f = c / 4;
    const A_S = Math.log2(k.lead);
    const A_W = A_S * k.weakLead;
    const upAxis = options.upAxis ?? 1;
    const upSign = options.upSign ?? 1;

    // 1. global cells: k-way merge of the scans' sorted keys
    const total = scans.reduce((sum, sc) => sum + sc.keys.length, 0);
    const merged = new Float64Array(total);
    const remap = scans.map(sc => new Int32Array(sc.keys.length));
    const ptr = new Int32Array(S);
    let G = 0;
    for (;;) {
        let min = Infinity;
        for (let s = 0; s < S; s++) if (ptr[s] < scans[s].keys.length && scans[s].keys[ptr[s]] < min) min = scans[s].keys[ptr[s]];
        if (min === Infinity) break;
        for (let s = 0; s < S; s++) {
            if (ptr[s] < scans[s].keys.length && scans[s].keys[ptr[s]] === min) remap[s][ptr[s]++] = G;
        }
        merged[G++] = min;
    }
    const keys = merged.slice(0, G);
    const field = makeField(scans, keys, remap, k);
    const { local, present } = field;

    // 2. popcounts of every mask against every other scan's dilated mask
    const own = new Uint8Array(G * S);
    const inter = new Uint8Array(G * S * S);
    {
        const sweep = new Sweep(keys);
        for (let g = 0; g < G; g++) {
            const nb = sweep.at(g);
            popcountsAt(field, g, nb, own, g * S, inter, g * S * S);
        }
    }

    // 3. decision per shared cell
    const sharedIndex = new Int32Array(G).fill(-1);
    let H = 0;
    for (let g = 0; g < G; g++) if (bitCount8(present[g]) >= 2) sharedIndex[g] = H++;
    const shared = new Int32Array(H);
    for (let g = 0; g < G; g++) if (sharedIndex[g] >= 0) shared[sharedIndex[g]] = g;
    const owner = new Int8Array(H).fill(-1);
    const strong = new Uint8Array(H);
    const weak = new Uint8Array(H);
    const beaten = new Uint8Array(H);
    const state = new Uint8Array(H);
    const pooled = new Uint8Array(H);
    const rival = new Int8Array(H).fill(-1);
    const rivalLoser = new Int8Array(H).fill(-1);
    const size = new Float32Array(H * S).fill(NaN);
    const count = new Uint32Array(H * S);
    const texture = new Float32Array(H * S).fill(NaN);
    const cover = new Float32Array(H * S).fill(NaN);
    // partial cells: the gates that failed for the rival pair and its onsurf
    // share (for the rejected clusters' gate and value)
    const gateOf = new Uint8Array(H);
    const onsurfOf = new Float32Array(H).fill(NaN);

    // per pair accumulators
    const pairShared = new Uint32Array(S * S);
    const pairArea = new Float64Array(S * S);
    const pairClear = new Uint32Array(S * S);
    const biasList = Array.from({ length: S * S }, (): number[] => []);
    const expList = Array.from({ length: S * S }, (): number[] => []);

    const w = new Work(S);
    const sweep = new Sweep(keys);
    const poolCells = new Int32Array(27);
    let unconfirmed = 0;
    for (let h = 0; h < H; h++) {
        const g = shared[h];
        const pm = present[g];
        const nb = sweep.at(g);
        const pool = poolSet(field, g, nb, pm, k, poolCells);
        pooled[h] = pool.mode;
        w.reset();
        for (let j = 0; j < pool.count; j++) {
            const q = poolCells[j];
            addCell(field, w, j, q, own, q * S, inter, q * S * S);
        }
        poolLeads(field, w, g, poolCells, pool.count, pm, k);
        evaluate(w, pm, k, A_S, A_W);
        if (w.unconfirmed) unconfirmed++;
        owner[h] = w.owner;
        strong[h] = w.strong;
        weak[h] = w.weak;
        beaten[h] = w.beaten;
        state[h] = w.state;
        rival[h] = w.rival;
        rivalLoser[h] = w.rivalLoser;
        if (w.state === CellState.partial) {
            const o = w.rival * S + w.rivalLoser;
            gateOf[h] = w.gate[o];
            onsurfOf[h] = w.onsurf[o];
        }
        const ref = w.owner >= 0 ? w.owner : w.rival;
        for (let s = 0; s < S; s++) {
            const o = h * S + s;
            count[o] = w.n[s];
            if (w.ev[s]) size[o] = c * 2 ** w.m[s];
            texture[o] = w.tau[s];
            if (ref >= 0 && s !== ref && (pm >> s) & 1) cover[o] = w.cover[ref * S + s];
        }
        // pairs
        for (let a = 0; a < S; a++) {
            if (!((pm >> a) & 1)) continue;
            for (let b = a + 1; b < S; b++) {
                if (!((pm >> b) & 1)) continue;
                const ia = local[a][g], ib = local[b][g];
                const area = (popcount(scans[a].maskLo[ia] | scans[b].maskLo[ib]) + popcount(scans[a].maskHi[ia] | scans[b].maskHi[ib])) * f * f / 2;
                pairShared[a * S + b]++;
                pairShared[b * S + a]++;
                pairArea[a * S + b] += area;
                if (w.n[a] >= k.minWinner && w.n[b] >= k.minWinner) biasList[a * S + b].push(biasLead(w, a, b, k, A_S));
                if (w.n[a] >= k.minLoser && w.n[b] >= k.minLoser) expList[a * S + b].push(w.lum[b] / w.n[b] - w.lum[a] / w.n[a]);
                if (w.pairEv[a * S + b] && w.lead[a * S + b] >= A_S) pairClear[a * S + b]++;
                if (w.pairEv[b * S + a] && w.lead[b * S + a] >= A_S) pairClear[b * S + a]++;
            }
        }
    }

    const pairs: PairInfo[] = [];
    for (let a = 0; a < S; a++) {
        for (let b = a + 1; b < S; b++) {
            const list = biasList[a * S + b];
            const raw = list.length >= k.biasCells ? medianSym(list) : NaN;
            const n = pairShared[a * S + b];
            pairs.push({
                a,
                b,
                sharedCells: n,
                sharedArea: pairArea[a * S + b],
                bias: Number.isFinite(raw) ? Math.max(-k.biasCap, Math.min(k.biasCap, raw)) : 0,
                biasRaw: raw,
                biasCells: list.length,
                clearA: n ? pairClear[a * S + b] / n : 0,
                clearB: n ? pairClear[b * S + a] / n : 0,
                exposure: expList[a * S + b].length ? medianSym(expList[a * S + b]) : 0
            });
        }
    }

    // the scanned volume for the views: the robust box of the present cells
    // (1st-99th percentile), and the scene size from it when not given
    const sceneBox = presentBox(keys, present, c);
    let sceneSize = options.sceneSize;
    if (!(sceneSize > 0)) sceneSize = Math.hypot(sceneBox.max[0] - sceneBox.min[0], sceneBox.max[1] - sceneBox.min[1], sceneBox.max[2] - sceneBox.min[2]);

    // 4. regions: seeds (strong cells of the owner), growth through the
    // owner's cells, one closing pass
    const regionOf = new Int32Array(G).fill(-1);
    const raw: { W: number, cells: number[] }[] = [];
    const nb = new Int32Array(27);
    for (let h = 0; h < H; h++) {
        const g = shared[h];
        if (owner[h] < 0 || !strong[h] || regionOf[g] >= 0) continue;
        const W = owner[h];
        const r = raw.length;
        regionOf[g] = r;
        const queue = [g];
        for (let qi = 0; qi < queue.length; qi++) {
            neighbours27(keys, queue[qi], nb);
            for (let j = 0; j < 27; j++) {
                const q = nb[j];
                if (q < 0 || regionOf[q] >= 0) continue;
                const hq = sharedIndex[q];
                if (hq < 0 || owner[hq] !== W) continue;
                regionOf[q] = r;
                queue.push(q);
            }
        }
        raw.push({ W, cells: queue });
    }
    // W wins the cell alone against every other scan present there: its own
    // median at least closeOwnLead * the strong lead smaller, closeOwnDensity
    // times as many opaque splats (minWinner / minLoser at least), cover and
    // onsurf of the cell's own masks at the strong gates, no colour veto
    const ownWin = (g: number, W: number) => {
        const iW = local[W][g];
        if (iW < 0) return false;
        const nW = scans[W].n[iW];
        if (nW < k.minWinner) return false;
        const tW = Math.sqrt(field.ss[W][iW] / nW);
        let any = false;
        for (let s = 0; s < S; s++) {
            if (s === W || !((present[g] >> s) & 1)) continue;
            const i = local[s][g];
            const nL = scans[s].n[i];
            if (nL < k.minLoser || nW < k.closeOwnDensity * nL) return false;
            if (!(field.med[s][i] - field.med[W][iW] >= k.closeOwnLead * A_S)) return false;
            const oL = own[g * S + s], oW = own[g * S + W];
            if (!oL || !oW || inter[g * S * S + s * S + W] < k.coverStrong * oL || inter[g * S * S + W * S + s] < k.onsurfStrong * oW) return false;
            const tL = Math.sqrt(field.ss[s][i] / nL);
            if (tL >= k.textureMin && tW < k.textureRatio * tL) return false;
            any = true;
        }
        return any;
    };
    {
        const mark = new Uint8Array(G);
        const candidates: number[] = [];
        raw.forEach((region) => {
            region.cells.forEach((g) => {
                neighbours27(keys, g, nb);
                for (let j = 0; j < 27; j++) {
                    const q = nb[j];
                    if (q >= 0 && !mark[q] && regionOf[q] < 0 && (sharedIndex[q] >= 0 || k.closeThin)) {
                        mark[q] = 1;
                        candidates.push(q);
                    }
                }
            });
        });
        candidates.sort((a, b) => a - b);
        const additions: number[][] = [];
        const hits = new Int32Array(27);
        const hitCount = new Int32Array(27);
        for (const x of candidates) {
            neighbours27(keys, x, nb);
            let surface = 0, distinct = 0;
            for (let j = 0; j < 27; j++) {
                const q = nb[j];
                if (j === 13 || q < 0 || !present[q]) continue;
                surface++;
                const r = regionOf[q];
                if (r < 0) continue;
                let d = 0;
                while (d < distinct && hits[d] !== r) d++;
                if (d === distinct) {
                    hits[distinct] = r;
                    hitCount[distinct++] = 0;
                }
                hitCount[d]++;
            }
            let best = -1, bestCount = 0;
            for (let d = 0; d < distinct; d++) {
                if (hitCount[d] > bestCount || (hitCount[d] === bestCount && hits[d] < best)) {
                    best = hits[d];
                    bestCount = hitCount[d];
                }
            }
            if (best < 0 || bestCount < k.closeMin) continue;
            const W = raw[best].W;
            const hx = sharedIndex[x];
            // fewer region neighbours than closeShare: only a tie whose cell
            // alone W wins clearly (closeOwn, see DETAIL)
            if (bestCount < k.closeShare * surface && !(k.closeOwn && hx >= 0 && state[hx] === CellState.tie && ownWin(x, W))) continue;
            if (!((present[x] >> W) & 1) || (hx >= 0 && (beaten[hx] >> W) & 1)) continue;
            // never a cell with a verdict of its own: one another scan owns,
            // or one rejected for a reason (partial, sparse, texture - their
            // clusters are listed as 'Nicht vorgeschlagen' - apart,
            // uncovered); closing only fills ties and cells without evidence
            if (hx >= 0 && ((owner[hx] >= 0 && owner[hx] !== W) || CLOSING_BLOCKED[state[hx]])) continue;
            if (k.closeThin) {
                // another scan must have rows here (else there is nothing to hide)
                let other = false;
                for (let s = 0; s < S; s++) {
                    const i = local[s][x];
                    if (s !== W && i >= 0 && scans[s].nAll[i]) other = true;
                }
                if (!other) continue;
            } else if (hx < 0 || count[hx * S + W] < k.minWinner) {
                continue;
            }
            additions.push([x, best]);
        }
        additions.forEach(([x, r]) => {
            regionOf[x] = r;
            raw[r].cells.push(x);
        });
    }

    const ctx: RegionContext = {
        field, k, sharedIndex, owner, strong, size, cover, pairShared, mark: new Uint8Array(G), upAxis, upSign, sceneSize, box: sceneBox
    };
    let regions: Region[] = [];
    const rejected: Rejected[] = [];
    // raw regions loserCheck leaves without a loser (listed after the state
    // clusters, step 5b)
    const unlosered: Region[] = [];
    let loserRebuilt = 0, loserless = 0, loserlessStrong = 0;
    raw.forEach((region) => {
        const W = region.W;
        const cells = new Int32Array(region.cells.sort((a, b) => a - b));
        const losers: number[] = [];
        // the scan W beats strongly in the most cells (ties: the lower index)
        let top = -1, topStrong = 0;
        for (let L = 0; L < S; L++) {
            if (L === W) continue;
            let inCells = 0, beat = 0, beatStrong = 0;
            cells.forEach((g) => {
                if (!((present[g] >> L) & 1)) return;
                inCells++;
                const h = sharedIndex[g];
                if (owner[h] !== W) return;
                if (((strong[h] | weak[h]) >> L) & 1) beat++;
                if ((strong[h] >> L) & 1) beatStrong++;
            });
            if (inCells && beat >= k.loserShare * inCells && beatStrong >= k.loserStrong) losers.push(L);
            if (beatStrong > topStrong) {
                top = L;
                topStrong = beatStrong;
            }
        }
        if (!losers.length) {
            // too few strong cells for any loser (fewer than loserStrong, so
            // below the minStrong filter too): listed as 'small' like the
            // regions the filters reject, named after the scan W beats
            // strongly most often - the design lists every region the
            // filters reject. Before, they were dropped silently and their
            // strong cells read "W deutlich feiner" with no card and no
            // reason: museum 1<->3 159 raw regions (581 cells, 192 strong),
            // museum 1<->2 251 (1075, 323), Steinbeis 249 (1024, 311), each
            // with 1-2 strong cells, 2 cells in the median
            // Below rejectMin cells they are not listed (counted only): with
            // them the list grew by 190 entries of 1-3 cells on Steinbeis
            // and museum 1<->2 and pushed the real clusters out of the 8
            // rows shown. Listed ones are marked few (text "zu wenige
            // deutlich feinere Zellen", sorted after the other entries).
            if (top >= 0) {
                loserless++;
                if (cells.length < k.rejectMin) {
                    cells.forEach((g) => {
                        const h = sharedIndex[g];
                        if (owner[h] >= 0 && strong[h]) loserlessStrong++;
                    });
                    return;
                }
                const built = buildRegion(ctx, W, [top], cells);
                rejected.push({ reason: 'small', winner: W, loser: top, cells, ...boxOf(keys, cells, c), value: built.perLoser[0].rows, few: true });
            }
            return;
        }
        let built = buildRegion(ctx, W, losers, cells);
        // a loser is coarser over its hide cells as a whole too (loserCheck,
        // see DETAIL): W's count median at least the weak lead finer, at least
        // densityWeak as dense
        if (k.loserCheck) {
            const coarser = losers.filter((L, i) => {
                const pl = built.perLoser[i];
                return Math.log2(pl.sizeL / pl.sizeW) >= A_W && pl.density >= k.densityWeak;
            });
            if (!coarser.length) {
                unlosered.push(built);
                return;
            }
            if (coarser.length < losers.length) {
                built = buildRegion(ctx, W, coarser, cells);
                loserRebuilt++;
            }
        }
        const rows = built.perLoser.reduce((sum, p) => sum + p.rows, 0);
        if (cells.length >= k.minCells && built.strongCells >= k.minStrong && rows >= k.minRows) {
            regions.push(built);
        } else {
            // named after the region's (rebuilt) losers, never one loserCheck
            // removed
            const box = boxOf(keys, cells, c);
            rejected.push({ reason: 'small', winner: W, loser: built.losers[0], cells, ...box, value: rows });
        }
    });

    // 5. rejected clusters: connected cells of one (winner, loser, reason)
    {
        const groupsOf = new Map<number, number[]>();
        for (let h = 0; h < H; h++) {
            const st = state[h];
            if (st !== CellState.partial && st !== CellState.sparse && st !== CellState.texture) continue;
            const id = (st * 16 + rival[h]) * 16 + rivalLoser[h];
            let list = groupsOf.get(id);
            if (!list) {
                list = [];
                groupsOf.set(id, list);
            }
            list.push(shared[h]);
        }
        const mark = new Uint8Array(G);
        [...groupsOf.keys()].sort((a, b) => a - b).forEach((id) => {
            const st = Math.floor(id / 256);
            const Wr = Math.floor(id / 16) % 16;
            const Lr = id % 16;
            connected(keys, groupsOf.get(id), mark).forEach((group) => {
                if (group.length < k.rejectMin) return;
                const box = boxOf(keys, group, c);
                if (st === CellState.partial) {
                    // the gate that failed: cover (W covers too little of L)
                    // or onsurf (too little of W lies on L) - the one that
                    // failed in more of the cluster's cells, on equal counts
                    // the one with the smaller median share; the value is
                    // that gate's median share over the cells where it
                    // failed, so always below its weak threshold (a share
                    // that could not be measured counts as 0, as in the
                    // gate). Medians over all cells had named onsurf with
                    // values of 0.44-0.51 (Steinbeis 5 of 13 onsurf
                    // clusters, museum 1<->2 1 of 6) where most cells
                    // failed on cover
                    const covers: number[] = [], onsurfs: number[] = [];
                    group.forEach((g) => {
                        const h = sharedIndex[g];
                        if (gateOf[h] & 1) {
                            const cv = count[h * S + Wr] ? cover[h * S + Lr] : 0;
                            covers.push(Number.isNaN(cv) ? 0 : cv);
                        }
                        if (gateOf[h] & 2) onsurfs.push(Number.isNaN(onsurfOf[h]) ? 0 : onsurfOf[h]);
                    });
                    const mc = covers.length ? medianOf(covers) : NaN, mo = onsurfs.length ? medianOf(onsurfs) : NaN;
                    const gate = onsurfs.length > covers.length || (onsurfs.length === covers.length && mo < mc) ? 'onsurf' : 'cover';
                    rejected.push({ reason: 'partial', winner: Wr, loser: Lr, cells: new Int32Array(group), ...box, value: gate === 'onsurf' ? mo : mc, gate });
                    return;
                }
                const values = group.map((g) => {
                    const h = sharedIndex[g];
                    if (st === CellState.sparse) return count[h * S + Lr] ? count[h * S + Wr] / count[h * S + Lr] : Infinity;
                    return texture[h * S + Lr] > 0 ? texture[h * S + Wr] / texture[h * S + Lr] : NaN;
                }).filter(v => !Number.isNaN(v));
                rejected.push({
                    reason: st === CellState.sparse ? 'sparse' : 'texture',
                    winner: Wr,
                    loser: Lr,
                    cells: new Int32Array(group),
                    ...box,
                    value: values.length ? medianOf(values) : NaN
                });
            });
        });
    }

    // 5b. a raw region without a coarser loser (loserCheck) leaves a trace:
    // the cells W owned there (the ones that read "W finer") are listed as
    // one cluster, named after the loser with the most hide cells (ties: the
    // lower scan index) - 'sparse' when that loser failed the density test
    // (value: the density that failed, W / L opaque splats over its hide
    // cells; cells CellState.sparse with W / L as the rival pair, so
    // "Trotzdem übernehmen" works on them), else 'equal' (value: the
    // count-median lead over its hide cells, octaves; cells CellState.tie).
    // They are no longer W's: owner -1, no wins, cover NaN for a tie - the
    // map, the probe, the per-scan shares and the list then agree. Before,
    // they kept their strong / weak state and showed "W ist hier f× feiner"
    // with no card and no reason. Measured: museum 1<->3 18 'equal' clusters
    // (602 cells, lead p50 0.11 octave), Steinbeis 2 'equal' (151 cells) and
    // 1 'sparse', museum 1<->2 2 'equal' (22 cells), the bus pieces 2 in 18
    // cases. The sparse value is the test's own number: the median of the
    // cells' pooled densities said the opposite on Steinbeis (5 cells: 1.27,
    // W denser in the 3x3x3 pools, against 0.595 = 25 / 42 opaque splats in
    // the hide cells themselves)
    unlosered.forEach((built) => {
        const W = built.winner;
        let li = 0;
        built.hideCells.forEach((hc, i) => {
            if (hc.length > built.hideCells[li].length) li = i;
        });
        const L = built.losers[li];
        const pl = built.perLoser[li];
        const sparse = pl.density < k.densityWeak;
        const mine: number[] = [];
        built.cells.forEach((g) => {
            const h = sharedIndex[g];
            if (h >= 0 && owner[h] === W) mine.push(g);
        });
        mine.forEach((g) => {
            const h = sharedIndex[g];
            owner[h] = -1;
            strong[h] = 0;
            weak[h] = 0;
            beaten[h] = 0;
            state[h] = sparse ? CellState.sparse : CellState.tie;
            rival[h] = sparse ? W : -1;
            rivalLoser[h] = sparse ? L : -1;
            if (!sparse) for (let s = 0; s < S; s++) cover[h * S + s] = NaN;
        });
        const box = boxOf(keys, mine, c);
        rejected.push({
            reason: sparse ? 'sparse' : 'equal',
            winner: W,
            loser: L,
            cells: new Int32Array(mine),
            ...box,
            value: sparse ? pl.density : Math.log2(pl.sizeL / pl.sizeW)
        });
    });

    // per scan summaries (after 5b: a dropped region's cells are no longer
    // W's)
    const scanInfo: ScanInfo[] = scans.map((sc, s) => {
        let presentCells = 0, alone = 0, area = 0, sharedCells = 0, finest = 0, tie = 0, coarser = 0;
        for (let g = 0; g < G; g++) {
            const pm = present[g];
            if (!((pm >> s) & 1)) continue;
            presentCells++;
            area += own[g * S + s] * f * f / 2;
            const h = sharedIndex[g];
            if (h < 0) {
                alone++;
                continue;
            }
            sharedCells++;
            if (owner[h] === s) finest++;
            else if (((strong[h] | weak[h]) >> s) & 1) coarser++;
            else if (state[h] === CellState.tie) tie++;
        }
        return {
            s50: sc.s50,
            area,
            finest: sharedCells ? finest / sharedCells : 0,
            tie: sharedCells ? tie / sharedCells : 0,
            coarser: sharedCells ? coarser / sharedCells : 0,
            alone: presentCells ? alone / presentCells : 0,
            presentCells,
            sharedCells
        };
    });

    // 6. ids: base regions first, then by benefit; ties by the smallest key
    regions = regions.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'base' ? -1 : 1) || b.benefit - a.benefit || a.cells[0] - b.cells[0]);
    regionOf.fill(-1);
    regions.forEach((r, i) => {
        r.id = i;
        r.cells.forEach((g) => {
            regionOf[g] = i;
        });
    });
    rejected.sort((a, b) => Number(!!a.few) - Number(!!b.few) || b.cells.length - a.cells.length || a.cells[0] - b.cells[0]);

    return {
        cell: c,
        scanCount: S,
        lead: A_S,
        upAxis,
        upSign,
        sceneSize,
        keys,
        remap,
        present,
        sharedIndex,
        shared,
        owner,
        strong,
        weak,
        beaten,
        state,
        pooled,
        rival,
        rivalLoser,
        size,
        count,
        texture,
        cover,
        regionOf,
        pairs,
        scans: scanInfo,
        regions,
        rejected,
        diag: { unconfirmed, loserDropped: unlosered.length, loserRebuilt, loserless, loserlessStrong },
        seconds: (now() - t0) / 1000
    };
};

// the general difference b^ of the pair (W, L) in W's favour (octaves)
const biasOf = (detail: DetailResult, W: number, L: number) => {
    const p = detail.pairs.find(q => (q.a === W && q.b === L) || (q.a === L && q.b === W));
    if (!p) return 0;
    return p.a === W ? p.bias : -p.bias;
};

// "Trotzdem übernehmen": a rejected texture / sparse cluster as a region of
// its own (the caller appends it to detail.regions and paints it)
const forceRegion = (scans: ScanCellsLike[], detail: DetailResult, rejected: Rejected, options: DetailOptions = {}): Region => {
    const k = settings(options);
    const field = makeField(scans, detail.keys, detail.remap, k);
    const S = detail.scanCount;
    const pairShared = new Uint32Array(S * S);
    detail.pairs.forEach((p) => {
        pairShared[p.a * S + p.b] = pairShared[p.b * S + p.a] = p.sharedCells;
    });
    const ctx: RegionContext = {
        field,
        k,
        sharedIndex: detail.sharedIndex,
        owner: detail.owner,
        strong: detail.strong,
        size: detail.size,
        cover: detail.cover,
        pairShared,
        mark: new Uint8Array(detail.keys.length),
        upAxis: detail.upAxis,
        upSign: detail.upSign,
        sceneSize: detail.sceneSize,
        box: presentBox(detail.keys, detail.present, detail.cell)
    };
    // never over an existing region (its rows are another card's)
    const taken = new Uint8Array(detail.keys.length);
    detail.regions.forEach(r => r.cells.forEach((g) => {
        taken[g] = 1;
    }));
    const free = rejected.cells.filter(g => detail.regionOf[g] < 0 && !taken[g]).sort();
    if (!free.length) throw new Error('forceRegion: the cluster lies inside existing suggestions');
    const region = buildRegion(ctx, rejected.winner, [rejected.loser], free);
    region.id = detail.regions.reduce((m, r) => Math.max(m, r.id), -1) + 1;
    region.scope = 'local';
    region.forced = true;
    return region;
};

// ---------------------------------------------------------------- probe

// the numbers of the cell at a world point, computed exactly as in
// composeDetail ("An dieser Stelle"); build once per analysis
const makeProbe = (scans: ScanCellsLike[], detail: DetailResult, options: DetailOptions = {}) => {
    const k = settings(options);
    const field = makeField(scans, detail.keys, detail.remap, k);
    const S = detail.scanCount;
    const { keys, present } = field;
    const c = detail.cell;
    const A_S = Math.log2(k.lead);
    const A_W = A_S * k.weakLead;
    const w = new Work(S);
    const nb = new Int32Array(27);
    const nb2 = new Int32Array(27);
    const own = new Uint8Array(S);
    const inter = new Uint8Array(S * S);
    const poolCells = new Int32Array(27);
    const reasons: Record<number, 'partial' | 'sparse' | 'texture'> = { [CellState.partial]: 'partial', [CellState.sparse]: 'sparse', [CellState.texture]: 'texture' };

    return (point: V3): CellProbe => {
        const g = findKey(keys, cellKey(point[0], point[1], point[2], c));
        const centre = cellCentre(cellKey(point[0], point[1], point[2], c), c);
        if (g < 0) return { cell: -1, centre, pooled: false, measured: 0, state: CellState.none, owner: -1, region: -1, scans: [], pairs: [] };
        const pm = present[g];
        neighbours27(keys, g, nb);
        const pool = poolSet(field, g, nb, pm, k, poolCells);
        w.reset();
        for (let j = 0; j < pool.count; j++) {
            const q = poolCells[j];
            neighbours27(keys, q, nb2);
            own.fill(0);
            inter.fill(0);
            popcountsAt(field, q, nb2, own, 0, inter, 0);
            addCell(field, w, j, q, own, 0, inter, 0);
        }
        poolLeads(field, w, g, poolCells, pool.count, pm, k);
        evaluate(w, pm, k, A_S, A_W);
        const h = detail.sharedIndex[g];
        const probeScans: ProbeScan[] = [];
        for (let s = 0; s < S; s++) {
            const i = field.local[s][g];
            probeScans.push({
                scan: s,
                present: !!((pm >> s) & 1),
                count: w.n[s],
                size: w.ev[s] ? c * 2 ** w.m[s] : NaN,
                texture: w.tau[s],
                area: i >= 0 ? (popcount(scans[s].maskLo[i]) + popcount(scans[s].maskHi[i])) * c * c / 32 : 0
            });
        }
        const probePairs: ProbePair[] = [];
        for (let a = 0; a < S; a++) {
            for (let b = 0; b < S; b++) {
                if (a === b || !((pm >> a) & 1) || !((pm >> b) & 1)) continue;
                const o = a * S + b;
                // the pair's own verdict at this cell. A cell of a region the
                // loser check dropped for its density (composeDetail 5b:
                // state sparse, rival pair W / L) keeps it too - its pooled
                // numbers often pass (Steinbeis: densities 0.86-1.40 in the
                // cluster's cells), the region failed as a whole; the
                // listed 'sparse' cluster holds that verdict and its density
                const reason = reasons[w.reason[o]] ?? null;
                const pair: ProbePair = {
                    winner: a,
                    loser: b,
                    evidence: !!w.pairEv[o],
                    lead: w.lead[o],
                    density: w.density[o],
                    cover: w.cover[o],
                    onsurf: w.onsurf[o],
                    texture: w.texRatio[o],
                    strong: w.pass[o] === 2,
                    weak: w.pass[o] === 1,
                    reason
                };
                if (reason === 'partial') {
                    // both failed: the smaller share (an unmeasured one is 0)
                    const bits = w.gate[o];
                    const cv = Number.isNaN(w.cover[o]) ? 0 : w.cover[o], os = Number.isNaN(w.onsurf[o]) ? 0 : w.onsurf[o];
                    pair.gate = bits === 2 || (bits === 3 && os < cv) ? 'onsurf' : 'cover';
                }
                probePairs.push(pair);
            }
        }
        return {
            cell: g,
            centre,
            pooled: pool.mode > 0,
            measured: pool.count,
            state: h >= 0 ? detail.state[h] : bitCount8(pm) === 1 ? CellState.single : CellState.none,
            owner: h >= 0 ? detail.owner[h] : -1,
            region: detail.regionOf[g],
            scans: probeScans,
            pairs: probePairs
        };
    };
};

// ---------------------------------------------------------------- paint

type PaintInputOptions = DetailOptions & {
    // regions to paint (default: all of detail.regions)
    regions?: Region[],
    // paint arrays of an earlier run: rows already taken stay out
    existing?: Uint16Array[]
};

// the rows of every scan by global cell (counting sort)
const rowsByCell = (detail: DetailResult, s: number, rowCell: Int32Array) => {
    const G = detail.keys.length;
    const remap = detail.remap[s];
    const start = new Uint32Array(G + 1);
    for (let r = 0; r < rowCell.length; r++) {
        const lc = rowCell[r];
        if (lc >= 0) start[remap[lc] + 1]++;
    }
    for (let g = 0; g < G; g++) start[g + 1] += start[g];
    const fill = start.slice(0, G);
    const order = new Uint32Array(start[G]);
    for (let r = 0; r < rowCell.length; r++) {
        const lc = rowCell[r];
        if (lc >= 0) order[fill[remap[lc]]++] = r;
    }
    return { start, order };
};

// winner points on a grid of sorted cell keys (CSR), for radius queries up to
// the grid size
class PointGrid {
    size: number;
    keys: Float64Array;
    start: Uint32Array;
    // coordinates in cell order
    xyz: Float64Array;
    // original index per slot
    src: Uint32Array;
    // footprint per slot (when given)
    sizes: Float32Array;
    // gathered offsets (q - p), footprints and original indices of the last
    // query
    buf = new Float64Array(3 * 256);
    bufS = new Float64Array(256);
    bufI = new Int32Array(256);

    constructor(points: Float32Array, size: number, footprints: Float32Array = null) {
        const n = points.length / 3;
        this.size = size;
        const key = new Float64Array(n);
        for (let i = 0; i < n; i++) key[i] = cellKey(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], size);
        const sorted = key.slice().sort();
        let K = 0;
        for (let i = 0; i < n; i++) if (K === 0 || sorted[i] !== sorted[K - 1]) sorted[K++] = sorted[i];
        this.keys = sorted.slice(0, K);
        const cellOf = new Int32Array(n);
        let last = NaN, lastCell = -1;
        const start = new Uint32Array(K + 1);
        for (let i = 0; i < n; i++) {
            if (key[i] !== last) {
                last = key[i];
                lastCell = findKey(this.keys, last);
            }
            cellOf[i] = lastCell;
            start[lastCell + 1]++;
        }
        for (let j = 0; j < K; j++) start[j + 1] += start[j];
        const fill = start.slice(0, K);
        this.xyz = new Float64Array(n * 3);
        this.src = new Uint32Array(n);
        this.sizes = new Float32Array(footprints ? n : 0);
        for (let i = 0; i < n; i++) {
            const slot = fill[cellOf[i]]++;
            this.src[slot] = i;
            if (footprints) this.sizes[slot] = footprints[i];
            this.xyz[slot * 3] = points[i * 3];
            this.xyz[slot * 3 + 1] = points[i * 3 + 1];
            this.xyz[slot * 3 + 2] = points[i * 3 + 2];
        }
        this.start = start;
    }

    // slots of the cell with this key: [start, end), empty when none
    range(key: number, out: Int32Array) {
        const q = findKey(this.keys, key);
        out[0] = q >= 0 ? this.start[q] : 0;
        out[1] = q >= 0 ? this.start[q + 1] : 0;
        return out;
    }

    // offsets of the points within r (<= size) of (x, y, z) into buf, without
    // the point with original index skip; returns their number
    gather(x: number, y: number, z: number, r: number, skip: number) {
        const { keys, start, xyz, src } = this;
        const K = keys.length;
        const r2 = r * r;
        const ix = Math.floor(x / this.size), iy = Math.floor(y / this.size), iz = Math.floor(z / this.size);
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const base = keyOf(ix + dx, iy + dy, iz);
                let q = lowerBound(keys, base - 1);
                for (; q < K && keys[q] <= base + 1; q++) {
                    for (let p = start[q]; p < start[q + 1]; p++) {
                        const ex = xyz[p * 3] - x, ey = xyz[p * 3 + 1] - y, ez = xyz[p * 3 + 2] - z;
                        if (ex * ex + ey * ey + ez * ez > r2 || src[p] === skip) continue;
                        if (count * 3 + 3 > this.buf.length) {
                            const grown = new Float64Array(this.buf.length * 2);
                            grown.set(this.buf);
                            this.buf = grown;
                            const grownS = new Float64Array(this.bufS.length * 2);
                            grownS.set(this.bufS);
                            this.bufS = grownS;
                            const grownI = new Int32Array(this.bufI.length * 2);
                            grownI.set(this.bufI);
                            this.bufI = grownI;
                        }
                        this.buf[count * 3] = ex;
                        this.buf[count * 3 + 1] = ey;
                        this.buf[count * 3 + 2] = ez;
                        if (this.sizes.length) this.bufS[count] = this.sizes[p];
                        this.bufI[count] = src[p];
                        count++;
                    }
                }
            }
        }
        return count;
    }
}

// points thinned to one per voxel of edge v (the haze's surroundings): the
// mean position, the number of points and their mean footprint, in the
// voxels' key order; with weights (per point) the weighted means and sums
const voxelMeans = (points: Float32Array, sizes: Float32Array, v: number, weights: Float32Array = null) => {
    const g = new PointGrid(points, v, sizes);
    const K = g.keys.length;
    const xyz = new Float32Array(K * 3), size = new Float32Array(K), count = new Float32Array(K);
    for (let q = 0; q < K; q++) {
        let x = 0, y = 0, z = 0, s = 0, n = 0;
        for (let p = g.start[q]; p < g.start[q + 1]; p++) {
            const w = weights ? weights[g.src[p]] : 1;
            x += g.xyz[p * 3] * w;
            y += g.xyz[p * 3 + 1] * w;
            z += g.xyz[p * 3 + 2] * w;
            s += g.sizes[p] * w;
            n += w;
        }
        xyz[q * 3] = x / n;
        xyz[q * 3 + 1] = y / n;
        xyz[q * 3 + 2] = z / n;
        size[q] = s / n;
        count[q] = n;
    }
    return { xyz, size, count };
};
type VoxelMeans = ReturnType<typeof voxelMeans>;

// the haze zone of a region (DETAIL haze): the existing cells within reach
// cells (Chebyshev) of its cells, beyond its ring (2 or more cells off),
// that are in no region (ascending). A dilation over every key, not only
// the existing cells, so a cell across an empty cell is reached as well:
// per column (x, y) the z intervals within reach, dilated along x and then
// y (a cube is the product of three segments), then the existing cells in
// those intervals by binary search
const mergeIntervals = (v: number[]) => {
    if (v.length <= 2) return v;
    const order = Array.from({ length: v.length / 2 }, (_, i) => i).sort((a, b) => v[2 * a] - v[2 * b] || a - b);
    const out: number[] = [];
    for (const i of order) {
        const lo = v[2 * i], hi = v[2 * i + 1];
        if (out.length && lo <= out[out.length - 1] + 1) out[out.length - 1] = Math.max(out[out.length - 1], hi);
        else out.push(lo, hi);
    }
    return out;
};
const dilateColumns = (columns: Map<number, number[]>, step: number, reach: number) => {
    const out = new Map<number, number[]>();
    columns.forEach((list, base) => {
        for (let d = -reach; d <= reach; d++) {
            const b = base + d * step;
            const t = out.get(b);
            if (t) for (const v of list) t.push(v);
            else out.set(b, list.slice());
        }
    });
    out.forEach((list, b) => out.set(b, mergeIntervals(list)));
    return out;
};
const hazeZoneOf = (detail: DetailResult, region: Region, reach: number) => {
    const { keys, regionOf } = detail;
    const own = new Set<number>();
    let columns = new Map<number, number[]>();
    region.cells.forEach((g) => {
        const key = keys[g];
        own.add(key);
        const z = key % SPAN;
        const list = columns.get(key - z);
        if (list) list.push(z - reach, z + reach);
        else columns.set(key - z, [z - reach, z + reach]);
    });
    columns.forEach((list, b) => columns.set(b, mergeIntervals(list)));
    columns = dilateColumns(dilateColumns(columns, SPAN2, reach), SPAN, reach);
    const found: number[] = [];
    columns.forEach((list, base) => {
        for (let i = 0; i < list.length; i += 2) {
            const hi = base + list[i + 1];
            for (let g = lowerBound(keys, base + list[i]); g < keys.length && keys[g] <= hi; g++) {
                if (regionOf[g] >= 0) continue;
                // beyond the ring: no cell of the region among its 26
                // neighbours
                const key = keys[g];
                let ring = false;
                for (let dx = -1; dx <= 1 && !ring; dx++) {
                    for (let dy = -1; dy <= 1 && !ring; dy++) {
                        for (let dz = -1; dz <= 1 && !ring; dz++) ring = own.has(key + dx * SPAN2 + dy * SPAN + dz);
                    }
                }
                if (!ring) found.push(g);
            }
        }
    });
    found.sort((x, y) => x - y);
    return new Int32Array(found);
};

// the paint batches per loser scan: candidates (every loser row in the hide
// cells plus big loser splats in the ring; a row belongs to the region with
// the lower id) and the winner's opaque rows in the region cells and ring
const paintInputs = (detail: DetailResult, rows: CompactRows[], rowCells: Int32Array[], options: PaintInputOptions = {}): PaintJob[] => {
    const k = settings(options);
    const regions = (options.regions ?? detail.regions).slice().sort((a, b) => a.id - b.id);
    const S = rows.length;
    const c = detail.cell;
    const ob = opacityByte(k.opaque);
    const ringMin = k.ringSize * c;
    const need = new Uint8Array(S);
    regions.forEach((r) => {
        need[r.winner] = 1;
        r.losers.forEach((l) => {
            need[l] = 1;
        });
    });
    const csr = rows.map((_, s) => (need[s] ? rowsByCell(detail, s, rowCells[s]) : null));
    const taken = rows.map((r, s) => {
        if (!need[s]) return null;
        const t = new Uint8Array(r.footprint.length);
        const e = options.existing?.[s];
        if (e) for (let i = 0; i < t.length; i++) if (e[i]) t[i] = 1;
        return t;
    });
    const jobs = new Map<number, PaintBatch[]>();
    const holdMark = new Uint8Array(detail.keys.length);
    // the batches wait for the haze zone (pass 2), which may only take rows
    // no region took as a candidate of the cover proof (pass 1)
    const pending: { region: Region, li: number, picked: number[], cellOf: number[], ringFlag: number[], holdFlag: number[], holdCells: Int32Array, winnerPoints: Float32Array, winnerSize: Float32Array, hazeFrom: number, hazeW?: VoxelMeans, hazeL?: VoxelMeans }[] = [];
    for (const region of regions) {
        const W = region.winner;
        const { start, order } = csr[W];
        const rw = rows[W];
        // winner points: opaque rows in the cells and the ring
        const lists = [region.cells, region.ring];
        let nW = 0;
        lists.forEach(list => list.forEach((g) => {
            for (let p = start[g]; p < start[g + 1]; p++) if (rw.opacity[order[p]] >= ob) nW++;
        }));
        const winnerPoints = new Float32Array(nW * 3);
        const winnerSize = new Float32Array(nW);
        let o = 0;
        lists.forEach(list => list.forEach((g) => {
            for (let p = start[g]; p < start[g + 1]; p++) {
                const r = order[p];
                if (rw.opacity[r] < ob) continue;
                winnerSize[o / 3] = rw.footprint[r];
                winnerPoints[o++] = rw.positions[r * 3];
                winnerPoints[o++] = rw.positions[r * 3 + 1];
                winnerPoints[o++] = rw.positions[r * 3 + 2];
            }
        }));
        region.losers.forEach((L, li) => {
            const rl = rows[L];
            const cl = csr[L];
            const t = taken[L];
            const picked: number[] = [];
            const cellOf: number[] = [];
            const ringFlag: number[] = [];
            const holdFlag: number[] = [];
            const holdCells = region.holdCells?.[li] ?? new Int32Array(0);
            holdCells.forEach((g) => {
                holdMark[g] = 1;
            });
            region.hideCells[li].forEach((g) => {
                for (let p = cl.start[g]; p < cl.start[g + 1]; p++) {
                    const r = cl.order[p];
                    if (t[r]) continue;
                    t[r] = 1;
                    picked.push(r);
                    cellOf.push(g);
                    ringFlag.push(0);
                    holdFlag.push(holdMark[g]);
                }
            });
            region.ring.forEach((g) => {
                for (let p = cl.start[g]; p < cl.start[g + 1]; p++) {
                    const r = cl.order[p];
                    if (t[r] || !(rl.footprint[r] >= ringMin)) continue;
                    t[r] = 1;
                    picked.push(r);
                    cellOf.push(g);
                    ringFlag.push(1);
                    holdFlag.push(holdMark[g]);
                }
            });
            holdCells.forEach((g) => {
                holdMark[g] = 0;
            });
            pending.push({ region, li, picked, cellOf, ringFlag, holdFlag, holdCells, winnerPoints: li === 0 ? winnerPoints : winnerPoints.slice(), winnerSize: li === 0 ? winnerSize : winnerSize.slice(), hazeFrom: -1 });
        });
    }

    // pass 2, the blur haze (DETAIL haze): a loser clearly coarser over a
    // large region (its count medians over the hide cells hazeLead octaves
    // above the winner's, hazeCells cells; never a forced region) gets the
    // haze zone (Region.haze, cells 2 to hazeZone cells off the region that
    // are in no region). Its rows there of at least hazeRingSize * c and
    // 2^hazeOwn times the winner's median footprint become haze candidates,
    // not taken by another region and not in cells the loser owns. The
    // opaque rows of both scans in the zone (and the loser's in the ring that
    // are no candidates) go along as voxel means: the surroundings the haze
    // test looks at
    const vox = k.hazeVoxel * c;
    const zones = new Map<Region, Int32Array>();
    const context = (s: number, cells: Int32Array[], skip: Uint8Array) => {
        const r = rows[s], cl = csr[s];
        let n = 0;
        cells.forEach(list => list.forEach((g) => {
            for (let q = cl.start[g]; q < cl.start[g + 1]; q++) if (r.opacity[cl.order[q]] >= ob && !(skip && skip[cl.order[q]])) n++;
        }));
        const xyz = new Float32Array(n * 3), size = new Float32Array(n);
        let o = 0;
        cells.forEach(list => list.forEach((g) => {
            for (let q = cl.start[g]; q < cl.start[g + 1]; q++) {
                const i = cl.order[q];
                if (r.opacity[i] < ob || (skip && skip[i])) continue;
                xyz[o * 3] = r.positions[i * 3];
                xyz[o * 3 + 1] = r.positions[i * 3 + 1];
                xyz[o * 3 + 2] = r.positions[i * 3 + 2];
                size[o++] = r.footprint[i];
            }
        }));
        return voxelMeans(xyz, size, vox);
    };
    for (const p of pending) {
        const { region, li } = p;
        const pl = region.perLoser[li];
        if (!k.haze || region.forced || region.cells.length < k.hazeCells || !(Math.log2(pl.sizeL / pl.sizeW) >= k.hazeLead)) continue;
        const L = region.losers[li];
        let zone = zones.get(region);
        if (!zone) {
            zone = hazeZoneOf(detail, region, k.hazeZone);
            zones.set(region, zone);
            region.haze = zone;
        }
        p.hazeFrom = p.picked.length;
        const rl = rows[L], cl = csr[L], t = taken[L];
        const hazeMin = Math.max(k.hazeRingSize * c, 2 ** k.hazeOwn * detail.scans[region.winner].s50);
        zone.forEach((g) => {
            const h = detail.sharedIndex[g];
            if (h >= 0 && detail.owner[h] === L) return;
            for (let q = cl.start[g]; q < cl.start[g + 1]; q++) {
                const r = cl.order[q];
                if (t[r] || !(rl.footprint[r] >= hazeMin)) continue;
                t[r] = 1;
                p.picked.push(r);
                p.cellOf.push(g);
                p.ringFlag.push(1);
                p.holdFlag.push(0);
            }
        });
        // the surroundings: the winner's opaque rows in the zone, the
        // loser's in the zone and the ring that are no candidates
        const mine = new Uint8Array(rl.footprint.length);
        p.picked.forEach((r) => {
            mine[r] = 1;
        });
        p.hazeW = context(region.winner, [zone], null);
        p.hazeL = context(L, [region.ring, zone], mine);
    }

    // the winners' occupancy for the bracket test, once per (loser, winner)
    const occOf = new Map<number, Float64Array>();
    const occSent = new Set<number>();
    const occupancy = (W: number) => {
        let o = occOf.get(W);
        if (!o) {
            const list: number[] = [];
            for (let g = 0; g < detail.keys.length; g++) if ((detail.present[g] >> W) & 1) list.push(detail.keys[g]);
            o = new Float64Array(list);
            occOf.set(W, o);
        }
        return o;
    };
    for (const { region, li, picked, cellOf, ringFlag, holdFlag, holdCells, winnerPoints, winnerSize, hazeFrom, hazeW, hazeL } of pending) {
        const W = region.winner;
        const L = region.losers[li];
        const rl = rows[L];
        const n = picked.length;
        const candidates = new Float32Array(n * 3);
        const candidateSize = new Float32Array(n);
        picked.forEach((r, i) => {
            candidates[i * 3] = rl.positions[r * 3];
            candidates[i * 3 + 1] = rl.positions[r * 3 + 1];
            candidates[i * 3 + 2] = rl.positions[r * 3 + 2];
            candidateSize[i] = rl.footprint[r];
        });
        const sendOcc = hazeFrom >= 0 && !occSent.has(L * 64 + W);
        if (sendOcc) occSent.add(L * 64 + W);
        let list = jobs.get(L);
        if (!list) {
            list = [];
            jobs.set(L, list);
        }
        list.push({
            id: region.id,
            winner: W,
            loser: L,
            winnerPoints,
            winnerSize,
            candidates,
            candidateSize,
            candidateCell: new Int32Array(cellOf),
            ring: new Uint8Array(ringFlag),
            ...(holdCells.length ? { hold: new Uint8Array(holdFlag) } : {}),
            ...(hazeFrom >= 0 ? { hazeFrom, hazeW: hazeW.xyz, hazeWSize: hazeW.size, hazeWCount: hazeW.count, hazeL: hazeL.xyz, hazeLSize: hazeL.size, hazeLCount: hazeL.count } : {}),
            ...(sendOcc ? { hazeOcc: occupancy(W).slice() } : {}),
            s50W: detail.scans[W].s50,
            rows: new Uint32Array(picked)
        });
    }
    return [...jobs.keys()].sort((a, b) => a - b).map(loser => ({ loser, cell: c, batches: jobs.get(loser) }));
};

// PCA of the gathered offsets: normal, mean, planarity
const pcaScratch = { nx: 0, ny: 0, nz: 1, mx: 0, my: 0, mz: 0, planar: false };
const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const pca = (buf: Float64Array, count: number, planarLimit: number) => {
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < count; i++) {
        mx += buf[i * 3];
        my += buf[i * 3 + 1];
        mz += buf[i * 3 + 2];
    }
    mx /= count;
    my /= count;
    mz /= count;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < count; i++) {
        const x = buf[i * 3] - mx, y = buf[i * 3 + 1] - my, z = buf[i * 3 + 2] - mz;
        xx += x * x; xy += x * y; xz += x * z;
        yy += y * y; yz += y * z; zz += z * z;
    }
    cov[0] = xx; cov[1] = xy; cov[2] = xz;
    cov[3] = xy; cov[4] = yy; cov[5] = yz;
    cov[6] = xz; cov[7] = yz; cov[8] = zz;
    const [nx, ny, nz] = smallestEigenvector(cov);
    const lambda = nx * (xx * nx + xy * ny + xz * nz) + ny * (xy * nx + yy * ny + yz * nz) + nz * (xz * nx + yz * ny + zz * nz);
    const trace = xx + yy + zz;
    pcaScratch.nx = nx;
    pcaScratch.ny = ny;
    pcaScratch.nz = nz;
    pcaScratch.mx = mx;
    pcaScratch.my = my;
    pcaScratch.mz = mz;
    pcaScratch.planar = trace > 0 && lambda <= planarLimit * trace;
    return pcaScratch;
};

// winner points in the cylinder (|normal| <= rn, tangential <= rho) or, off
// a plane, in the sphere max(rho, rn); stops at `enough`
const countNear = (buf: Float64Array, count: number, e: typeof pcaScratch, rho: number, rn: number, enough: number) => {
    let n = 0;
    if (e.planar) {
        const rho2 = rho * rho;
        for (let i = 0; i < count; i++) {
            const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
            const dn = x * e.nx + y * e.ny + z * e.nz;
            if (Math.abs(dn) > rn || x * x + y * y + z * z - dn * dn > rho2) continue;
            if (++n >= enough) return n;
        }
    } else {
        const r = Math.max(rho, rn);
        const r2 = r * r;
        for (let i = 0; i < count; i++) {
            const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
            if (x * x + y * y + z * z > r2) continue;
            if (++n >= enough) return n;
        }
    }
    return n;
};

// the winner's footprints over the candidate's: on the winner's local plane,
// the candidate's centre and ringNeed of 6 spots on the circle of radius
// ringRadius * rho must each lie within footprintScale * sigma of a winner
// splat whose height is within rn of the candidate. 2: covered, 1: only the
// centre (the candidate reaches past the winner's edge), 0: not the centre
const spotU = new Float64Array(7), spotV = new Float64Array(7);
const footprintCovered = (buf: Float64Array, bufS: Float64Array, count: number, e: typeof pcaScratch, rho: number, rn: number, spacing: number, k: DetailConstants) => {
    const { nx, ny, nz } = e;
    // tangent basis
    let ax = 1, ay = 0;
    if (Math.abs(nx) > 0.9) {
        ax = 0;
        ay = 1;
    }
    let ux = ay * nz, uy = -ax * nz, uz = ax * ny - ay * nx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const ring = k.ringRadius * rho;
    spotU[0] = 0;
    spotV[0] = 0;
    for (let s = 1; s < 7; s++) {
        spotU[s] = ring * Math.cos((s - 1) * Math.PI / 3);
        spotV[s] = ring * Math.sin((s - 1) * Math.PI / 3);
    }
    let covered = 0;
    let open = 0x7f;
    const kf = k.footprintScale;
    // the centre needs a winner splat near by its own spacing too: a big
    // splat at the edge of a gap does not stand for the surface inside it
    const centre = k.centreScale * spacing;
    for (let i = 0; i < count && open; i++) {
        const x = buf[i * 3], y = buf[i * 3 + 1], z = buf[i * 3 + 2];
        if (Math.abs(x * nx + y * ny + z * nz) > rn) continue;
        const tu = x * ux + y * uy + z * uz, tv = x * vx + y * vy + z * vz;
        const r = kf * bufS[i];
        const r2 = r * r;
        for (let s = 0; s < 7; s++) {
            if (!((open >> s) & 1)) continue;
            const du = tu - spotU[s], dv = tv - spotV[s];
            const rs = s === 0 ? Math.min(r, centre) : r;
            if (du * du + dv * dv <= rs * rs) {
                open &= ~(1 << s);
                covered++;
            }
        }
    }
    return open & 1 ? 0 : covered - 1 >= k.ringNeed ? 2 : 1;
};

const paintBatch = (cell: number, batch: PaintBatch, k: DetailConstants, occupied: Set<number> = null): PaintBatchResult => {
    const c = cell;
    const pts = batch.winnerPoints;
    const nW = pts.length / 3;
    // every row of the batch; the cover proof's candidates are the first nC
    // (the rest: the haze zone, DETAIL haze)
    const nAll = batch.candidateSize.length;
    const nC = Math.min(nAll, batch.hazeFrom ?? nAll);
    const state = new Uint8Array(nAll);
    const distance = new Float32Array(nAll).fill(NaN);
    const rhoMax = k.rhoMax * c;
    const empty = (sW: number): PaintBatchResult => {
        state.fill(PaintState.noSurface, 0, nC);
        const none = new Int32Array(0);
        return {
            id: batch.id,
            winner: batch.winner,
            loser: batch.loser,
            state,
            distance,
            hidden: 0,
            kept: nC,
            held: 0,
            haze: 0,
            hazeRing: 0,
            candidateCells: 0,
            runCells: none,
            runStart: new Uint32Array(0),
            apartCells: none,
            apartShare: 0,
            apartDist: new Float32Array(0),
            apartStart: new Uint32Array(1),
            nearCells: none,
            nearDist: new Float32Array(0),
            nearStart: new Uint32Array(1),
            uncoveredCells: none,
            sep25: NaN,
            sep50: NaN,
            sep75: NaN,
            rn: k.rnMin * c,
            rt: NaN,
            sW,
            mSelf: 0,
            covered: 0
        };
    };
    if (nW < k.pcaMin) return empty(NaN);
    const grid = new PointGrid(pts, k.paintGrid * c, batch.winnerSize ?? null);
    const sW = spacingOf(pts, k.paintGrid * c);
    const rt = Math.min(k.rt * sW, rhoMax);
    const cand = batch.candidates;

    // separation of the loser from the winner's surface: plane distance of
    // up to sepSamples evenly picked candidates (neighbourhood of the widest
    // normal tolerance)
    const planarSep: number[] = [];
    const anySep: number[] = [];
    const sepCount = Math.min(nC, k.sepSamples);
    for (let i = 0; i < sepCount; i++) {
        const j = Math.floor(i * nC / sepCount);
        const rho = Math.min(Math.max(batch.candidateSize[j], rt), rhoMax);
        const n = grid.gather(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], k.reach * Math.max(rho, k.rnMax * c), -1);
        if (n < k.pcaMin) continue;
        const e = pca(grid.buf, n, k.planar);
        const d = Math.abs(e.mx * e.nx + e.my * e.ny + e.mz * e.nz);
        anySep.push(d);
        if (e.planar) planarSep.push(d);
    }
    const sepList = (planarSep.length >= 20 ? planarSep : anySep).sort((a, b) => a - b);
    const sep25 = quantileSorted(sepList, 0.25), sep50 = quantileSorted(sepList, 0.5), sep75 = quantileSorted(sepList, 0.75);
    const rn = Number.isFinite(sep75) ? Math.min(k.rnMax * c, Math.max(k.rnMin * c, k.rnSep * sep75)) : k.rnMin * c;

    // the winner's own density: winner points in its own cylinder
    const selfCounts: number[] = [];
    const selfN = Math.min(nW, k.selfSamples);
    for (let i = 0; i < selfN; i++) {
        const j = Math.floor(i * nW / selfN);
        const n = grid.gather(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2], k.reach * Math.max(rt, rn), j);
        if (n < k.pcaMin) {
            selfCounts.push(n);
            continue;
        }
        const e = pca(grid.buf, n, k.planar);
        selfCounts.push(countNear(grid.buf, n, e, rt, rn, Infinity));
    }
    const mSelf = medianOf(selfCounts);

    // the reference per candidate: the batch's (r_t, m_self) or, with
    // localRef, the winner's own spacing and density around the candidate's
    // cell (a region can span dense and sparse parts of a scan: "half its
    // usual density" then means half of what it has there)
    const refOf = new Int32Array(nC);
    const refRt = [rt], refM = [mSelf], refS = [sW];
    if (k.localRef) {
        const keyC = new Float64Array(nC);
        for (let j = 0; j < nC; j++) keyC[j] = cellKey(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], c);
        const sorted = keyC.slice().sort();
        let U = 0;
        for (let j = 0; j < nC; j++) if (U === 0 || sorted[j] !== sorted[U - 1]) sorted[U++] = sorted[j];
        const ukeys = sorted.slice(0, U);
        const byCell = new PointGrid(pts, c);
        const range = new Int32Array(2);
        refRt.length = refM.length = refS.length = 0;
        for (let u = 0; u < U; u++) {
            // winner points of the cell, or of its 3x3x3 cells when few
            const slots: number[] = [];
            const [ix, iy, iz] = decode(ukeys[u]);
            byCell.range(ukeys[u], range);
            for (let p = range[0]; p < range[1]; p++) slots.push(p);
            if (slots.length < k.localMin) {
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (!dx && !dy && !dz) continue;
                            byCell.range(keyOf(ix + dx, iy + dy, iz + dz), range);
                            for (let p = range[0]; p < range[1]; p++) slots.push(p);
                        }
                    }
                }
            }
            if (!slots.length) {
                refRt.push(rt);
                refM.push(mSelf);
                refS.push(sW);
                continue;
            }
            slots.sort((a, b) => byCell.src[a] - byCell.src[b]);
            const picks = Math.min(slots.length, k.localSamples);
            const nn: number[] = [];
            const pick = (i: number) => slots[Math.floor(i * slots.length / picks)];
            for (let i = 0; i < picks; i++) {
                const p = pick(i);
                const n = grid.gather(byCell.xyz[p * 3], byCell.xyz[p * 3 + 1], byCell.xyz[p * 3 + 2], k.paintGrid * c, byCell.src[p]);
                let best = Infinity;
                for (let q = 0; q < n; q++) best = Math.min(best, Math.hypot(grid.buf[q * 3], grid.buf[q * 3 + 1], grid.buf[q * 3 + 2]));
                if (Number.isFinite(best)) nn.push(best);
            }
            const s = nn.length ? medianOf(nn) : k.paintGrid * c;
            const rtU = Math.min(k.rt * s, rhoMax);
            // own counts only for the count test (the footprint test uses the
            // spacing alone)
            const counts: number[] = [];
            for (let i = 0; i < picks && !(k.coverTest && batch.winnerSize); i++) {
                const p = pick(i);
                const n = grid.gather(byCell.xyz[p * 3], byCell.xyz[p * 3 + 1], byCell.xyz[p * 3 + 2], k.reach * Math.max(rtU, rn), byCell.src[p]);
                if (n < k.pcaMin) {
                    counts.push(n);
                    continue;
                }
                counts.push(countNear(grid.buf, n, pca(grid.buf, n, k.planar), rtU, rn, Infinity));
            }
            refRt.push(rtU);
            refM.push(counts.length ? medianOf(counts) : mSelf);
            refS.push(s);
        }
        for (let j = 0; j < nC; j++) refOf[j] = lowerBound(ukeys, keyC[j]);
    }

    // the test per candidate. The signed plane distance (for the apart test)
    // takes the normal oriented like the first one fitted in the candidate's
    // cell; one more than 60 degrees off it is not comparable (NaN)
    let hidden = 0;
    // per candidate the footprint test's code (footprintCovered; 0 when not
    // measured): the blur haze takes on-surface candidates whose centre the
    // winner covers
    const centre = new Uint8Array(nC);
    let wide: PointGrid = null;
    let measure: PointGrid = null;
    const signed = new Float32Array(nC).fill(NaN);
    // the far tier: for candidates without winner surface in reach, the
    // signed distance to the winner's plane within apartFar cells (its own
    // reference normal per cell)
    const signedFar = new Float32Array(nC).fill(NaN);
    const refs = [{ cell: -1, x: 0, y: 0, z: 0 }, { cell: -1, x: 0, y: 0, z: 0 }];
    const signInto = (out: Float32Array, ref: typeof refs[0], j: number, e: typeof pcaScratch) => {
        if (batch.ring[j]) return;
        if (batch.candidateCell[j] !== ref.cell) {
            ref.cell = batch.candidateCell[j];
            ref.x = e.nx;
            ref.y = e.ny;
            ref.z = e.nz;
        }
        const dot = e.nx * ref.x + e.ny * ref.y + e.nz * ref.z;
        if (Math.abs(dot) < 0.5) return;
        const s = -(e.mx * e.nx + e.my * e.ny + e.mz * e.nz);
        out[j] = dot < 0 ? -s : s;
    };
    const sign = (j: number, e: typeof pcaScratch) => signInto(signed, refs[0], j, e);
    // holdMatch / holdRelease: per candidate of a hold cell (and of a held
    // ring cell), log2 of its footprint over the mean footprint of the
    // winner splats in its reach (NaN: none measured)
    const matched = batch.hold && (k.holdMatch || Number.isFinite(k.holdRelease)) ? new Float32Array(nC).fill(NaN) : null;
    // holdReleaseLocal: per such candidate the loser's own splats in its
    // reach against the winner's (log2 of the two mean footprints; NaN:
    // fewer than 3 loser splats there)
    const local = matched && Number.isFinite(k.holdRelease) && k.holdReleaseLocal ? new Float32Array(nC).fill(NaN) : null;
    const loserGrid = local ? new PointGrid(cand.subarray(0, nC * 3), k.paintGrid * c, batch.candidateSize.subarray(0, nC)) : null;
    for (let j = 0; j < nC; j++) {
        const sigma = batch.candidateSize[j];
        const rtJ = refRt[refOf[j]];
        const rho = Math.min(Math.max(sigma, rtJ), rhoMax);
        const rnP = Math.min(Math.max(rn, k.blob * sigma), rhoMax);
        const reach = k.reach * Math.max(rho, rnP);
        let g = grid;
        let searched = reach;
        let n = g.gather(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], reach, -1);
        // a sparse winner part: look once more, farther (on a coarser grid)
        if (n < k.pcaMin && k.widen > 1) {
            if (!wide) wide = new PointGrid(pts, k.widenGrid * c, batch.winnerSize ?? null);
            g = wide;
            searched = Math.min(k.widenGrid * c, k.widen * reach);
            n = g.gather(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], searched, -1);
        }
        if (n < k.pcaMin) {
            // no winner surface in the paint's reach: infinitely far for the
            // paint; the far tier only feeds the apart test of its cell
            state[j] = PaintState.noSurface;
            distance[j] = Infinity;
            if (k.apartFar > 0) {
                if (!measure) measure = new PointGrid(pts, k.apartFar * c);
                const m = measure.gather(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], k.apartFar * c, -1);
                if (m >= k.pcaMin) signInto(signedFar, refs[1], j, pca(measure.buf, m, k.planar));
            }
            continue;
        }
        const e = pca(g.buf, n, k.planar);
        distance[j] = Math.abs(e.mx * e.nx + e.my * e.ny + e.mz * e.nz);
        sign(j, e);
        // holdMatch: the candidate against the winner splats in its reach
        if (matched && batch.hold[j] && batch.winnerSize) {
            let sum = 0;
            for (let q = 0; q < n; q++) sum += g.bufS[q];
            if (sum > 0) matched[j] = Math.log2(sigma * n / sum);
            if (local && sum > 0 && !batch.ring[j]) {
                const m = loserGrid.gather(cand[j * 3], cand[j * 3 + 1], cand[j * 3 + 2], reach, -1);
                let sumL = 0;
                for (let q = 0; q < m; q++) sumL += loserGrid.bufS[q];
                if (m >= 3 && sumL > 0) local[j] = Math.log2(sumL / m * n / sum);
            }
        }
        let ok: boolean;
        if (k.coverTest && batch.winnerSize) {
            const code = footprintCovered(g.buf, g.bufS, n, e, Math.min(sigma, rhoMax), rnP, refS[refOf[j]], k);
            centre[j] = code;
            ok = code === 2;
        } else {
            const need = Math.max(k.coverMin, Math.ceil(k.coverShare * refM[refOf[j]] * (rho / rtJ) ** 2));
            ok = countNear(g.buf, n, e, rho, rnP, need) >= need;
        }
        if (ok) {
            state[j] = PaintState.hidden;
            hidden++;
        } else {
            state[j] = PaintState.uncovered;
        }
    }

    // per hide cell (see DETAIL): uncovered when most of its candidates have
    // no winner surface (Infinity); else apart when the median of their
    // signed plane distances is above apartSep * c, near (for the patches of
    // applyPaint) above apartLow * c. Uncovered and apart keep every
    // candidate there; only apart means "lies off the winner's surface"
    const apart: number[] = [];
    const apartDist: number[] = [];
    const apartStart: number[] = [0];
    const near: number[] = [];
    const nearDist: number[] = [];
    const nearStart: number[] = [0];
    const uncovered: number[] = [];
    let runs = 0;
    const runCells: number[] = [];
    const runStart: number[] = [];
    const finite: number[] = [];
    const offsets: number[] = [];
    const farOffsets: number[] = [];
    for (let j = 0; j < nC;) {
        if (batch.ring[j]) {
            j++;
            continue;
        }
        const g = batch.candidateCell[j];
        let e = j, far = 0;
        finite.length = 0;
        offsets.length = 0;
        farOffsets.length = 0;
        while (e < nC && !batch.ring[e] && batch.candidateCell[e] === g) {
            const v = distance[e];
            if (v === Infinity) far++;
            else if (!Number.isNaN(v)) finite.push(v);
            if (!Number.isNaN(signed[e])) offsets.push(signed[e]);
            if (!Number.isNaN(signedFar[e])) farOffsets.push(signedFar[e]);
            e++;
        }
        runs++;
        runCells.push(g);
        runStart.push(j, e);
        const n = e - j;
        let kept = 0;
        const off = offsets.length >= k.apartMin ? Math.abs(medianOf(offsets)) : 0;
        // most without winner surface in reach: uncovered - unless the far
        // tier finds them at one offset from a winner plane (a coherent
        // parallel layer: the median beyond apartSep * c, the quartiles
        // within apartCoherence of it), then they lie apart
        let farApart = false;
        if (n >= k.apartMin && far > 0.5 * n && farOffsets.length >= k.apartMin) {
            const s = farOffsets.slice().sort((a, b) => a - b);
            const m = quantileSorted(s, 0.5);
            farApart = Math.abs(m) > k.apartSep * c && quantileSorted(s, 0.75) - quantileSorted(s, 0.25) <= k.apartCoherence * Math.abs(m);
        }
        if (farApart) {
            apart.push(g);
            for (const v of finite) apartDist.push(v);
            for (const v of farOffsets) apartDist.push(Math.abs(v));
            apartStart.push(apartDist.length);
            kept = PaintState.apart;
        } else if (n >= k.apartMin && far > 0.5 * n) {
            uncovered.push(g);
            kept = PaintState.uncovered;
        } else if (off > k.apartSep * c) {
            apart.push(g);
            for (const v of finite) apartDist.push(v);
            apartStart.push(apartDist.length);
            kept = PaintState.apart;
        } else if (k.apartLow > 0 && off > k.apartLow * c) {
            near.push(g);
            for (const v of finite) nearDist.push(v);
            nearStart.push(nearDist.length);
        }
        if (kept) {
            for (let i = j; i < e; i++) {
                if (state[i] === PaintState.hidden) hidden--;
                if (kept === PaintState.apart || state[i] === PaintState.hidden) state[i] = kept;
            }
        }
        j = e;
    }
    // the covered candidates of hold cells stay (after the cell states, so
    // apart and uncovered win; nothing above depends on it): held, neither
    // hidden nor kept (kept = not covered, apart, no surface). The covered
    // share stays the cover proof's own (held ones count as covered), so the
    // 'clear' rule does not move with holdOwn
    // With holdMatch a hide cell's candidates are held only when, matched in
    // space, the winner is not finer either: the median over the cell's
    // candidates of their footprint against the winner splats in their reach
    // stays below holdOwn * the strong lead (the cell's own count medians
    // compare whatever each scan has in the cell, which a shift of a few cm
    // across a cell face changes; ring candidates are picked for their size,
    // so the ring keeps the cell test)
    // With holdRelease a candidate is also let go on its own when, matched in
    // space, it is clearly coarser than the winner splats in its reach
    // (log2 of its footprint over their mean at least holdRelease * the
    // strong lead), in a hide cell or a held ring cell: where a coarse
    // stretch or a focus ball fills only part of a cell, the cell's median
    // holds its truly coarse rows with the normal ones
    let held = 0;
    if (batch.hold) {
        const holdLead = k.holdOwn * Math.log2(k.lead);
        const release = new Uint8Array(nC);
        if (matched && k.holdMatch) {
            const v: number[] = [];
            for (let i = 0; i < runCells.length; i++) {
                const from = runStart[2 * i], to = runStart[2 * i + 1];
                v.length = 0;
                for (let j = from; j < to; j++) if (!Number.isNaN(matched[j])) v.push(matched[j]);
                if (v.length && medianOf(v) >= holdLead) release.fill(1, from, to);
            }
        }
        if (matched && Number.isFinite(k.holdRelease)) {
            const coarser = k.holdRelease * Math.log2(k.lead), coarserRing = k.holdReleaseRing * Math.log2(k.lead);
            for (let j = 0; j < nC; j++) {
                const v = local && !Number.isNaN(local[j]) ? local[j] : matched[j];
                if (v >= (batch.ring[j] ? coarserRing : coarser)) release[j] = 1;
            }
        }
        for (let j = 0; j < nC; j++) {
            if (!batch.hold[j] || release[j] || state[j] !== PaintState.hidden) continue;
            state[j] = PaintState.held;
            hidden--;
            held++;
        }
    }

    // the blur haze (DETAIL haze), after everything above (nothing there
    // depends on it): coarse candidates the cover proof left uncovered or
    // without surface (not in an apart or near cell) and the rows of the
    // haze zone become haze where, within their own reach (hazeReach *
    // footprint, at most hazeFar cells), the winner has surface around them
    // that is clearly finer, and they are either a blurred copy of it (its
    // splats at their centre) or float off it in the open space between its
    // surfaces with the winner next to most of the loser's rows there (gross
    // blur, where the loser's splats there are 4x the winner's: without that)
    const proven = hidden;
    let haze = 0, hazeRing = 0;
    // the haze is coarse: at least hazeRingSize * c and 2^hazeOwn times the
    // winner's median footprint (the haze zone's rows are picked so)
    const hazeMin = Math.max(k.hazeRingSize * c, 2 ** k.hazeOwn * batch.s50W);
    const eligible = (j: number) => j >= nC || (batch.candidateSize[j] >= hazeMin && (state[j] === PaintState.uncovered || state[j] === PaintState.noSurface));
    let any = nAll > nC;
    for (let j = 0; j < nC && !any; j++) any = eligible(j);
    if (k.haze && batch.hazeFrom !== undefined && batch.winnerSize && any) {
        const off = new Set<number>(near);
        apart.forEach((g) => {
            off.add(g);
        });
        const v = k.hazeVoxel * c, mid = 2 * c, far = Math.max(mid, k.hazeFar * c);
        const join = (x: VoxelMeans, xyz: Float32Array, size: Float32Array, count: Float32Array): VoxelMeans => {
            if (!xyz?.length) return x;
            const out = { xyz: new Float32Array(x.xyz.length + xyz.length), size: new Float32Array(x.size.length + size.length), count: new Float32Array(x.count.length + count.length) };
            out.xyz.set(x.xyz);
            out.xyz.set(xyz, x.xyz.length);
            out.size.set(x.size);
            out.size.set(size, x.size.length);
            out.count.set(x.count);
            out.count.set(count, x.count.length);
            return out;
        };
        // the voxels of both scans with their surroundings, fine (edge v)
        // and for the far reach coarse (hazeVoxelFar * c, from the fine ones
        // by their counts); the grids of the three reach levels and the
        // coverage per loser voxel are built when first needed
        const wv = join(voxelMeans(pts, batch.winnerSize, v), batch.hazeW, batch.hazeWSize, batch.hazeWCount);
        const lv = join(voxelMeans(cand, batch.candidateSize, v), batch.hazeL, batch.hazeLSize, batch.hazeLCount);
        // per loser voxel, on demand: a winner voxel within hazeCoverDist *
        // c, at the coarse level within its voxel edge (-1: not measured)
        type Coverage = { l: VoxelMeans, r: number, grid: PointGrid, flag: Int8Array };
        const coverage = (l: VoxelMeans, w: VoxelMeans, r: number): Coverage => ({ l, r, grid: new PointGrid(w.xyz, r), flag: new Int8Array(l.count.length).fill(-1) });
        type Level = { size: number, w: PointGrid, l: PointGrid, wCount: Float32Array, lCount: Float32Array, covered: Coverage };
        const built: Level[] = [null, null, null];
        let fine: Coverage = null;
        const level = (i: number) => {
            if (built[i]) return built[i];
            let w = wv, l = lv, covered: Coverage;
            if (i < 2) {
                fine = fine ?? coverage(lv, wv, k.hazeCoverDist * c);
                covered = fine;
            } else {
                w = voxelMeans(wv.xyz, wv.size, k.hazeVoxelFar * c, wv.count);
                l = voxelMeans(lv.xyz, lv.size, k.hazeVoxelFar * c, lv.count);
                covered = coverage(l, w, Math.max(k.hazeCoverDist, k.hazeVoxelFar) * c);
            }
            const size = [Math.min(c / 2, mid), mid, far][i];
            built[i] = { size, w: new PointGrid(w.xyz, size, w.size), l: new PointGrid(l.xyz, size, l.size), wCount: w.count, lCount: l.count, covered };
            return built[i];
        };
        // the weighted mean footprint of the voxels gathered last (their
        // rows in sumN; with coverage, the covered loser voxels' in sumC)
        let sumN = 0, sumC = 0;
        const meanOf = (g: PointGrid, n: number, count: Float32Array, cov: Coverage = null) => {
            let total = 0, sum = 0, covered = 0;
            for (let q = 0; q < n; q++) {
                const i = g.bufI[q];
                total += count[i];
                sum += g.bufS[q] * count[i];
                if (!cov) continue;
                if (cov.flag[i] < 0) cov.flag[i] = cov.grid.gather(cov.l.xyz[i * 3], cov.l.xyz[i * 3 + 1], cov.l.xyz[i * 3 + 2], cov.r, -1) ? 1 : 0;
                if (cov.flag[i]) covered += count[i];
            }
            sumN = total;
            sumC = covered;
            return total > 0 ? sum / total : NaN;
        };
        // the winner has surface along the axis (dx, dy, dz) within hazeSee
        // cells of (x, y, z), from one cell on
        const hit = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
            for (let t = c; t <= k.hazeSee * c; t += c) {
                if (occupied.has(cellKey(x + dx * t, y + dy * t, z + dz * t, c))) return true;
            }
            return false;
        };
        const bracketed = (x: number, y: number, z: number) => {
            for (const [dx, dy, dz] of AXES) if (hit(x, y, z, dx, dy, dz) && hit(x, y, z, -dx, -dy, -dz)) return true;
            return false;
        };
        for (let j = 0; j < nAll; j++) {
            if (!eligible(j) || (j < nC && !batch.ring[j] && off.has(batch.candidateCell[j]))) continue;
            const s = batch.candidateSize[j];
            const reach = Math.min(k.hazeReach * s, far);
            const lv2 = level(reach <= Math.min(c / 2, mid) ? 0 : reach <= mid ? 1 : 2);
            const x = cand[j * 3], y = cand[j * 3 + 1], z = cand[j * 3 + 2];
            // 1. the winner has surface within the splat's reach, its splats
            // there hazeOwn octaves finer (count-weighted mean footprint)
            const gw = lv2.w;
            const n = gw.gather(x, y, z, reach, -1);
            if (n < k.pcaMin) continue;
            const mW = meanOf(gw, n, lv2.wCount);
            const own = Math.log2(s / mW);
            if (sumN < k.pcaMin || !(own >= k.hazeOwn)) continue;
            // 2. not beyond the winner's edge: its surface in the reach lies
            // around the splat, not off to one side along it (the mean offset
            // of its voxels along their plane, the smallest-variance normal,
            // below hazeEdge * the reach, for gross blur hazeGrossEdge; past
            // the end of a scan it is 0.4 and more)
            const e = pca(gw.buf, n, k.planar);
            const along = e.mx * e.nx + e.my * e.ny + e.mz * e.nz;
            const edge = Math.hypot(e.mx - along * e.nx, e.my - along * e.ny, e.mz - along * e.nz) / reach;
            const mayBeGross = own >= k.hazeGross;
            if (edge >= (mayBeGross ? Math.max(k.hazeEdge, k.hazeGrossEdge) : k.hazeEdge)) continue;
            // gross blur (see DETAIL): the loser's splats in the reach
            // hazeGross octaves above the winner's (mean footprints) and the
            // row too - not a coarser version of the winner's surface but a
            // blur of another order: rule 2 at hazeGrossEdge, rule 3 at the
            // winner's own scale, no rule 5
            const gl = lv2.l;
            let gross = false;
            if (mayBeGross) {
                const m = gl.gather(x, y, z, reach, -1);
                gross = Math.log2(meanOf(gl, m, lv2.lCount) / mW) >= k.hazeGross;
            }
            if (!gross && edge >= k.hazeEdge) continue;
            // 3. floating off the winner's surface (beyond the paint's normal
            // tolerance from the winner's plane, or where its splats form no
            // plane from its nearest voxel; gross blur already beyond
            // hazeGrossOff times the winner's mean footprint there - its
            // surface is that thin, the paint's tolerance grows with the
            // loser's splat), or in it a blurred copy where the winner covers
            // it (a cover-proof candidate that passed the footprint test but
            // whose cell was uncovered - most of the loser's splats there
            // float -, a zone row with a winner voxel within hazeCentre * c
            // of its centre); in the surface without the winner covering it,
            // it fills a hole (or reaches past the winner's edge, footprint
            // test 1) and stays
            let h = Math.abs(along);
            if (!e.planar) {
                h = Infinity;
                for (let q = 0; q < n; q++) h = Math.min(h, Math.hypot(gw.buf[q * 3], gw.buf[q * 3 + 1], gw.buf[q * 3 + 2]));
            }
            const tol = Math.min(Math.max(rn, k.blob * s), rhoMax);
            const floating = h > k.hazeOff * (gross ? Math.min(tol, k.hazeGrossOff * mW) : tol);
            if (!floating && !(j < nC ? centre[j] === 2 : level(0).w.gather(x, y, z, k.hazeCentre * c, -1) > 0)) continue;
            // 4. floating, it is in the open space the winner saw through:
            // along one of the 13 axes the winner has surface on both sides
            // within hazeSee cells (past the end of a scan there is none on
            // the far side)
            if (floating && occupied && !bracketed(x, y, z)) continue;
            // 5. (not for gross blur) the loser is coarser there as a whole
            // (its mean footprint in the same reach hazeLocal octaves above
            // the winner's) and the winner has surface next to hazeCover of
            // the loser's rows there: its surroundings are the winner's, not
            // content the winner lacks
            if (!gross) {
                const m = gl.gather(x, y, z, reach, -1);
                const mL = meanOf(gl, m, lv2.lCount, lv2.covered);
                if (!(Math.log2(mL / mW) >= k.hazeLocal) || !(sumC >= k.hazeCover * sumN)) continue;
            }
            if (j < nC) hidden++;
            else hazeRing++;
            state[j] = PaintState.haze;
            haze++;
        }
        hidden += hazeRing;
    }

    return {
        id: batch.id,
        winner: batch.winner,
        loser: batch.loser,
        state,
        distance,
        hidden,
        kept: nC - (hidden - hazeRing) - held,
        held,
        haze,
        hazeRing,
        candidateCells: runs,
        runCells: new Int32Array(runCells),
        runStart: new Uint32Array(runStart),
        apartCells: new Int32Array(apart),
        apartShare: runs ? apart.length / runs : 0,
        apartDist: new Float32Array(apartDist),
        apartStart: new Uint32Array(apartStart),
        nearCells: new Int32Array(near),
        nearDist: new Float32Array(nearDist),
        nearStart: new Uint32Array(nearStart),
        uncoveredCells: new Int32Array(uncovered),
        sep25,
        sep50,
        sep75,
        rn,
        rt: k.localRef ? medianOf(refRt) : rt,
        sW: k.localRef ? medianOf(refS) : sW,
        mSelf: k.localRef ? medianOf(refM) : mSelf,
        covered: nC ? (proven + held) / nC : 0
    };
};

// the cover proof for the batches of one loser scan
const composePaint = (cell: number, batches: PaintBatch[], options: DetailOptions = {}, onProgress?: (fraction: number) => void): PaintResult => {
    const t0 = now();
    const k = settings(options);
    const total = batches.reduce((sum, b) => sum + b.candidateSize.length + 1, 0);
    let done = 0;
    // the winners' occupancy (a set of cell keys per winner) for the haze
    const occ = new Map<number, Set<number>>();
    const results = batches.map((batch) => {
        if (batch.hazeOcc && !occ.has(batch.winner)) occ.set(batch.winner, new Set(batch.hazeOcc));
        const r = paintBatch(cell, batch, k, occ.get(batch.winner) ?? null);
        done += batch.candidateSize.length + 1;
        onProgress?.(done / total);
        return r;
    });
    return { batches: results, seconds: (now() - t0) / 1000 };
};

type ApplyOptions = DetailOptions & {
    // rows per scan
    rowCounts: number[],
    // paint arrays to update (force flow); a fresh paint renumbers the ids
    // when regions were dropped
    paint?: Uint16Array[]
};

// the paint results into per-row values; updates detail in place: regions
// get their paint numbers and confidence, regions with too many apart cells
// are dropped into the rejected list, apart cells get CellState.apart and
// uncovered cells CellState.uncovered. A cell is never both in a region and
// in a rejected cluster: the cells of an apart cluster listed inside a kept
// region leave that region, and every loser's candidates there stay (with
// several losers the others may be covered there; their numbers are counted
// again), so no row is hidden outside its region's cells and ring
const applyPaint = (detail: DetailResult, jobs: PaintJob[], results: PaintResult[], options: ApplyOptions): PaintApplied => {
    const t0 = now();
    const k = settings(options);
    const c = detail.cell;
    const G = detail.keys.length;
    const paint = options.paint ?? options.rowCounts.map(n => new Uint16Array(n));
    const fresh = !options.paint;
    // the batches per region (in loser order); batch.rows is all applyPaint
    // reads of a batch (its other arrays may have moved to the worker)
    const pairsOf = new Map<number, { batch: PaintBatch, result: PaintBatchResult }[]>();
    jobs.forEach((job, ji) => job.batches.forEach((batch, bi) => {
        let list = pairsOf.get(batch.id);
        if (!list) {
            list = [];
            pairsOf.set(batch.id, list);
        }
        list.push({ batch, result: results[ji].batches[bi] });
    }));

    // the cells found apart (by any loser's paint) and uncovered; one G-size
    // scratch for every connected() below (it clears its marks)
    const apartAll: number[] = [];
    const apartIndex = new Int32Array(G).fill(-1);
    const uncoveredAll: number[] = [];
    const uncoveredMark = new Uint8Array(G);
    const scratch = new Uint8Array(G);
    const dropped: number[] = [];
    const droppedRegions: Region[] = [];
    const keep: Region[] = [];
    const painted: Region[] = [];
    for (const region of detail.regions) {
        const list = pairsOf.get(region.id);
        if (!list) {
            keep.push(region);
            continue;
        }
        let apartCells = 0, hideCells = 0;
        // per batch (loser): its apart distances, its near cells and theirs
        const own = list.map((): number[] => []);
        const nearOf = list.map(() => new Map<number, number[]>());
        list.forEach(({ batch, result }, bi) => {
            result.nearCells.forEach((g, i) => {
                const d: number[] = [];
                for (let p = result.nearStart[i]; p < result.nearStart[i + 1]; p++) d.push(result.nearDist[p]);
                nearOf[bi].set(g, d);
            });
            apartCells += result.apartCells.length;
            hideCells += result.candidateCells;
            result.apartCells.forEach((g, i) => {
                if (apartIndex[g] < 0) {
                    apartIndex[g] = apartAll.length;
                    apartAll.push(g);
                }
                for (let p = result.apartStart[i]; p < result.apartStart[i + 1]; p++) own[bi].push(result.apartDist[p]);
            });
            result.uncoveredCells.forEach((g) => {
                if (!uncoveredMark[g]) {
                    uncoveredMark[g] = 1;
                    uncoveredAll.push(g);
                }
            });
        });
        // dropped when too much of it is apart, or when it holds one coherent
        // patch: connected apart and near cells, grown from apart ones
        // (hysteresis), of at least apartCluster cells; the patch's near
        // cells add their distances to its separation (their state stays:
        // apart is only above apartSep * c)
        const patches: number[][] = [];
        if (k.apartCluster > 0) {
            const mine = new Set<number>();
            list.forEach(({ result }, bi) => {
                nearOf[bi].forEach((d, g) => {
                    mine.add(g);
                });
                result.apartCells.forEach((g) => {
                    mine.add(g);
                });
            });
            if (mine.size >= k.apartCluster) {
                connected(detail.keys, [...mine].sort((a, b) => a - b), scratch).forEach((q) => {
                    if (q.length >= k.apartCluster && q.length >= k.apartPatch * hideCells && q.some(g => apartIndex[g] >= 0)) patches.push(q);
                });
            }
        }
        if (hideCells && (apartCells / hideCells > k.apartDrop || patches.length)) {
            dropped.push(region.id);
            droppedRegions.push(region);
            // named after the loser with the most apart cells (with several
            // losers: the one that lies off the winner's surface); its own
            // separation, the plane distances where it lies apart and in its
            // near cells of the patches
            let top = 0;
            list.forEach(({ result }, bi) => {
                if (result.apartCells.length > list[top].result.apartCells.length) top = bi;
            });
            const d = own[top].slice();
            patches.forEach(q => q.forEach((g) => {
                const near = nearOf[top].get(g);
                if (near && apartIndex[g] < 0) for (const v of near) d.push(v);
            }));
            const box = boxOf(detail.keys, region.cells, c);
            detail.rejected.push({ reason: 'apart', winner: region.winner, loser: list[top].batch.loser, cells: region.cells, ...box, value: d.length ? medianOf(d) : NaN });
            continue;
        }
        keep.push(region);
        painted.push(region);
        // numbers
        list.forEach(({ batch, result }) => {
            const li = region.losers.indexOf(batch.loser);
            const pl = region.perLoser[li];
            pl.hidden = result.hidden;
            pl.kept = result.kept;
            if (result.held) pl.held = result.held;
            if (result.haze) {
                pl.haze = result.haze;
                if (result.hazeRing) pl.hazeRing = result.hazeRing;
            }
            pl.covered = result.covered;
            pl.sep25 = result.sep25;
            pl.sep50 = result.sep50;
            pl.sep75 = result.sep75;
            pl.rn = result.rn;
            pl.rt = result.rt;
            pl.sW = result.sW;
            pl.mSelf = result.mSelf;
            pl.apartCells = result.apartCells.length;
            pl.uncoveredCells = result.uncoveredCells.length;
        });
    }
    detail.regions = keep;
    droppedRegions.forEach(r => r.cells.forEach((g) => {
        if (detail.regionOf[g] === r.id) detail.regionOf[g] = -1;
    }));

    // apart and uncovered cells into the state (apart wins)
    uncoveredAll.forEach((g) => {
        const h = detail.sharedIndex[g];
        if (h >= 0 && apartIndex[g] < 0) detail.state[h] = CellState.uncovered;
    });
    apartAll.forEach((g) => {
        const h = detail.sharedIndex[g];
        if (h >= 0) detail.state[h] = CellState.apart;
    });

    // apart clusters inside kept regions: per (region, loser), the connected
    // cells that loser's own paint found apart, not listed yet; the value is
    // that loser's separation alone (its finite plane distances there), so a
    // cluster never mixes losers and "Hier ausrichten" names the scan that
    // lies off. A listed cluster leaves its region
    const listed = new Uint8Array(G);
    detail.rejected.forEach((r) => {
        if (r.reason !== 'apart') return;
        r.cells.forEach((g) => {
            listed[g] = 1;
        });
    });
    const leave = new Uint8Array(G);
    painted.forEach(region => pairsOf.get(region.id).forEach(({ batch, result }) => {
        const at = new Map<number, number>();
        result.apartCells.forEach((g, i) => {
            if (!listed[g]) at.set(g, i);
        });
        if (at.size < k.rejectMin) return;
        connected(detail.keys, [...at.keys()].sort((a, b) => a - b), scratch).forEach((group) => {
            if (group.length < k.rejectMin) return;
            const d: number[] = [];
            group.forEach((g) => {
                const i = at.get(g);
                for (let p = result.apartStart[i]; p < result.apartStart[i + 1]; p++) d.push(result.apartDist[p]);
                leave[g] = 1;
            });
            const box = boxOf(detail.keys, group, c);
            detail.rejected.push({ reason: 'apart', winner: region.winner, loser: batch.loser, cells: new Int32Array(group), ...box, value: d.length ? medianOf(d) : NaN });
        });
    }));
    // the cells leave; the covered candidates of the other losers there stay
    // too (kept), and the numbers follow
    const stay = new Map<PaintBatchResult, number[]>();
    const emptied: Region[] = [];
    detail.regions.forEach((r) => {
        if (!r.cells.some(g => leave[g] === 1)) return;
        r.cells = r.cells.filter(g => !leave[g]);
        r.hideCells = r.hideCells.map(h => h.filter(g => !leave[g]));
        if (r.holdCells) r.holdCells = r.holdCells.map(h => h.filter(g => !leave[g]));
        let strongCells = 0;
        r.cells.forEach((g) => {
            const h = detail.sharedIndex[g];
            if (h >= 0 && detail.owner[h] === r.winner && detail.strong[h]) strongCells++;
        });
        r.strongCells = strongCells;
        if (!r.cells.length) emptied.push(r);
        (pairsOf.get(r.id) ?? []).forEach(({ batch, result }) => {
            const ranges: number[] = [];
            let lost = 0, heldLost = 0, hazeLost = 0;
            for (let i = 0; i < result.runCells.length; i++) {
                if (!leave[result.runCells[i]]) continue;
                const from = result.runStart[2 * i], to = result.runStart[2 * i + 1];
                ranges.push(from, to);
                for (let j = from; j < to; j++) {
                    const st = result.state[j];
                    if (st === PaintState.hidden || st === PaintState.haze) lost++;
                    else if (st === PaintState.held) heldLost++;
                    if (st === PaintState.haze) hazeLost++;
                }
            }
            if (!ranges.length) return;
            stay.set(result, ranges);
            const pl = r.perLoser[r.losers.indexOf(batch.loser)];
            pl.hidden -= lost;
            pl.kept += lost + heldLost;
            if (heldLost) pl.held -= heldLost;
            if (hazeLost) pl.haze -= hazeLost;
            // the cover proof's own share over its candidates (the haze zone
            // rows are none)
            const held = pl.held ?? 0, haze = pl.haze ?? 0;
            const proof = pl.hidden - (pl.hazeRing ?? 0) + pl.kept + held;
            pl.covered = proof ? (pl.hidden - haze + held) / proof : 0;
        });
    });
    for (let g = 0; g < G; g++) if (leave[g]) detail.regionOf[g] = -1;
    // a region whose cells all left is gone (its cells are listed as apart)
    if (emptied.length) {
        emptied.forEach(r => dropped.push(r.id));
        detail.regions = detail.regions.filter(r => !emptied.includes(r));
    }

    // confidence of the regions painted here
    painted.forEach((region) => {
        if (emptied.includes(region)) return;
        let clear = !region.forced && region.scope !== 'base' && region.strongCells / region.cells.length >= k.clearStrong &&
            region.lead >= k.clearLead && region.cells.length >= k.clearCells;
        region.perLoser.forEach((pl) => {
            if (pl.hidden === undefined) return;
            const b = biasOf(detail, region.winner, pl.scan);
            clear = clear && pl.lead - Math.max(0, b) >= k.clearOverBias && pl.sep50 <= k.clearSep * c && pl.covered >= k.clearCovered;
        });
        region.confidence = clear ? 'clear' : 'check';
    });

    // ids: renumbered when regions were dropped from a fresh paint
    const newId = new Map<number, number>();
    detail.regions.forEach((r, i) => {
        newId.set(r.id, fresh && dropped.length ? i : r.id);
    });
    if (fresh && dropped.length) {
        detail.regionOf.fill(-1);
        detail.regions.forEach((r) => {
            r.id = newId.get(r.id);
            r.cells.forEach((g) => {
                detail.regionOf[g] = r.id;
            });
        });
    }
    // per-row values
    pairsOf.forEach((list, id) => {
        if (!newId.has(id)) return;
        const value = newId.get(id) + 1;
        list.forEach(({ batch, result }) => {
            const out = paint[batch.loser];
            const rows = batch.rows;
            // held rows are not the card's: 0, so KEPT stays phase 3's gap
            // candidates (the winner has nothing near, apart, no surface);
            // haze is hidden, a haze zone row that is not haze no candidate
            for (let j = 0; j < rows.length; j++) {
                const st = result.state[j];
                out[rows[j]] = st === PaintState.hidden || st === PaintState.haze ? value : st === PaintState.held || !st ? 0 : value | KEPT;
            }
            const ranges = stay.get(result);
            if (ranges) {
                for (let i = 0; i < ranges.length; i += 2) {
                    for (let j = ranges[i]; j < ranges[i + 1]; j++) out[rows[j]] = value | KEPT;
                }
            }
        });
    });

    detail.rejected.sort((a, b) => Number(!!a.few) - Number(!!b.few) || b.cells.length - a.cells.length || a.cells[0] - b.cells[0]);
    apartAll.sort((a, b) => a - b);
    const uncoveredOnly = uncoveredAll.filter(g => apartIndex[g] < 0).sort((a, b) => a - b);
    return { paint, dropped, apartCells: new Int32Array(apartAll), uncoveredCells: new Int32Array(uncoveredOnly), seconds: (now() - t0) / 1000 };
};

export {
    DETAIL,
    CellState,
    PaintState,
    KEPT,
    footprintOf,
    opacityByte,
    lumCode,
    lumValue,
    niceCell,
    cellSample,
    sceneDiagonal,
    autoCell,
    gridCell,
    scanCells,
    composeDetail,
    biasOf,
    presentBox,
    forceRegion,
    makeProbe,
    paintInputs,
    composePaint,
    applyPaint,
    V3,
    DetailConstants,
    DetailOptions,
    CompactRows,
    ScanCells,
    ScanCellsLike,
    CellSample,
    AutoCell,
    PairInfo,
    ScanInfo,
    LoserNumbers,
    FreeView,
    Region,
    RejectReason,
    Rejected,
    DetailResult,
    PaintBatch,
    PaintJob,
    PaintBatchResult,
    PaintResult,
    PaintApplied,
    PaintInputOptions,
    ApplyOptions,
    ProbeScan,
    ProbePair,
    CellProbe
};
