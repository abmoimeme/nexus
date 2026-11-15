import { get, run, all, setSetting } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { hashSecret } from './crypto.js';
import { loadSource } from './sources/index.js';
import { plexHeaders } from './sources/plex.js';
import { config } from './config.js';

const [cmd, ...args] = process.argv.slice(2);

const help = `NEXUS admin CLI
  npm run cli -- users                          list accounts
  npm run cli -- reset-password <email> <new>   set a new password (min 8 chars) and sign that user out everywhere
  npm run cli -- export-catalog                 write the Plex titles + posters to catalog/ for the public site
  npm run cli -- signup on|off                  allow / close public sign-ups
`;

switch (cmd) {
  case 'users':
    for (const u of all('SELECT email, name, is_admin FROM users ORDER BY id')) {
      console.log(`${u.is_admin ? 'owner' : 'member'}  ${u.email}  (${u.name})`);
    }
    break;
  case 'reset-password': {
    const [email, pw] = args;
    if (!email || !pw || pw.length < 8) { console.error('Usage: reset-password <email> <new password, 8+ chars>'); process.exit(1); }
    const u = get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
    if (!u) { console.error('No such user'); process.exit(1); }
    run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashSecret(pw), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    console.log('Password updated; existing sessions were signed out.');
    break;
  }
  case 'signup':
    if (!['on', 'off'].includes(args[0])) { console.error('Usage: signup on|off'); process.exit(1); }
    setSetting('open_signup', args[0] === 'on' ? '1' : '0');
    console.log(`Public sign-up is now ${args[0]}.`);
    break;
  case 'export-catalog': {
    // Titles, descriptions and artwork only. The public site never gets video: playing happens on this private server.
    const outDir = process.env.EXPORT_DIR || path.join(config.root, 'catalog'); const art = path.join(outDir, 'art');
    fs.mkdirSync(art, { recursive: true });
    const rows = all("SELECT items.* FROM items JOIN sources ON sources.id = items.source_id WHERE sources.type = 'plex' ORDER BY items.added_at DESC");
    if (!rows.length) { console.error('No Plex titles found. Connect Plex in NEXUS and let it finish syncing first.'); process.exit(1); }
    const img = async (row, ref, w, h, name) => {
      if (!ref?.startsWith('plex:')) return null;
      const src = loadSource(row.source_id); const file = `${row.id}-${name}.jpg`;
      const target = `/photo/:/transcode?${new URLSearchParams({ url: ref.slice(5), width: String(w), height: String(h), minSize: '1', upscale: '1' })}`;
      try {
        const r = await fetch(src.cfg.baseUrl + target, { headers: { ...plexHeaders(src.cfg.token), Accept: 'image/*' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return null;
        fs.writeFileSync(path.join(art, file), Buffer.from(await r.arrayBuffer())); return `/art/${file}`;
      } catch { return null; }
    };
    const items = []; let n = 0;
    for (const r of rows) {
      const poster = await img(r, r.poster, 360, 540, 'p'); const backdrop = (await img(r, r.backdrop || r.poster, 1280, 720, 'b')) || poster;
      if (!poster) { console.log(`skipped (no artwork): ${r.title}`); continue; }
      items.push({ id: r.id, kind: r.kind, title: r.title, year: r.year, summary: r.summary || '', genres: JSON.parse(r.genres || '[]'), rating: r.rating,
        contentRating: r.content_rating, durationMin: r.duration_ms ? Math.round(r.duration_ms / 60000) : null, poster, backdrop, addedAt: r.added_at || Date.now(),
        source: 'plex', private: true, ...(r.kind === 'show' ? { seasons: [] } : {}) });
      if (++n % 25 === 0) console.log(`${n}/${rows.length}…`);
    }
    fs.writeFileSync(path.join(outDir, 'plex.json'), JSON.stringify({ items }));
    console.log(`Done: ${items.length} titles written to catalog/plex.json with artwork in catalog/art/.`);
    break;
  }
  default:
    console.log(help);
}
