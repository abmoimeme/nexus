import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { plexHeaders } from './sources/plex.js';
import { HttpError } from './http.js';

/**
 * Streams media and artwork from a Plex server through NEXUS.
 *
 *  - The Plex token never reaches the browser.
 *  - Works from an https:// page even when Plex is plain http://.
 *  - Only an allow-list of Plex paths can be requested, so a signed-in viewer cannot use
 *    NEXUS to read anything else on the media server with the owner's token.
 */

const STREAM_PREFIXES = ['/library/parts/', '/video/:/transcode/universal/'];
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

/** Normalizes dot-segments (so "/library/parts/../x" cannot escape) and enforces the allow-list. */
function safeUpstreamPath(raw, prefixes) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 4096) {
    throw new HttpError(400, 'Bad path');
  }
  let u;
  try { u = new URL(raw, 'http://upstream.invalid'); } catch { throw new HttpError(400, 'Bad path'); }
  if (u.host !== 'upstream.invalid') throw new HttpError(400, 'Bad path');
  if (!prefixes.some((p) => u.pathname.startsWith(p))) throw new HttpError(403, 'Path not allowed');
  u.searchParams.delete('X-Plex-Token');
  return u.pathname + u.search;
}

function rewritePlaylist(text, upstreamPath, sourceId, baseUrl) {
  const here = new URL(upstreamPath, 'http://upstream.invalid');
  const realOrigin = new URL(baseUrl).origin;
  const toProxy = (ref) => {
    let u;
    try { u = new URL(ref, here); } catch { return ref; }
    const sameServer = u.origin === 'http://upstream.invalid' || u.origin === realOrigin;
    if (!sameServer) return ref;
    return `/api/sources/${sourceId}/proxy?u=${encodeURIComponent(u.pathname + u.search)}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, r) => `URI="${toProxy(r)}"`);
      return toProxy(line.trim());
    })
    .join('\n');
}

async function upstreamFetch(req, res, source, target, extraHeaders = {}) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { ...plexHeaders(source.cfg.token), Accept: '*/*', 'Accept-Encoding': 'identity', ...extraHeaders };
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    return await fetch(source.cfg.baseUrl + target, { headers, redirect: 'manual', signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return null; // viewer went away
    throw new HttpError(502, 'Could not reach the media server');
  }
}

export async function proxyStream(req, res, source, rawPath) {
  const target = safeUpstreamPath(rawPath, STREAM_PREFIXES);
  const up = await upstreamFetch(req, res, source, target);
  if (!up) return;
  if (up.status === 404) throw new HttpError(404, 'Not found on the media server');
  if (up.status >= 300 && up.status !== 304 && up.status !== 206) throw new HttpError(502, `Media server answered HTTP ${up.status}`);

  const type = up.headers.get('content-type') || '';
  if (/mpegurl/i.test(type) || /\.m3u8$/i.test(target.split('?')[0])) {
    const text = await up.text();
    if (text.length > MAX_PLAYLIST_BYTES) throw new HttpError(502, 'Playlist too large');
    const body = rewritePlaylist(text, target, source.id, source.cfg.baseUrl);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  const headers = { 'Cache-Control': 'private, no-store' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(k);
    if (v) headers[k] = v;
  }
  res.writeHead(up.status, headers);
  if (req.method === 'HEAD' || !up.body) { res.end(); return; }
  try { await pipeline(Readable.fromWeb(up.body), res); } catch { /* client disconnected mid-stream */ }
}

export async function proxyImage(req, res, source, path, width, height) {
  if (typeof path !== 'string' || !path.startsWith('/library/')) throw new HttpError(400, 'Bad image path');
  const clean = safeUpstreamPath(path, ['/library/']);
  const w = Math.min(Math.max(parseInt(width, 10) || 360, 40), 2000);
  const h = Math.min(Math.max(parseInt(height, 10) || 540, 40), 2000);
  const target = `/photo/:/transcode?${new URLSearchParams({ url: clean, width: String(w), height: String(h), minSize: '1', upscale: '1' })}`;

  const up = await upstreamFetch(req, res, source, target);
  if (!up) return;
  const type = up.headers.get('content-type') || '';
  if (!up.ok || !/^image\//i.test(type)) throw new HttpError(up.status === 404 ? 404 : 502, 'Artwork unavailable');
  const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' };
  const len = up.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  res.writeHead(200, headers);
  if (req.method === 'HEAD' || !up.body) { res.end(); return; }
  try { await pipeline(Readable.fromWeb(up.body), res); } catch { /* client disconnected */ }
}
