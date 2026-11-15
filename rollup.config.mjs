import fs from 'fs';
import path from 'path';

import alias from '@rollup/plugin-alias';
import image from '@rollup/plugin-image';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

import copyAndWatch from './copy-and-watch.mjs';
import serviceWorker from './service-worker.mjs';

// prod is release build
if (process.env.BUILD_TYPE === 'prod') {
    process.env.BUILD_TYPE = 'release';
}
// debug, profile, release
const BUILD_TYPE = process.env.BUILD_TYPE || 'release';
const ENGINE_DIR = path.resolve(`node_modules/playcanvas/build/playcanvas${BUILD_TYPE === 'debug' ? '.dbg' : ''}/src/index.js`);
const PCUI_DIR = path.resolve('node_modules/@playcanvas/pcui');
const HREF = process.env.BASE_HREF || '';
// build output folder; a release build can go to its own folder (e.g. OUT_DIR=release)
const OUT_DIR = process.env.OUT_DIR || 'dist';
// per-build id appended to the entry files in index.html (?v=...): hosts like
// SiteGround serve js/css with a one-year cache that .htaccess cannot change,
// so a new url is the only reliable way to make a new build reach visitors
const BUILD_ID = Date.now().toString(36);

const outputHeader = () => {
    const BLUE_OUT = '\x1b[34m';
    const BOLD_OUT = '\x1b[1m';
    const REGULAR_OUT = '\x1b[22m';
    const RESET_OUT = '\x1b[0m';

    const title = [
        'Building SuperSplat',
        `type ${BOLD_OUT}${BUILD_TYPE}${REGULAR_OUT}`
    ].map(l => `${BLUE_OUT}${l}`).join('\n');
    console.log(`${BLUE_OUT}${title}${RESET_OUT}\n`);
};

outputHeader();

// @anthropic-ai/sdk lists browser stubs for its node-only helpers (credential
// files, tools) in its package.json "browser" field. Apply only that map here:
// resolve({ browser: true }) would switch every other package as well. Its
// webhook verifier needs the CommonJS package standardwebhooks, which this
// build cannot bundle and the editor never uses, so that import gets a stub.
const anthropicBrowserStubs = () => {
    const root = path.resolve('node_modules/@anthropic-ai/sdk');
    const webhookStub = '\0anthropic-webhook-stub';
    const inside = (id) => {
        const rel = id ? path.relative(root, id) : '..';
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    let map = {};
    try {
        map = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).browser ?? {};
    } catch {
        // sdk not installed
    }

    return {
        name: 'anthropic-browser-stubs',
        async resolveId(source, importer, options) {
            if (!inside(importer)) {
                return null;
            }
            if (source === 'standardwebhooks') {
                return webhookStub;
            }
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            if (!resolved || resolved.external || !inside(resolved.id)) {
                return resolved;
            }
            const stub = map[`./${path.relative(root, resolved.id).replace(/\\/g, '/')}`];
            return stub ? { ...resolved, id: path.join(root, stub) } : resolved;
        },
        load(id) {
            if (id !== webhookStub) {
                return null;
            }
            return 'export class Webhook { constructor() { throw new Error("webhook verification is not available in this build"); } }';
        }
    };
};

const application = {
    input: 'src/index.ts',
    output: {
        dir: OUT_DIR,
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        copyAndWatch({
            targets: [
                {
                    src: 'src/index.html',
                    transform: (contents, filename) => {
                        return contents.toString().replace('__BASE_HREF__', HREF).replace(/__BUILD__/g, BUILD_ID);
                    }
                },
                { src: 'src/manifest.json' },
                { src: 'static/images', dest: 'static' },
                { src: 'static/icons', dest: 'static' },
                { src: 'static/lib', dest: 'static' },
                // the WebP decoder's wasm must match the JS glue bundled from
                // splat-transform, so take it from the installed package
                { src: 'node_modules/@playcanvas/splat-transform/lib/webp.wasm', dest: 'static/lib/webp' },
                { src: 'static/locales', dest: 'static' }
            ]
        }),
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        typescript({
            tsconfig: './tsconfig.json'
        }),
        anthropicBrowserStubs(),
        resolve(),
        image({ dom: false }),
        json(),
        scss({
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            },
            fileName: 'index.css',
            includePaths: [`${PCUI_DIR}/dist`],
            watch: 'src/ui/scss'
        }),
        BUILD_TYPE !== 'debug' && terser(),
        // offline cache for the installed app; the worker bundle below is
        // built separately, so it is listed by hand
        serviceWorker({ src: 'src/sw.js', extra: ['analysis-worker.js'] })
    ],
    treeshake: 'smallest',
    cache: false
};

// analysis worker (ICP fine alignment, quality scores): a separate bundle so
// the pure cores run off the main thread (src/analysis/analysis-client.ts)
const analysisWorker = {
    input: 'src/analysis/analysis-worker.ts',
    output: {
        file: `${OUT_DIR}/analysis-worker.js`,
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        typescript({
            tsconfig: './tsconfig.json',
            // the worker bundle only needs its own sources
            include: ['src/analysis/analysis-worker.ts', 'src/align/icp.ts', 'src/quality/quality-score.ts'],
            outputToFilesystem: false
        }),
        resolve(),
        BUILD_TYPE !== 'debug' && terser()
    ],
    cache: false
};

export default [application, analysisWorker];
