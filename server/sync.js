import { all, get, run, tx } from './db.js';
import { config } from './config.js';
import { loadSource } from './sources/index.js';
import { HttpError } from './http.js';
import * as plex from './sources/plex.js';
import * as archive from './sources/archive.js';

const adapters = { plex, archive };
const running = new Set();

export const isSyncing = (id) => running.has(id);

const UPSERT = `
INSERT INTO items(source_id, ext_id, kind, title, year, summary, genres, rating, content_rating,
                  duration_ms, poster, backdrop, added_at, play_ref)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(source_id, ext_id) DO UPDATE SET
  kind = excluded.kind, title = excluded.title, year = excluded.year, summary = excluded.summary,
  genres = excluded.genres, rating = excluded.rating, content_rating = excluded.content_rating,
  duration_ms = excluded.duration_ms, poster = excluded.poster, backdrop = excluded.backdrop,
  added_at = excluded.added_at, play_ref = excluded.play_ref`;

function apply(sourceId, items) {
  return tx(() => {
    const seen = new Set();
    for (const it of items) {
      run(
        UPSERT,
        sourceId, it.ext_id, it.kind, it.title, it.year ?? null, it.summary ?? '',
        JSON.stringify(it.genres ?? []), it.rating ?? null, it.content_rating ?? null,
        it.duration_ms ?? null, it.poster ?? null, it.backdrop ?? null,
        it.added_at ?? Date.now(), JSON.stringify(it.play_ref ?? {}),
      );
      seen.add(it.ext_id);
    }
    // Titles removed upstream disappear here too (their progress / My List entries cascade away).
    for (const row of all('SELECT id, ext_id FROM items WHERE source_id = ?', sourceId)) {
      if (!seen.has(row.ext_id)) run('DELETE FROM items WHERE id = ?', row.id);
    }
    return get('SELECT COUNT(*) AS n FROM items WHERE source_id = ?', sourceId).n;
  });
}

export async function syncSource(id) {
  const source = loadSource(id);
  if (!source) throw new HttpError(404, 'Source not found');
  const adapter = adapters[source.type];
  if (!adapter) throw new HttpError(400, 'This source type does not sync');
  if (running.has(id)) throw new HttpError(409, 'A sync is already running for this source');

  running.add(id);
  run(`UPDATE sources SET status = 'syncing', last_error = NULL WHERE id = ?`, id);
  try {
    const items = await adapter.fetchLibrary(source);
    const existing = get('SELECT COUNT(*) AS n FROM items WHERE source_id = ?', id).n;
    if (!items.length && existing > 0) {
      throw new Error('The source returned no titles, so the existing library was kept.');
    }
    const count = apply(id, items);
    run(`UPDATE sources SET status = 'ok', last_error = NULL, last_sync = ?, item_count = ? WHERE id = ?`, Date.now(), count, id);
    return count;
  } catch (e) {
    run(`UPDATE sources SET status = 'error', last_error = ? WHERE id = ?`, String(e.message || e).slice(0, 400), id);
    throw e;
  } finally {
    running.delete(id);
  }
}

export function syncInBackground(id) {
  syncSource(id).catch((e) => console.error(`[sync] source ${id} failed: ${e.message}`));
}

/** Periodically refresh Plex/Archive sources so new additions show up on their own. */
export function startScheduler() {
  if (!config.syncHours) return;
  setInterval(() => {
    for (const s of all(`SELECT id FROM sources WHERE type IN ('plex','archive') AND status != 'syncing'`)) {
      syncInBackground(s.id);
    }
  }, config.syncHours * 3_600_000).unref();
}
