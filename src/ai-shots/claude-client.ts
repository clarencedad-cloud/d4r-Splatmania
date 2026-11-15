import type Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam, BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages';

import { SHOT_LIMITS, SHOT_TEMPLATES, type ShotParams, type ShotTemplate } from './shot-types';

// Optional Claude support for the shot suggestions: the user brings their own
// Anthropic API key, the browser talks to api.anthropic.com directly. Without
// a key (or offline) the module works with the deterministic generator only.
// The key never goes into URLs, logs or error messages.

const CLAUDE_MODEL = 'claude-opus-5-5';

const STORAGE_KEY = 'splatmania.ai.apiKey';

type KeyStore = {
    get(): string | null;
    set(key: string, remember: boolean): void;
    clear(): void;
    remembered(): boolean;
    // called when the key changes from outside this tab (another tab removed
    // or replaced the remembered key); returns an unsubscribe function
    onChange(listener: () => void): () => void;
};

class ClaudeError extends Error {
    // i18n key, e.g. 'sm.aishots.err.auth'
    code: string;
    // optional non-sensitive detail (refusal category, 'max_tokens', ...)
    detail?: string;

    constructor(code: string, detail?: string) {
        super(detail ? `${code} (${detail})` : code);
        this.name = 'ClaudeError';
        this.code = code;
        this.detail = detail;
    }
}

type PlanInput = {
    wish: string;
    object: { size: [number, number, number]; source: string };
    anchors: number;
    durationHint?: number;
    language: string;
};

type RankCandidate = {
    id: string;
    title: string;
    // 1-3 JPEG frames (start, middle, end), each at most 512px wide
    jpegBase64: string[];
};

type RankInput = {
    wish?: string;
    language: string;
    candidates: RankCandidate[];
};

type RankResult = { id: string; score: number; comment: string };

// session storage by default; local storage only when the user opts in, because
// local storage is shared with every page on the same origin (the editor may
// run under a WordPress site). Session storage is per tab, but a browser copies
// it into windows this page opens without 'noopener' - every window.open /
// target=_blank link of the editor must use 'noopener,noreferrer'.
// get() reads the storages afresh on every call; the in-memory copy is only a
// fallback for this page when storage is blocked.
let memoryKey: string | null = null;

const storageGet = (storage: () => Storage) => {
    try {
        return storage().getItem(STORAGE_KEY);
    } catch {
        return null;
    }
};

const storageSet = (storage: () => Storage, value: string) => {
    try {
        storage().setItem(STORAGE_KEY, value);
        return true;
    } catch {
        // storage blocked: the in-memory copy serves this page
        return false;
    }
};

const storageRemove = (storage: () => Storage) => {
    try {
        storage().removeItem(STORAGE_KEY);
    } catch {
        // storage blocked
    }
};

const session = () => window.sessionStorage;
const local = () => window.localStorage;

const keyListeners = new Set<() => void>();

const keyStore: KeyStore = {
    get() {
        return storageGet(session) || storageGet(local) || memoryKey || null;
    },
    set(key: string, remember: boolean) {
        const value = (key ?? '').trim();
        if (!value) {
            keyStore.clear();
            return;
        }
        memoryKey = storageSet(session, value) ? null : value;
        if (remember) {
            storageSet(local, value);
        } else {
            storageRemove(local);
        }
    },
    clear() {
        memoryKey = null;
        storageRemove(session);
        storageRemove(local);
    },
    remembered() {
        return !!storageGet(local);
    },
    onChange(listener: () => void) {
        keyListeners.add(listener);
        return () => keyListeners.delete(listener);
    }
};

// "Key löschen" in another tab removes the shared local storage entry; this
// tab then drops its own session copy too, so the key neither keeps being sent
// nor gets written back by toggling "remember" here. A remembered key replaced
// in another tab replaces this tab's copy of it.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event: StorageEvent) => {
        let localArea: Storage | null = null;
        try {
            localArea = local();
        } catch {
            return;
        }
        if (event.storageArea !== localArea) return;
        // key === null: localStorage.clear() in another tab
        if (event.key !== null && event.key !== STORAGE_KEY) return;

        const removed = event.key === null || event.newValue === null;
        if (removed) {
            memoryKey = null;
            storageRemove(session);
        } else if (event.newValue && event.oldValue && storageGet(session) === event.oldValue) {
            // this tab used the remembered key: follow the replacement
            storageSet(session, event.newValue);
        } else {
            return;
        }
        keyListeners.forEach((listener) => {
            try {
                listener();
            } catch {
                // a listener's failure must not stop the others
            }
        });
    });
}

