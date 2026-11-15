// `npm run cli -- export-catalog`: writes Plex titles + artwork for the public site, never any stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exp-'));
const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), EXPORT_DIR: path.join(tmp, 'catalog'), NEXUS_SECRET: 'x'.repeat(40) };
const run = (code) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: root, env });

test('export-catalog writes titles and posters, with no play links', async () => {
  const plex = http.createServer((req, res) => {
    if (req.url.startsWith('/photo/:/transcode') && req.url.includes('thumb1')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => plex.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${plex.address().port}`;
    await run(`
      const { createSource } = await import('./server/sources/index.js'); const { run } = await import('./server/db.js');
      const id = createSource('plex', 'Mike', { baseUrl: '${base}', token: 'tok' });
      run("INSERT INTO items(source_id, ext_id, kind, title, year, summary, genres, content_rating, poster, added_at, play_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, '1', 'movie', 'Heat', 1995, 'Cops and robbers', '["Crime"]', 'R', 'plex:/library/metadata/1/thumb1', 5, '{"ratingKey":"1"}');
      run("INSERT INTO items(source_id, ext_id, kind, title, genres, poster, added_at, play_ref) VALUES (?,?,?,?,?,?,?,?)", id, '2', 'movie', 'No Art', '[]', 'plex:/library/metadata/2/none', 4, '{}');`);
    const out = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/cli.js', 'export-catalog'], { cwd: root, env });
    assert.match(out.stdout, /Done: 1 titles/); assert.match(out.stdout, /skipped \(no artwork\): No Art/);
    const { items } = JSON.parse(fs.readFileSync(path.join(tmp, 'catalog/plex.json'), 'utf8'));
    assert.equal(items.length, 1); assert.equal(items[0].title, 'Heat'); assert.equal(items[0].private, true); assert.deepEqual(items[0].genres, ['Crime']);
    assert.equal(items[0].poster, `/art/${items[0].id}-p.jpg`); assert.ok(fs.existsSync(path.join(tmp, `catalog/art/${items[0].id}-p.jpg`)));
    assert.equal(JSON.stringify(items).includes('ratingKey'), false); assert.equal(JSON.stringify(items).includes('tok'), false);
  } finally { plex.close(); }
});
