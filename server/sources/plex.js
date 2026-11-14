import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { HttpError, describeFetchError, mapLimit } from '../http.js';

/* ---------- Identity & low-level requests ---------- */

/** Stable per-installation id so Plex shows one "NEXUS" device instead of many. */
export function clientId() {
  let id = getSetting('plex_client_id');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('plex_client_id', id);
  }
  return id;
}

export function plexHeaders(token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Product': 'NEXUS',
    'X-Plex-Version': '1.0',
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Web',
    'X-Plex-Device-Name': 'NEXUS',
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

export function normalizeOrigin(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`); } catch { throw new HttpError(400, 'Enter a valid server address, e.g. http://192.168.1.20:32400'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Server address must start with http:// or https://');
  return u.origin;
}

export async function plexGet(baseUrl, token, path, params = {}) {
  const u = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(u, {
      headers: plexHeaders(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
  } catch (e) {
    throw new HttpError(502, describeFetchError(e, baseUrl));
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Plex rejected the access token. Reconnect the server.');
  if (!res.ok) throw new HttpError(502, `Plex answered HTTP ${res.status} for ${path}`);
  return res.json();
}

/* ---------- Connecting ---------- */

/** Verify a server address + token and list its libraries. */
export async function testConnection(baseUrl, token) {
  const origin = normalizeOrigin(baseUrl);
  const root = (await plexGet(origin, token, '/')).MediaContainer || {};
  const secs = (await plexGet(origin, token, '/library/sections')).MediaContainer?.Directory || [];
  return {
    origin,
    name: root.friendlyName || new URL(origin).host,
    version: root.version || null,
    sections: secs.map((s) => ({ key: String(s.key), title: s.title, type: s.type })),
  };
}

const TV_TIMEOUT = () => AbortSignal.timeout(config.fetchTimeoutMs);

/** plex.tv "Sign in with Plex": start a PIN the user approves in their browser. */
export async function createPin() {
  let res;
  try {
    res = await fetch(`${config.plexTvUrl}/api/v2/pins?strong=true`, { method: 'POST', headers: plexHeaders(), signal: TV_TIMEOUT() });
  } catch (e) {
    throw new HttpError(502, describeFetchError(e, config.plexTvUrl));
  }
  if (!res.ok) throw new HttpError(502, `plex.tv answered HTTP ${res.status}`);
  const j = await res.json();
  const authUrl = 'https://app.plex.tv/auth#?' + new URLSearchParams({
    clientID: clientId(),
    code: j.code,
    'context[device][product]': 'NEXUS',
  });
  return { id: j.id, code: j.code, authUrl };
}

/** Returns the account token once the user has approved the PIN, otherwise null. */
export async function checkPin(id, code) {
  let res;
  try {
    res = await fetch(`${config.plexTvUrl}/api/v2/pins/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { headers: plexHeaders(), signal: TV_TIMEOUT() });
  } catch (e) {
    throw new HttpError(502, describeFetchError(e, config.plexTvUrl));
  }
  if (res.status === 404) throw new HttpError(410, 'That sign-in request expired. Start again.');
  if (!res.ok) throw new HttpError(502, `plex.tv answered HTTP ${res.status}`);
  const j = await res.json();
  return j.authToken || null;
}

/** Every Plex server the account owns or has been shared. */
export async function listServers(accountToken) {
  let res;
  try {
    res = await fetch(`${config.plexTvUrl}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=0`, { headers: plexHeaders(accountToken), signal: TV_TIMEOUT() });
  } catch (e) {
    throw new HttpError(502, describeFetchError(e, config.plexTvUrl));
  }
  if (!res.ok) throw new HttpError(502, `plex.tv answered HTTP ${res.status}`);
  const list = await res.json();
  return (Array.isArray(list) ? list : [])
    .filter((r) => String(r.provides || '').split(',').includes('server'))
    .map((r) => ({
      name: r.name,
      owned: !!r.owned,
      product: r.product || 'Plex Media Server',
      // Shared servers need their own access token; owned ones also provide one.
      accessToken: r.accessToken || accountToken,
      connections: (r.connections || []).map((c) => ({ uri: c.uri, local: !!c.local, relay: !!c.relay })),
    }));
}

/**
 * Choose the connection NEXUS itself can reach (which depends on where NEXUS runs):
 * LAN address first, then direct remote, then Plex relay (slowest).
 */
export async function pickConnection(server) {
  const ranked = [...server.connections].sort(
    (a, b) => (a.relay - b.relay) || (b.local - a.local),
  );
  const results = await Promise.all(ranked.map(async (c) => {
    try {
      const j = await plexGet(c.uri.replace(/\/$/, ''), server.accessToken, '/identity');
      return j.MediaContainer?.machineIdentifier ? c : null;
    } catch { return null; }
  }));
  return results.find(Boolean) || null;
}

/* ---------- Library ---------- */