const aiAvailable = () => {
    return !!keyStore.get() && (typeof navigator === 'undefined' || navigator.onLine !== false);
};

// the SDK is loaded on first use, so the editor neither downloads nor parses it
// unless the user actually calls Claude
type Sdk = typeof import('@anthropic-ai/sdk');
let sdkPromise: Promise<Sdk> | null = null;

const loadSdk = async (): Promise<Sdk> => {
    if (!sdkPromise) {
        sdkPromise = import('@anthropic-ai/sdk');
    }
    try {
        return await sdkPromise;
    } catch {
        sdkPromise = null;
        throw new ClaudeError('sm.aishots.err.network');
    }
};

const toClaudeError = (err: unknown, sdk: Sdk): ClaudeError => {
    const A = sdk.default;
    if (err instanceof ClaudeError) {
        return err;
    }
    if (err instanceof A.APIUserAbortError) {
        return new ClaudeError('sm.aishots.err.aborted');
    }
    if (err instanceof A.AuthenticationError || err instanceof A.PermissionDeniedError) {
        return new ClaudeError('sm.aishots.err.auth');
    }
    if (err instanceof A.RateLimitError) {
        return new ClaudeError('sm.aishots.err.rate');
    }
    if (err instanceof A.APIConnectionError) {
        return new ClaudeError('sm.aishots.err.network');
    }
    if (err instanceof A.APIError) {
        // the status only; the SDK message may echo request details
        return new ClaudeError('sm.aishots.err.api', err.status ? String(err.status) : undefined);
    }
    return new ClaudeError('sm.aishots.err.api');
};

const createClient = (sdk: Sdk, apiKey: string): Anthropic => {
    return new sdk.default({ apiKey, dangerouslyAllowBrowser: true, logLevel: 'off' });
};

const requireKey = () => {
    const key = keyStore.get();
    if (!key) {
        throw new ClaudeError('sm.aishots.err.auth');
    }
    return key;
};

const testKey = async (key: string): Promise<void> => {
    const value = (key ?? '').trim();
    if (!value) {
        throw new ClaudeError('sm.aishots.err.auth');
    }
    const sdk = await loadSdk();
    try {
        await createClient(sdk, value).models.retrieve(CLAUDE_MODEL);
    } catch (err) {
        throw toClaudeError(err, sdk);
    }
};

// one structured-output request; returns the parsed JSON of the text block
const requestJson = async (
    effort: 'low' | 'medium',
    schema: Record<string, unknown>,
    system: string,
    content: BetaContentBlockParam[],
    signal?: AbortSignal
): Promise<unknown> => {
    if (signal?.aborted) {
        throw new ClaudeError('sm.aishots.err.aborted');
    }
    const key = requireKey();
    const sdk = await loadSdk();
    const client = createClient(sdk, key);

    const params: MessageCreateParamsNonStreaming = {
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
            effort,
            format: { type: 'json_schema', schema }
        },
        system,
        messages: [{ role: 'user', content }]
    };

    let message: BetaMessage;
    try {
        message = await client.beta.messages.create(params, { signal });
    } catch (err) {
        throw toClaudeError(err, sdk);
    }

    if (message.stop_reason === 'refusal') {
        throw new ClaudeError('sm.aishots.err.refusal', message.stop_details?.category ?? undefined);
    }
    if (message.stop_reason === 'max_tokens') {
        throw new ClaudeError('sm.aishots.err.api', 'max_tokens');
    }

    const text = message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');

    try {
        return JSON.parse(text);
    } catch {
        throw new ClaudeError('sm.aishots.err.api', 'invalid_json');
    }
};

const clamp = (value: number, range: readonly [number, number]) => {
    return Math.max(range[0], Math.min(range[1], value));
};

const isNumber = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value);
};

const text = (value: unknown, maxLength: number) => {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
};

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

const planSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['shots'],
    properties: {
        shots: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'template', 'durationSec', 'distanceFactor', 'heightFactor', 'startAngleDeg', 'sweepDeg',
                    'direction', 'focusPull', 'easing', 'label', 'rationale'
                ],
                properties: {
                    template: { type: 'string', enum: SHOT_TEMPLATES },
                    durationSec: { type: 'number' },
                    distanceFactor: { type: 'number' },
                    heightFactor: { type: 'number' },
                    startAngleDeg: nullable({ type: 'number' }),
                    sweepDeg: nullable({ type: 'number' }),
                    direction: nullable({ type: 'string', enum: ['cw', 'ccw'] }),
                    focusPull: { type: 'boolean' },
                    easing: { type: 'string', enum: ['linear', 'smooth'] },
                    label: { type: 'string' },
                    rationale: { type: 'string' }
                }
            }
        }
    }
};

