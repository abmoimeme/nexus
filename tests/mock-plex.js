/**
 * A tiny stand-in for plex.tv, a Plex Media Server and archive.org, used by the tests and for
 * demoing the UI without any real accounts. Media is generated with ffmpeg on first start.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TOKEN = 'mock-plex-token';
const DUR = 6; // seconds

function ensureMedia() {
  const dir = path.join(os.tmpdir(), 'nexus-mock-media');
  const mp4 = path.join(dir, 'clip.mp4');
  if (fs.existsSync(path.join(dir, 'ready'))) return { dir, mp4 };
  fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
  const src = ['-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${DUR}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DUR}`];
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-shortest'];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...src, ...enc, '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...src, ...enc, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'hls', 'seg%d.ts'), path.join(dir, 'hls', 'index.m3u8')]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=200x300:rate=1:duration=1', '-frames:v', '1', path.join(dir, 'poster.png')]);
  fs.writeFileSync(path.join(dir, 'ready'), '1');
  return { dir, mp4 };
}

const MOVIES = [
  { ratingKey: '101', title: 'Neon Harbor', year: 2021, contentRating: 'PG-13', audienceRating: 8.1, genre: ['Sci-Fi', 'Thriller'], container: 'mp4' },
  { ratingKey: '102', title: 'Little Comet', year: 2019, contentRating: 'G', audienceRating: 7.4, genre: ['Animation', 'Family'], container: 'mp4' },
  { ratingKey: '103', title: 'Desert Run (MKV)', year: 2018, contentRating: 'R', audienceRating: 6.9, genre: ['Action'], container: 'mkv' },
];
const SHOW = { ratingKey: '201', title: 'Signal Lost', year: 2022, contentRating: 'TV-14', audienceRating: 8.6, genre: ['Drama', 'Mystery'] };
const SEASONS = [{ ratingKey: '301', index: 1, title: 'Season 1' }];
const EPISODES = [
  { ratingKey: '401', index: 1, title: 'Pilot' },
  { ratingKey: '402', index: 2, title: 'Static' },
];

export function startMock(port = 0) {
  const { dir, mp4 } = ensureMedia();
  const stats = { pinPolls: 0, requests: [] };
  let origin = '';

  const meta = (m, type) => ({
    ratingKey: m.ratingKey, title: m.title, year: m.year, type, summary: `${m.title} — a mock title for testing.`,
    contentRating: m.contentRating, audienceRating: m.audienceRating, duration: DUR * 1000, addedAt: 1700000000,
    thumb: `/library/metadata/${m.ratingKey}/thumb/1`, art: `/library/metadata/${m.ratingKey}/art/1`,
    Genre: (m.genre || []).map((tag) => ({ tag })),
  });

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  };

  function serveFile(req, res, file, type) {
    const size = fs.statSync(file).size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    stats.requests.push(`${req.method} ${p}${u.search}`);

    /* ----- plex.tv ----- */
    if (p === '/api/v2/pins' && req.method === 'POST') return json(res, 201, { id: 7, code: 'MOCKCODE' });
    if (p === '/api/v2/pins/7') {
      stats.pinPolls += 1;
      return json(res, 200, { id: 7, code: 'MOCKCODE', authToken: stats.pinPolls >= 2 ? 'account-token' : null });
    }
    if (p === '/api/v2/resources') {
      return json(res, 200, [{
        name: 'Mock Plex Server', provides: 'server', product: 'Plex Media Server', owned: true, accessToken: TOKEN,
        connections: [
          { uri: 'http://10.255.255.1:32400', local: true, relay: false }, // unreachable LAN address, must be skipped
          { uri: origin, local: false, relay: false },
        ],
      }, { name: 'A Player', provides: 'player', connections: [] }]);
    }

    /* ----- archive.org ----- */
    if (p === '/advancedsearch.php') {
      const q = u.searchParams.get('q') || '';
      const docs = [
        { identifier: 'night_of_the_zombies', title: 'Night of the Zombies', year: '1968', description: '<p>A classic <b>horror</b> film.</p>', subject: ['horror', 'zombie'] },
        { identifier: 'the_last_laugh', title: 'The Last Laugh', year: '1924', description: 'A silent comedy.', subject: 'comedy' },
        { identifier: 'no_mp4_here', title: 'No Playable File', year: '1950', description: '', subject: [] },
      ].filter((d) => !/horror/i.test(q) || d.identifier === 'night_of_the_zombies');
      return json(res, 200, { response: { numFound: docs.length, docs } });
    }
    let m = /^\/metadata\/([\w-]+)$/.exec(p);
    if (m) {
      if (m[1] === 'no_mp4_here') return json(res, 200, { files: [{ name: 'a.ogv', format: 'Ogg Video', size: '10' }] });
      return json(res, 200, { files: [
        { name: 'clip.mp4', format: 'h.264', size: '5000', length: '6.0' },
        { name: 'clip_big.mp4', format: 'h.264', size: '2000000000', length: '6.0' },
        { name: 'clip.ogv', format: 'Ogg Video', size: '4000' },
      ] });
    }
    if (/^\/services\/img\//.test(p)) return serveFile(req, res, path.join(dir, 'poster.png'), 'image/png');
    if (/^\/download\//.test(p)) return serveFile(req, res, mp4, 'video/mp4');

    /* ----- Plex Media Server (token required) ----- */
    const tok = req.headers['x-plex-token'] || u.searchParams.get('X-Plex-Token');
    if (tok !== TOKEN) return json(res, 401, { error: 'unauthorized' });

    if (p === '/') return json(res, 200, { MediaContainer: { friendlyName: 'Mock Plex Server', version: '1.0-mock' } });
    if (p === '/identity') return json(res, 200, { MediaContainer: { machineIdentifier: 'mock-machine' } });
    if (p === '/library/sections') {
      return json(res, 200, { MediaContainer: { Directory: [
        { key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV Shows' }, { key: '3', type: 'artist', title: 'Music' },
      ] } });
    }
    if (p === '/library/sections/1/all' || p === '/library/sections/2/all') {
      const list = p.includes('/1/') ? MOVIES.map((x) => meta(x, 'movie')) : [meta(SHOW, 'show')];
      const start = Number(u.searchParams.get('X-Plex-Container-Start') || 0);
      const size = Number(u.searchParams.get('X-Plex-Container-Size') || 100);
      const page = list.slice(start, start + size);
      return json(res, 200, { MediaContainer: { size: page.length, totalSize: list.length, Metadata: page } });
    }
    m = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (m) {
      const movie = MOVIES.find((x) => x.ratingKey === m[1]);
      const ep = EPISODES.find((x) => x.ratingKey === m[1]);
      const hit = movie || ep;
      if (!hit) return json(res, 404, {});
      const container = movie?.container || 'mp4';
      return json(res, 200, { MediaContainer: { Metadata: [{
        ...meta(hit, movie ? 'movie' : 'episode'),
        Media: [{ container, videoCodec: 'h264', audioCodec: container === 'mkv' ? 'ac3' : 'aac', duration: DUR * 1000,
          Part: [{ key: `/library/parts/${m[1]}/1/file.${container}` }] }],
      }] } });
    }
    m = /^\/library\/metadata\/(\d+)\/children$/.exec(p);
    if (m) {
      if (m[1] === SHOW.ratingKey) return json(res, 200, { MediaContainer: { Metadata: SEASONS.map((s) => ({ ...s, type: 'season' })) } });
      if (m[1] === '301') {
        return json(res, 200, { MediaContainer: { Metadata: EPISODES.map((e) => ({ ...e, type: 'episode', summary: `Episode ${e.index}`, duration: DUR * 1000 })) } });
      }
      return json(res, 404, {});
    }
    if (p === '/photo/:/transcode') return serveFile(req, res, path.join(dir, 'poster.png'), 'image/png');
    if (/^\/library\/parts\/\d+\/\d+\/file\.(mp4|mkv)$/.test(p)) return serveFile(req, res, mp4, 'video/mp4');
    if (p === '/video/:/transcode/universal/start.m3u8') {
      const base = fs.readFileSync(path.join(dir, 'hls', 'index.m3u8'), 'utf8');
      // Plex returns absolute paths on the server; NEXUS must rewrite them to its own proxy.
      return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(
        base.replace(/^(seg\d+\.ts)$/gm, '/video/:/transcode/universal/session/mock/base/$1'),
      );
    }
    m = /^\/video\/:\/transcode\/universal\/session\/mock\/base\/(seg\d+\.ts)$/.exec(p);
    if (m) return serveFile(req, res, path.join(dir, 'hls', m[1]), 'video/MP2T');
    if (p === '/video/:/transcode/universal/stop') { stats.stopped = u.searchParams.get('session'); return json(res, 200, {}); }

    // Anything else exists on a real server (e.g. admin endpoints) and must stay unreachable through NEXUS.
    if (p === '/secret/admin') return json(res, 200, { leaked: true });
    json(res, 404, {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

// `node tests/mock-plex.js` runs it standalone (handy for trying the UI offline).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { origin } = await startMock(Number(process.env.MOCK_PORT) || 32400);
  console.log(`Mock Plex / plex.tv / archive.org on ${origin}   token: ${TOKEN}`);
}
