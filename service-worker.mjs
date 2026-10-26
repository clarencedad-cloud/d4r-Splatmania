import crypto from 'crypto';
import fs from 'fs';

// emits sw.js with the list of every file this build writes (minus source
// maps), plus any extra files from other bundles, and a content hash as the
// cache version so each new build replaces the old offline cache
export default function serviceWorker({ src, extra = [] }) {
    return {
        name: 'service-worker',
        buildStart() {
            this.addWatchFile(src);
        },
        generateBundle(options, bundle) {
            const keys = Object.keys(bundle)
            .filter(name => !name.endsWith('.map'))
            .sort();

            const hash = crypto.createHash('sha256');
            keys.forEach((name) => {
                const item = bundle[name];
                hash.update(name);
                hash.update(item.type === 'chunk' ? item.code : item.source);
            });

            const files = keys.map(name => name.replace(/\\/g, '/'));
            const precache = ['./', ...files.filter(name => name !== 'index.html'), ...extra];
            const source = fs.readFileSync(src, 'utf8')
            .replace('__VERSION__', hash.digest('hex').slice(0, 12))
            .replace('__PRECACHE__', JSON.stringify(precache.map(name => (name === './' ? name : `./${name}`)), null, 4));

            this.emitFile({ type: 'asset', fileName: 'sw.js', source });
        }
    };
}