const range = (r: readonly [number, number]) => `${r[0]}..${r[1]}`;

const planSystem = [
    'You plan camera moves ("shots") for a 3D Gaussian splat scan viewer. A deterministic generator turns your parameters into camera keyframes, so you only choose templates and parameters.',
    'The camera always looks at the marked object. Y is up. Distances are multiples of the object radius (the half diagonal of its bounding box), measured from the object centre.',
    '',
    'Templates:',
    '- orbit: circles the object at a constant distance (distanceFactor) and height, rising slightly on a partial turn. sweepDeg is the angle travelled (360 = full turn).',
    '- reveal: starts close, low and off to the side looking past the object\'s edge, then pulls back and arcs round by sweepDeg (at most 120) so the object comes into full view; the look-at point drifts onto the object. distanceFactor and heightFactor are the end position.',
    '- crane: rises (or descends) while looking at the object, coming slightly closer; distanceFactor and heightFactor are the end position. An end height of about 0.25 or more rises from below the object centre; a lower end height descends from above instead.',
    '- slide: a lateral dolly past the object, parallel to its longest horizontal axis; distanceFactor is the closest distance, startAngleDeg the side the track runs on, sweepDeg (at most 120) the angular span the object turns through as seen from the camera.',
    '- pushIn: moves straight towards the object from distanceFactor (the start distance) to about half of it; works well with focusPull.',
    '- flyover: travels at height (heightFactor of at least 0.6) over the object and tilts down towards a top view; distanceFactor is the start distance.',
    '',
    'Parameters (values outside a range are clamped):',
    `- durationSec: ${range(SHOT_LIMITS.durationSec)} seconds.`,
    `- distanceFactor: ${range(SHOT_LIMITS.distanceFactor)} object radii from the object centre; which point of the move it sets depends on the template (see above).`,
    `- heightFactor: ${range(SHOT_LIMITS.heightFactor)} object radii of camera height above the object centre. The camera elevation always stays within ${range(SHOT_LIMITS.elevationDeg)} degrees.`,
    '- startAngleDeg: azimuth of the camera around the object at the start of the move, in degrees of the scene\'s own frame: 0 = on the +Z side, 90 = on the +X side, increasing counter-clockwise seen from above. For slide it is the side of the track. Use null to let the generator pick the best-covered side or the user\'s saved favourite angles; prefer null unless the wish clearly asks for a specific side.',
    `- sweepDeg: orbit, reveal and slide only, ${range(SHOT_LIMITS.sweepDeg)} degrees; null for the other templates.`,
    '- direction: "cw" (clockwise seen from above) or "ccw" for orbit, reveal, crane, slide and flyover; null for pushIn.',
    '- focusPull: true adds a depth-of-field focus pull that keeps the object sharp while the background blurs.',
    '- easing: "smooth" eases in and out, "linear" moves at constant speed.',
    '- label: a short title for the shot (max. 40 characters).',
    '- rationale: one sentence on why this shot suits the object and the wish.',
    '',
    'Return 3 to 6 varied shots that fit the wish, the object\'s proportions and the requested duration. Scans often have holes or floaters on poorly captured sides and far away from the object, so keep distances moderate unless the wish asks for wide shots.'
].join('\n');

const toShotParams = (raw: any): ShotParams | null => {
    if (!raw || typeof raw !== 'object' || !SHOT_TEMPLATES.includes(raw.template)) {
        return null;
    }
    const template = raw.template as ShotTemplate;
    const sweeps = template === 'orbit' || template === 'reveal' || template === 'slide';
    const turns = template !== 'pushIn';

    const params: ShotParams = {
        template,
        durationSec: clamp(isNumber(raw.durationSec) ? raw.durationSec : 8, SHOT_LIMITS.durationSec),
        distanceFactor: clamp(isNumber(raw.distanceFactor) ? raw.distanceFactor : 1.6, SHOT_LIMITS.distanceFactor),
        heightFactor: clamp(isNumber(raw.heightFactor) ? raw.heightFactor : 0.4, SHOT_LIMITS.heightFactor),
        focusPull: raw.focusPull === true,
        easing: raw.easing === 'linear' ? 'linear' : 'smooth'
    };

    if (isNumber(raw.startAngleDeg)) {
        params.startAngleDeg = ((raw.startAngleDeg % 360) + 360) % 360;
    }
    if (sweeps && isNumber(raw.sweepDeg)) {
        params.sweepDeg = clamp(Math.abs(raw.sweepDeg), SHOT_LIMITS.sweepDeg);
    }
    if (turns && (raw.direction === 'cw' || raw.direction === 'ccw')) {
        params.direction = raw.direction;
    }

    const label = text(raw.label, 40);
    if (label) {
        params.label = label;
    }
    const rationale = text(raw.rationale, 300);
    if (rationale) {
        params.rationale = rationale;
    }
    return params;
};

