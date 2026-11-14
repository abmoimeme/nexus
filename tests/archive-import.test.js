// The Internet Archive importer and the site build, run against the mock archive.org.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMock } from './mock-plex.js';

const root = new URL('..', import.meta.url).pathname;
let mock; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-arch-'));
test.before(async () => { mock = await startMock(); });
test.after(async () => { await mock?.close(); });
// async on purpose: the mock server lives in this process, so a blocking spawn would starve it
const run = (script, env) => promisify(execFile)('node', ['--disable-warning=ExperimentalWarning', path.join(root, script)], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('import writes playable films with stable ids and direct archive.org URLs', async () => {
  const a = path.join(tmp, 'a.json'); const b = path.join(tmp, 'b.json');
  await run('scripts/import-archive.mjs', { ARCHIVE_URL: mock.origin, OUT: a });
  await run('scripts/import-archive.mjs', { ARCHIVE_URL: mock.origin, OUT: b, ARCHIVE_QUERY: 'horror' });
  const A = JSON.parse(fs.readFileSync(a, 'utf8')).items; const B = JSON.parse(fs.readFileSync(b, 'utf8')).items;
  assert.equal(A.length, 2, 'the title with no mp4 is skipped');
  const z = A.find((i) => i.title === 'Night of the Zombies');
  assert.equal(z.streamUrl, `${mock.origin}/download/night_of_the_zombies/clip.mp4`);
  assert.equal(z.poster, `${mock.origin}/services/img/night_of_the_zombies`);
  assert.equal(z.contentRating, null); assert.equal(z.kind, 'movie'); assert.ok(z.genres.includes('Horror'));
  assert.equal(B[0].id, z.id, 'same film keeps the same id across imports');
  assert.equal(new Set(A.map((i) => i.id)).size, A.length);
});

test('a failed import exits non-zero and leaves the catalog file untouched', async () => {
  const f = path.join(tmp, 'keep.json'); fs.writeFileSync(f, '{"items":[1]}');
  await assert.rejects(run('scripts/import-archive.mjs', { ARCHIVE_URL: 'http://127.0.0.1:9', OUT: f, FETCH_TIMEOUT_MS: '500' }));
  assert.equal(fs.readFileSync(f, 'utf8'), '{"items":[1]}');
});