const num = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
const normRating = (r) => (r ? String(r).replace(/^[a-z]{2}\//i, '').trim().toUpperCase() : null);

function normalize(m, kind) {
  return {
    ext_id: String(m.ratingKey),
    kind,
    title: String(m.title || 'Untitled'),
    year: num(m.year),
    summary: m.summary || '',
    genres: (m.Genre || []).map((g) => g.tag).filter(Boolean).slice(0, 6),
    rating: num(m.audienceRating ?? m.rating),
    content_rating: normRating(m.contentRating),
    duration_ms: num(m.duration),
    poster: m.thumb ? `plex:${m.thumb}` : null,
    backdrop: m.art ? `plex:${m.art}` : m.thumb ? `plex:${m.thumb}` : null,
    added_at: m.addedAt ? m.addedAt * 1000 : Date.now(),
    play_ref: { ratingKey: String(m.ratingKey) },
  };
}

export async function fetchLibrary(source) {
  const { baseUrl, token, sections } = source.cfg;
  const secs = (await plexGet(baseUrl, token, '/library/sections')).MediaContainer?.Directory || [];
  const wanted = secs.filter(
    (s) => (s.type === 'movie' || s.type === 'show') && (!sections?.length || sections.includes(String(s.key))),
  );
  const out = new Map();
  for (const s of wanted) {
    let start = 0;
    let total = Infinity;
    while (start < total) {
      const mc = (await plexGet(baseUrl, token, `/library/sections/${s.key}/all`, {
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': 200,
      })).MediaContainer || {};
      total = mc.totalSize ?? mc.size ?? 0;
      const meta = mc.Metadata || [];
      for (const m of meta) out.set(String(m.ratingKey), normalize(m, s.type));
      if (!meta.length) break;
      start += meta.length;
    }
  }
  return [...out.values()];
}

const KEY_RE = /^\d+$/;
export function assertKey(key) {
  if (!KEY_RE.test(String(key))) throw new HttpError(400, 'Bad media id');
  return String(key);
}

/** Fresh playback details for one movie or episode. */
export async function getMedia(source, ratingKey) {
  const { baseUrl, token } = source.cfg;
  const mc = (await plexGet(baseUrl, token, `/library/metadata/${assertKey(ratingKey)}`)).MediaContainer || {};
  const m = mc.Metadata?.[0];
  if (!m) throw new HttpError(404, 'Not found on the Plex server');
  const media = m.Media?.[0];
  const part = media?.Part?.[0];
  if (!part?.key) throw new HttpError(404, 'This title has no playable media file');
  return {
    title: m.title,
    type: m.type,
    durationMs: num(media.duration ?? m.duration),
    container: String(media.container || '').toLowerCase(),
    videoCodec: String(media.videoCodec || '').toLowerCase(),
    audioCodec: String(media.audioCodec || '').toLowerCase(),
    partKey: part.key,
    seasonIndex: num(m.parentIndex),
    episodeIndex: num(m.index),
  };
}

export async function getEpisodes(source, showKey) {
  const { baseUrl, token } = source.cfg;
  const seasons = ((await plexGet(baseUrl, token, `/library/metadata/${assertKey(showKey)}/children`)).MediaContainer?.Metadata || [])
    .filter((s) => s.type === 'season')
    .slice(0, 60);
  const out = await mapLimit(seasons, 6, async (s) => {
    const eps = (await plexGet(baseUrl, token, `/library/metadata/${assertKey(s.ratingKey)}/children`)).MediaContainer?.Metadata || [];
    return {
      key: String(s.ratingKey),
      index: num(s.index) ?? 0,
      title: s.title,
      episodes: eps
        .filter((e) => e.type === 'episode')
        .map((e) => ({
          key: String(e.ratingKey),
          index: num(e.index) ?? 0,
          seasonIndex: num(s.index) ?? 0,
          title: e.title,
          summary: e.summary || '',
          durationMs: num(e.duration),
          thumb: e.thumb ? `plex:${e.thumb}` : null,
        })),
    };
  });
  return out.filter((s) => s.episodes.length).sort((a, b) => a.index - b.index);
}

/** Path (on the Plex server) that starts an HLS transcode/remux session for the browser. */
export function transcodePath(ratingKey, { kbps, session }) {
  const p = new URLSearchParams({
    hasMDE: '1',
    path: `/library/metadata/${assertKey(ratingKey)}`,
    mediaIndex: '0',
    partIndex: '0',
    protocol: 'hls',
    fastSeek: '1',
    directPlay: '0',
    directStream: '1',
    subtitleSize: '100',
    audioBoost: '100',
    location: 'wan',
    session,
    'X-Plex-Session-Identifier': session,
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Product': 'NEXUS',
    'X-Plex-Version': '1.0',
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Device': 'Web',
    'X-Plex-Device-Name': 'NEXUS',
  });
  if (kbps) p.set('maxVideoBitrate', String(kbps));
  return `/video/:/transcode/universal/start.m3u8?${p}`;
}

export async function stopTranscode(source, session) {
  try {
    await plexGet(source.cfg.baseUrl, source.cfg.token, '/video/:/transcode/universal/stop', { session });
  } catch { /* best effort — Plex also reaps idle sessions */ }
}