const planShots = async (input: PlanInput, signal?: AbortSignal): Promise<ShotParams[]> => {
    const size = (input.object?.size ?? [1, 1, 1]).map(v => (isNumber(v) ? Number(v.toPrecision(4)) : 1));
    const lines = [
        `Wish: ${input.wish?.trim() || '(none: propose a varied, attractive set)'}`,
        `Object: ${input.object?.source ?? 'scene'}, bounding box ${size[0]} x ${size[1]} x ${size[2]} scene units (width x height x depth).`,
        `Saved favourite angles: ${Math.max(0, Math.round(input.anchors ?? 0))}${input.anchors > 0 ? ' (the generator routes shots through them when startAngleDeg is null)' : ''}.`
    ];
    if (isNumber(input.durationHint)) {
        lines.push(`Preferred duration: about ${Math.round(input.durationHint)} seconds per shot.`);
    }
    lines.push(`Write label and rationale in this language: ${input.language || 'en'}.`);

    const result: any = await requestJson('low', planSchema, planSystem, [{ type: 'text', text: lines.join('\n') }], signal);
    const shots = (Array.isArray(result?.shots) ? result.shots : [])
    .map(toShotParams)
    .filter((p: ShotParams | null): p is ShotParams => !!p)
    .slice(0, 6);

    if (shots.length === 0) {
        throw new ClaudeError('sm.aishots.err.api', 'no_shots');
    }
    return shots;
};

const rankSystem = [
    'You review proposed camera moves through a 3D Gaussian splat scan. Each candidate is shown as up to three rendered frames (start, middle, end).',
    'Score each candidate from 0 to 10 on: composition and framing of the object; how engaging the move is over its frames; visible scan artefacts (holes, missing data, blurry or smeared areas, floating specks / floaters, the edge of the captured area), which cost points heavily; and how well it fits the user\'s wish, if one is given.',
    'Give every candidate exactly one entry, using its id. The comment is one short sentence naming the main strength or problem.'
].join('\n');

const stripDataUrl = (value: string) => {
    const comma = value.indexOf(',');
    return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
};

const rankShots = async (input: RankInput, signal?: AbortSignal): Promise<RankResult[]> => {
    const candidates = (input.candidates ?? []).filter(c => c && c.id && c.jpegBase64?.length);
    if (candidates.length === 0) {
        return [];
    }
    const ids = candidates.map(c => c.id);

    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['rankings'],
        properties: {
            rankings: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'score', 'comment'],
                    properties: {
                        id: { type: 'string', enum: ids },
                        score: { type: 'number' },
                        comment: { type: 'string' }
                    }
                }
            }
        }
    };

    const content: BetaContentBlockParam[] = [];
    candidates.forEach((c) => {
        content.push({ type: 'text', text: `Kandidat ${c.id}: ${c.title}` });
        c.jpegBase64.slice(0, 3).forEach((data) => {
            content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: stripDataUrl(data) } });
        });
    });
    content.push({
        type: 'text',
        text: [
            input.wish?.trim() ? `User wish: ${input.wish.trim()}` : 'No specific wish: judge general visual quality.',
            `Score all ${candidates.length} candidates. Write the comments in this language: ${input.language || 'en'}.`
        ].join('\n')
    });

    const result: any = await requestJson('medium', schema, rankSystem, content, signal);
    const seen = new Set<string>();
    const rankings: RankResult[] = [];
    (Array.isArray(result?.rankings) ? result.rankings : []).forEach((r: any) => {
        if (!r || !ids.includes(r.id) || seen.has(r.id) || !isNumber(r.score)) {
            return;
        }
        seen.add(r.id);
        rankings.push({ id: r.id, score: clamp(r.score, [0, 10]), comment: text(r.comment, 300) });
    });
    return rankings;
};

export {
    CLAUDE_MODEL,
    ClaudeError,
    keyStore,
    aiAvailable,
    testKey,
    planShots,
    rankShots,
    type KeyStore,
    type PlanInput,
    type RankInput,
    type RankCandidate,
    type RankResult
};
