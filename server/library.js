import { all, get, run } from './db.js';

/** Content ratings a Kids profile may see. Unrated / unknown titles are hidden from Kids profiles. */
export const KIDS_RATINGS = ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'U'];
const KIDS_SQL = `items.content_rating IN (${KIDS_RATINGS.map(() => '?').join(',')})`;
const BASE = 'SELECT items.*, sources.type AS source_type FROM items JOIN sources ON sources.id = items.source_id';

export const kidsAllows = (profile, row) => !profile.kids || KIDS_RATINGS.includes(row.content_rating || '');

/* ---------- Serialization ---------- */

export function imageUrl(sourceId, ref, w, h) {
  if (!ref) return null;
  if (ref.startsWith('url:')) return ref.slice(4);
  if (ref.startsWith('plex:')) {
    return `/api/sources/${sourceId}/image?p=${encodeURIComponent(ref.slice(5))}&w=${w}&h=${h}`;
  }
  return null;
}

function progressMap(profileId) {
  const rows = all(
    'SELECT item_id, ep_key, ep_label, position_ms, duration_ms, updated_at FROM progress WHERE profile_id = ? ORDER BY updated_at DESC',
    profileId,
  );
  const m = new Map();
  for (const r of rows) {
    if (m.has(r.item_id)) continue; // newest entry per title wins
    m.set(r.item_id, {
      epKey: r.ep_key || null,
      epLabel: r.ep_label || null,
      positionMs: r.position_ms,
      durationMs: r.duration_ms,
      pct: r.duration_ms ? r.position_ms / r.duration_ms : 0,
      updatedAt: r.updated_at,
    });
  }
  return m;
}

export function context(profile) {
  return {
    profile,
    prog: progressMap(profile.id),
    list: new Set(all('SELECT item_id FROM mylist WHERE profile_id = ?', profile.id).map((r) => r.item_id)),
  };
}

export function serialize(row, ctx) {
  const p = ctx.prog.get(row.id);
  const inProgress = p && p.pct >= 0.02 && p.pct < 0.95;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    year: row.year,
    summary: row.summary || '',
    genres: JSON.parse(row.genres || '[]'),
    rating: row.rating,
    contentRating: row.content_rating,
    durationMin: row.duration_ms ? Math.round(row.duration_ms / 60000) : null,
    poster: imageUrl(row.source_id, row.poster, 360, 540),
    backdrop: imageUrl(row.source_id, row.backdrop, 1600, 900),
    source: row.source_type,
    addedAt: row.added_at,
    inList: ctx.list.has(row.id),
    progress: inProgress
      ? { pct: p.pct, label: p.epLabel, epKey: p.epKey, positionMs: p.positionMs }
      : null,
  };
}

/* ---------- Queries ---------- */

const ORDER = {
  recent: 'items.added_at DESC, items.id DESC',
  title: 'items.title COLLATE NOCASE ASC',
  rating: 'items.rating IS NULL, items.rating DESC, items.added_at DESC',
  year: 'items.year IS NULL, items.year DESC',
};

