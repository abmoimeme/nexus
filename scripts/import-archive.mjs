// NOTE: the deploy workflow currently does NOT run this (classics are switched off); see .github/workflows/deploy-demo.yml.
// Imports free feature films from the Internet Archive into catalog/archive.json (used by build-firebase.mjs).
// Titles play straight from archive.org. Usage: npm run import:archive   (ARCHIVE_QUERY="western" ARCHIVE_LIMIT=60 optional)
import fs from 'node:fs';
import path from 'node:path';
import { fetchLibrary } from '../server/sources/archive.js';

const root = new URL('..', import.meta.url).pathname;
const out = process.env.OUT || path.join(root, 'catalog/archive.json');
const limit = Math.min(Math.max(parseInt(process.env.ARCHIVE_LIMIT, 10) || 80, 1), 100);

// Ids must not change between builds: watch progress and My List are stored against them.
const fnv = (s) => { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const taken = new Set();
const stableId = (ext) => { let id = 100_000 + (fnv(ext) % 900_000_000); while (taken.has(id)) id += 1; taken.add(id); return id; };

const rows = await fetchLibrary({ cfg: { collection: 'feature_films', query: process.env.ARCHIVE_QUERY || '', limit } });
if (!rows.length) { console.error('Internet Archive returned no playable films; leaving the catalog unchanged.'); process.exit(1); }
const now = Date.now();
const items = rows.map((r, i) => ({
  id: stableId(r.ext_id), kind: 'movie', title: r.title, year: r.year, contentRating: null, rating: null,
  durationMin: r.duration_ms ? Math.round(r.duration_ms / 60000) : null, genres: r.genres, summary: r.summary,
  poster: r.poster.replace(/^url:/, ''), backdrop: r.backdrop.replace(/^url:/, ''), source: 'archive', addedAt: now - i * 1000,
  streamUrl: r.play_ref.url,
}));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ importedAt: new Date(now).toISOString(), items }));
console.log(`Imported ${items.length} films from the Internet Archive -> ${out}`);
