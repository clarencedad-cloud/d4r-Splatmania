// The '?v=<build id>' that index.html puts on index.js (rollup.config.mjs).
// Files the app loads itself (locales, the analysis worker) get the same
// query, so a new build never meets year-old copies from the browser's http
// cache (some hosts serve static files with max-age of a year). Empty in
// dev builds.
const buildQuery = (() => {
    try {
        const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="index.js"]')?.src;
        return src ? new URL(src).search : '';
    } catch {
        return '';
    }
})();

export { buildQuery };
