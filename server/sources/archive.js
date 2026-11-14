import { config } from '../config.js';
import { HttpError, describeFetchError, mapLimit } from '../http.js';

/**
 * Internet Archive "feature_films": a large collection of public-domain and freely
 * licensed movies. Plays straight from archive.org — no proxy, no accounts, no cost.
 */

const COLLECTION_RE = /^[A-Za-z0-9_-]{1,60}$/;

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(config.fetchTimeoutMs), headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new HttpError(502, describeFetchError(e, config.archiveUrl));
  }
  if (!res.ok) throw new HttpError(502, `archive.org answered HTTP ${res.status}`);
  return res.json();
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function cleanText(html, max = 700) {
  const t = String(first(html) ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const GENRE_WORDS = [
  ['Horror', /horror|monster|zombie|vampire/i],
  ['Sci-Fi', /sci-?fi|science fiction|space|alien|robot/i],
  ['Comedy', /comedy|comic|slapstick|humou?r/i],
  ['Film Noir', /noir/i],
  ['Western', /western|cowboy/i],
  ['Crime', /crime|gangster|detective|mystery/i],
  ['Romance', /romance|love story/i],
  ['Animation', /animat|cartoon/i],
  ['Documentary', /documentary|newsreel/i],
  ['War', /\bwar\b|military|world war/i],
  ['Adventure', /adventure|jungle|serial/i],
  ['Drama', /drama/i],
];

function genresFrom(subjects) {
  const text = toArray(subjects).join(' ');
  const g = GENRE_WORDS.filter(([, re]) => re.test(text)).map(([n]) => n).slice(0, 3);
  return ['Classic', ...g];
}

function parseLength(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    if (p.some(Number.isNaN)) return null;
    return p.reduce((acc, n) => acc * 60 + n, 0) * 1000;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

/** Pick a web-playable MP4: the biggest one under ~1.2 GB so quality is decent but starts fast. */
function pickFile(files) {
  const ok = files
    .filter((f) => /\.mp4$/i.test(f.name) && ['h.264', 'mpeg4', 'h.264 ia'].includes(String(f.format || '').toLowerCase()))
    .map((f) => ({ f, size: Number(f.size) || 0 }))
    .sort((a, b) => a.size - b.size);
  if (!ok.length) return null;
  const under = ok.filter((x) => x.size <= 1.2e9);
  return (under.length ? under[under.length - 1] : ok[0]).f;
}

async function toItem(doc) {
  const id = String(doc.identifier);
  let meta;
  try {
    meta = await getJson(`${config.archiveUrl}/metadata/${encodeURIComponent(id)}`);
  } catch {
    return null; // skip titles whose metadata can't be read
  }
  const file = pickFile(meta.files || []);
  if (!file) return null;
  const year = parseInt(first(doc.year), 10);
  const img = `${config.archiveUrl}/services/img/${encodeURIComponent(id)}`;
  return {
    ext_id: id,
    kind: 'movie',
    title: cleanText(doc.title, 140) || id,
    year: Number.isFinite(year) ? year : null,
    summary: cleanText(doc.description),
    genres: genresFrom(doc.subject),
    rating: null,
    content_rating: null,
    duration_ms: parseLength(file.length),
    poster: `url:${img}`,
    backdrop: `url:${img}`,
    added_at: Date.now(),
    play_ref: {
      url: `${config.archiveUrl}/download/${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
    },
  };
}

export async function fetchLibrary(source) {
  const collection = COLLECTION_RE.test(source.cfg.collection || '') ? source.cfg.collection : 'feature_films';
  const query = String(source.cfg.query || '').slice(0, 120);
  const limit = Math.min(Math.max(parseInt(source.cfg.limit, 10) || 30, 1), 100);

  const q = [`collection:${collection}`, 'mediatype:movies', query ? `(${query})` : null].filter(Boolean).join(' AND ');
  const params = new URLSearchParams({ q, rows: String(limit), page: '1', output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'description', 'subject']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');

  const j = await getJson(`${config.archiveUrl}/advancedsearch.php?${params}`);
  const docs = j.response?.docs || [];
  const items = await mapLimit(docs, 5, toItem);
  return items.filter(Boolean);
}