function filters(profile, opts) {
  const where = [];
  const params = [];
  if (profile.kids) { where.push(KIDS_SQL); params.push(...KIDS_RATINGS); }
  if (opts.kind) { where.push('items.kind = ?'); params.push(opts.kind); }
  if (opts.genre) {
    where.push('EXISTS (SELECT 1 FROM json_each(items.genres) WHERE json_each.value = ?)');
    params.push(opts.genre);
  }
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(items.title LIKE ? ESCAPE '\\' OR items.summary LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  if (opts.hasBackdrop) where.push('items.backdrop IS NOT NULL');
  if (opts.hasRating) where.push('items.rating IS NOT NULL');
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function queryItems(profile, opts = {}) {
  const { where, params } = filters(profile, opts);
  const order = ORDER[opts.sort] || ORDER.recent;
  return all(
    `${BASE} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, opts.limit ?? 40, opts.offset ?? 0,
  );
}

export function getItemRow(profile, id) {
  const kids = profile.kids ? ` AND ${KIDS_SQL}` : '';
  return get(`${BASE} WHERE items.id = ?${kids}`, id, ...(profile.kids ? KIDS_RATINGS : [])) ?? null;
}

function byIds(profile, ids) {
  if (!ids.length) return [];
  const kids = profile.kids ? ` AND ${KIDS_SQL}` : '';
  const rows = all(
    `${BASE} WHERE items.id IN (${ids.map(() => '?').join(',')})${kids}`,
    ...ids, ...(profile.kids ? KIDS_RATINGS : []),
  );
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

export function genreCounts(profile, kind) {
  const kids = profile.kids ? `AND ${KIDS_SQL}` : '';
  const k = kind ? 'AND items.kind = ?' : '';
  return all(
    `SELECT json_each.value AS genre, COUNT(*) AS n
       FROM items, json_each(items.genres)
      WHERE 1 = 1 ${kids} ${k}
      GROUP BY json_each.value ORDER BY n DESC, genre LIMIT 24`,
    ...(profile.kids ? KIDS_RATINGS : []), ...(kind ? [kind] : []),
  );
}

export function stats(profile) {
  const kids = profile.kids ? `WHERE ${KIDS_SQL}` : '';
  const r = get(
    `SELECT SUM(kind = 'movie') AS movies, SUM(kind = 'show') AS shows,
            SUM(CASE WHEN kind = 'movie' THEN duration_ms ELSE 0 END) AS ms
       FROM items ${kids}`,
    ...(profile.kids ? KIDS_RATINGS : []),
  );
  return {
    movies: r.movies || 0,
    shows: r.shows || 0,
    hours: Math.round((r.ms || 0) / 3_600_000),
    sources: get('SELECT COUNT(*) AS n FROM sources').n,
  };
}

/* ---------- Home ---------- */

export function buildHome(profile) {
  const ctx = context(profile);
  const rows = [];
  const push = (id, title, list, extra = {}) => {
    if (list.length) rows.push({ id, title, items: list.map((r) => serialize(r, ctx)), ...extra });
  };

  const continueIds = [...ctx.prog.entries()]
    .filter(([, p]) => p.pct >= 0.02 && p.pct < 0.95)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 20)
    .map(([id]) => id);
  push('continue', 'Continue Watching', byIds(profile, continueIds), { wide: true });

  const listIds = all('SELECT item_id FROM mylist WHERE profile_id = ? ORDER BY added_at DESC LIMIT 30', profile.id).map((r) => r.item_id);
  push('mylist', 'My List', byIds(profile, listIds));

  push('recent', 'Recently Added', queryItems(profile, { sort: 'recent', limit: 20 }));
  push('top', 'Top Rated', queryItems(profile, { sort: 'rating', hasRating: true, limit: 20 }));
  push('movies', 'Movies', queryItems(profile, { kind: 'movie', sort: 'recent', limit: 20 }));
  push('shows', 'TV Shows', queryItems(profile, { kind: 'show', sort: 'recent', limit: 20 }));

  for (const g of genreCounts(profile).filter((x) => x.n >= 3).slice(0, 4)) {
    push(`genre:${g.genre}`, g.genre, queryItems(profile, { genre: g.genre, sort: 'rating', limit: 20 }));
  }

  const pool = queryItems(profile, { sort: 'rating', hasBackdrop: true, limit: 10 });
  const hero = pool.length ? pool[Math.floor(Date.now() / 86_400_000) % pool.length] : null;

  return {
    hero: hero ? serialize(hero, ctx) : null,
    rows,
    stats: stats(profile),
    empty: !get('SELECT 1 AS x FROM items LIMIT 1'),
  };
}

/* ---------- Progress & My List ---------- */

export function saveProgress(profileId, p) {
  run(
    `INSERT INTO progress(profile_id, item_id, ep_key, ep_label, position_ms, duration_ms, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(profile_id, item_id, ep_key) DO UPDATE SET
       ep_label = excluded.ep_label, position_ms = excluded.position_ms,
       duration_ms = excluded.duration_ms, updated_at = excluded.updated_at`,
    profileId, p.itemId, p.epKey || '', p.epLabel || null, p.positionMs, p.durationMs, Date.now(),
  );
}

export const getProgress = (profileId, itemId, epKey) =>
  get('SELECT * FROM progress WHERE profile_id = ? AND item_id = ? AND ep_key = ?', profileId, itemId, epKey || '') ?? null;

export function episodeProgress(profileId, itemId) {
  const out = {};
  for (const r of all('SELECT ep_key, position_ms, duration_ms FROM progress WHERE profile_id = ? AND item_id = ?', profileId, itemId)) {
    if (r.ep_key) out[r.ep_key] = r.duration_ms ? r.position_ms / r.duration_ms : 0;
  }
  return out;
}

export function setMyList(profileId, itemId, on) {
  if (on) run('INSERT OR IGNORE INTO mylist(profile_id, item_id, added_at) VALUES (?,?,?)', profileId, itemId, Date.now());
  else run('DELETE FROM mylist WHERE profile_id = ? AND item_id = ?', profileId, itemId);
}

export function listMyList(profile) {
  const ids = all('SELECT item_id FROM mylist WHERE profile_id = ? ORDER BY added_at DESC', profile.id).map((r) => r.item_id);
  const ctx = context(profile);
  return byIds(profile, ids).map((r) => serialize(r, ctx));
}
