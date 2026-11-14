// Builds demo/nexus-demo.html: the real UI + an in-browser fake API, as one self-contained page.
import fs from 'node:fs';
const r = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const clip = fs.readFileSync(new URL('../demo/clip.mp4', import.meta.url)).toString('base64');

let i18n = r('public/i18n.js').replace('export const i18n =', 'const i18n =');
let app = r('public/app.js').replace("import { i18n } from './i18n.js';", '');
// Hosted artifacts only sync plain #names, so use "#home" instead of "#/home" here.
app = app.replaceAll('#/search?q=${encodeURIComponent(q)}', '#search').replaceAll("'#/", "'#").replaceAll('`#/', '`#')
  .replace("location.hash.replace(/^#\\//, '')", "location.hash.replace(/^#\\/?/, '')")
  .replace("history.replaceState(null, '', `#search`);", 'try { history.replaceState(null, "", "#search"); } catch {}');
const shim = r('demo/shim.js').replace('__CLIP__', clip);
const css = r('public/app.css') + `
.demo-ribbon{position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:200;background:rgba(0,229,255,.14);border:1px solid rgba(0,229,255,.4);color:var(--accent);font-size:.72rem;letter-spacing:.08em;padding:3px 12px;border-radius:20px;pointer-events:none;backdrop-filter:blur(8px)}
@media (max-width:720px){.demo-ribbon{bottom:64px}}`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#06060f"><title>NEXUS Demo</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<div class="aurora" aria-hidden="true"><div class="al a1"></div><div class="al a2"></div><div class="al a3"></div></div>
<div id="boot"><div class="spinner" role="status" aria-label="Loading"></div></div>
<div id="app" hidden></div><div id="modal-root"></div><div class="toasts" id="toasts" aria-live="polite"></div>
<div class="demo-ribbon">DEMO · sample titles · nothing is saved</div>
<script>${shim.replaceAll('</script', '<\\/script')}</script>
<script type="module">${(i18n + '\n' + app).replaceAll('</script', '<\\/script')}</script>
</body></html>`;
fs.writeFileSync(new URL('../demo/nexus-demo.html', import.meta.url), html);
console.log('demo built', (html.length / 1024).toFixed(0), 'KB');
