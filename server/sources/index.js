import { all, get, run } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

/** A "source" is a place media comes from: a Plex server, an Internet Archive import, or manual links. */

function hydrate(row) {
  if (!row) return null;
  const c = JSON.parse(row.config || '{}');
  const cfg = { ...c };
  if (c.tokenEnc) {
    try { cfg.token = decrypt(c.tokenEnc); } catch { cfg.token = null; }
  }
  delete cfg.tokenEnc;
  return { ...row, cfg };
}

export const loadSource = (id) => hydrate(get('SELECT * FROM sources WHERE id = ?', id));
export const listSources = () => all('SELECT * FROM sources ORDER BY id').map(hydrate);

export function createSource(type, name, cfg = {}) {
  const c = { ...cfg };
  if (c.token) {
    c.tokenEnc = encrypt(c.token);
    delete c.token;
  }
  const r = run(
    'INSERT INTO sources(type, name, config, status, created_at) VALUES (?,?,?,?,?)',
    type, name, JSON.stringify(c), 'new', Date.now(),
  );
  return Number(r.lastInsertRowid);
}

export function deleteSource(id) {
  run('DELETE FROM sources WHERE id = ?', id);
}

export function publicSource(s) {
  let host = null;
  if (s.cfg.baseUrl) {
    try { host = new URL(s.cfg.baseUrl).host; } catch { /* ignore */ }
  }
  return {
    id: s.id,
    type: s.type,
    name: s.name,
    status: s.status,
    lastError: s.last_error,
    lastSync: s.last_sync,
    itemCount: s.item_count,
    host,
    via: s.cfg.via || null,
    syncable: s.type !== 'direct',
  };
}

/** The single manual-links source, created on first use. */
export function ensureDirectSource() {
  const existing = get(`SELECT id FROM sources WHERE type = 'direct' LIMIT 1`);
  if (existing) return existing.id;
  const id = createSource('direct', 'Direct links');
  run(`UPDATE sources SET status = 'ok' WHERE id = ?`, id);
  return id;
}
