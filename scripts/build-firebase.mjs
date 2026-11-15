// Builds hosting/: the real NEXUS UI + the Firebase backend bundle + the sample catalog. (Run `npm run build:site`.)
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { items as sampleItems, AVATARS } from '../demo/catalog.mjs';

const root = new URL('..', import.meta.url).pathname;
const out = process.argv[2] || path.join(root, 'hosting');
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'firebase/backend.js')], outfile: path.join(out, 'backend.js'),
  bundle: true, minify: true, format: 'esm', target: 'es2022', legalComments: 'none', logLevel: 'warning',
});
for (const f of ['app.js', 'i18n.js', 'app.css']) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'public/vendor/hls.min.js'), path.join(out, 'vendor/hls.min.js'));
fs.copyFileSync(path.join(root, 'demo/clip.mp4'), path.join(out, 'clip.mp4'));
// If catalog/plex.json exists (from `npm run cli -- export-catalog` on the NEXUS server) the site shows that library's titles and artwork.
// Titles are marked private: the public site lists them but never streams them. Otherwise it shows the fictional sample titles.
let items = sampleItems; let label = 'sample';
const plexFile = path.join(root, 'catalog/plex.json');
if (fs.existsSync(plexFile)) {
  try {
    const p = JSON.parse(fs.readFileSync(plexFile, 'utf8')).items;
    if (Array.isArray(p) && p.length) { items = p; label = 'Plex export'; fs.cpSync(path.join(root, 'catalog/art'), path.join(out, 'art'), { recursive: true }); }
  } catch (e) { console.warn('catalog/plex.json unreadable; using sample titles:', e.message); }
}
fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify({ avatars: AVATARS, items }));
console.log(`catalog: ${items.length} titles (${label})`);

// backend.js must run before app.js so the fetch shim is in place when the UI boots.
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .replace('<script src="/app.js" type="module"></script>', '<script src="/backend.js" type="module"></script>\n<script src="/app.js" type="module"></script>');
if (!html.includes('/backend.js')) throw new Error('index.html changed: could not insert backend.js');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('firebase site built ->', out);
