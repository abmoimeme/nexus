/* NEXUS demo mode: an in-browser stand-in for the server API so the real UI can be tried from a single shared page.
   Sample titles are fictional; every title plays the same short built-in clip. Nothing is saved or sent anywhere. */
(() => {
  const AVATARS = [
    ['🦸', 'linear-gradient(135deg,#1a0533,#4a0070)'], ['🧝', 'linear-gradient(135deg,#001a33,#003d6e)'], ['🧙', 'linear-gradient(135deg,#1a0014,#4a0030)'],
    ['🦊', 'linear-gradient(135deg,#1a0a00,#4d2200)'], ['🐉', 'linear-gradient(135deg,#001a14,#004d35)'], ['🌙', 'linear-gradient(135deg,#00101a,#002d4d)'],
    ['⭐', 'linear-gradient(135deg,#1a1200,#4d3600)'], ['🎭', 'linear-gradient(135deg,#0a1a00,#244d00)'], ['🤖', 'linear-gradient(135deg,#0d0d1c,#2a2a4a)'], ['🎸', 'linear-gradient(135deg,#1a0a0a,#4d1a1a)'],
  ].map(([emoji, bg]) => ({ emoji, bg }));

  const art = (title, hue, w, h) => {
    const words = title.split(' ');
    const lines = words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : words;
    const fs = w > h ? 64 : 34;
    const t = w > h ? '' : lines.map((l, i) => `<text x="${w / 2}" y="${h / 2 + (i - (lines.length - 1) / 2) * fs * 1.15}" text-anchor="middle" font-family="Syne,Arial Black,sans-serif" font-weight="800" font-size="${fs}" fill="#fff" fill-opacity=".92">${l.replace(/&/g, '&amp;')}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},75%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 55) % 360},70%,14%)"/></linearGradient><radialGradient id="r" cx=".75" cy=".2" r=".7"><stop offset="0" stop-color="hsl(${(hue + 30) % 360},90%,62%)" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#r)"/>${t}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  const M = (title, year, cr, rating, min, genres, hue, summary) => ({ kind: 'movie', title, year, cr, rating, min, genres, hue, summary });
  const RAW = [
    M('Teranga Nights', 2024, 'PG-13', 8.4, 118, ['Drama', 'Romance'], 28, 'Two strangers cross paths over one long evening in Dakar, where music, family and an unexpected secret redraw their plans.'),
    M('Neon Harbor', 2021, 'PG-13', 8.1, 104, ['Sci-Fi', 'Thriller'], 190, 'A harbor pilot discovers that the city lights are a signal, and someone is answering it.'),
    M('Little Comet', 2019, 'G', 7.4, 86, ['Animation', 'Family'], 48, 'A curious comet falls in love with the Earth and refuses to burn out before saying goodbye.'),
    M('Baobab Road', 2022, 'PG', 7.9, 97, ['Adventure', 'Family'], 120, 'Three cousins set out on a road trip across Senegal to deliver a mysterious package before the rains.'),
    M('Dakar Drift', 2023, 'PG-13', 7.2, 109, ['Action', 'Thriller'], 8, 'A night-time street race becomes a race against time when the prize is a stolen archive.'),
    M('Desert Run', 2018, 'R', 6.9, 112, ['Action'], 32, 'An ex-courier crosses the Sahara with a cargo nobody will name.'),
    M('The Saltwind', 2020, 'PG', 7.7, 101, ['Drama', 'Adventure'], 205, 'A fishing family faces the biggest decision of their lives when the sea stops giving.'),
    M('Midnight Ledger', 2017, 'R', 7.5, 123, ['Crime', 'Drama'], 270, 'An accountant finds two sets of books and one very dangerous client.'),
    M('Star Merchants', 2022, 'PG', 8.0, 110, ['Sci-Fi', 'Adventure'], 250, 'A crew of traders sails between stations, carrying goods, gossip and a debt that follows them.'),
    M('Grandmother’s Kitchen', 2021, 'G', 8.3, 92, ['Family', 'Documentary'], 18, 'Recipes, rituals and the people who keep a neighbourhood fed.'),
    M('Harmattan Wind', 2016, 'PG-13', 6.8, 99, ['Drama'], 38, 'The dry season brings a family reunion and a long-delayed conversation.'),
    M('Orbit Club', 2023, 'PG', 7.1, 95, ['Animation', 'Comedy'], 300, 'Four kids and a robot start a space club in the school basement.'),
    M('The Last Ferry', 2019, 'PG-13', 7.6, 106, ['Thriller', 'Mystery'], 215, 'Passengers on the last ferry realise one of them is not who they claim to be.'),
    M('Savannah Kings', 2020, 'G', 7.8, 88, ['Animation', 'Adventure'], 85, 'A young lion learns that leadership is mostly listening.'),
  ];
  const SHOWS = [
    { title: 'Signal Lost', year: 2022, cr: 'TV-14', rating: 8.6, genres: ['Drama', 'Mystery'], hue: 175, summary: 'A radio engineer receives broadcasts from a station that closed in 1987.',
      seasons: [['Pilot', 'Static', 'The Tower', 'Night Shift'], ['Return', 'Frequency', 'Dead Air']] },
    { title: 'Kitchen Rivals', year: 2023, cr: 'TV-PG', rating: 7.9, genres: ['Reality', 'Family'], hue: 20, summary: 'Home cooks from across West Africa compete for one title and one very large pot.',
      seasons: [['Opening Night', 'Spice Route', 'Finale']] },
    { title: 'Moon Bakery', year: 2021, cr: 'TV-Y', rating: 8.2, genres: ['Animation', 'Family'], hue: 275, summary: 'A tiny bakery on the moon, and the animals that line up at its door.',
      seasons: [['Sweet Start', 'Rainy Day Bread']] },
  ];

  const now = Date.now();
  const items = [];
  RAW.forEach((m, i) => items.push({ id: i + 1, kind: 'movie', title: m.title, year: m.year, contentRating: m.cr, rating: m.rating, durationMin: m.min, genres: m.genres, hue: m.hue, summary: m.summary, addedAt: now - i * 3600_000 }));
  SHOWS.forEach((s, i) => {
    let ek = 1000 + i * 100;
    items.push({ id: RAW.length + i + 1, kind: 'show', title: s.title, year: s.year, contentRating: s.cr, rating: s.rating, durationMin: null, genres: s.genres, hue: s.hue, summary: s.summary, addedAt: now - (i + RAW.length) * 3600_000,
      seasons: s.seasons.map((eps, si) => ({ key: `s${i}-${si}`, index: si + 1, title: `Season ${si + 1}`, episodes: eps.map((t, ei) => ({ key: String(ek++), index: ei + 1, seasonIndex: si + 1, title: t, summary: `${s.title} — episode ${ei + 1}.`, durationMs: 42 * 60000, thumb: null })) })) });
  });
  items.forEach((it) => { it.poster = art(it.title, it.hue, 360, 540); it.backdrop = art(it.title, it.hue, 1600, 900); it.source = 'demo'; });

  const KIDS_OK = ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'];
  const st = { user: null, profileId: null, profiles: [
    { id: 1, name: 'Guest', avatar: 0, kids: false, pin: null }, { id: 2, name: 'Kids', avatar: 3, kids: true, pin: null } ], nextProfile: 3, progress: {}, list: {} };
  const prof = () => st.profiles.find((p) => p.id === st.profileId);
  const pub = (p) => ({ id: p.id, name: p.name, avatar: p.avatar, emoji: AVATARS[p.avatar].emoji, bg: AVATARS[p.avatar].bg, kids: p.kids, locked: !!p.pin });
  const visible = () => items.filter((i) => !prof()?.kids || KIDS_OK.includes(i.contentRating));
  const prog = (id) => st.progress[`${st.profileId}:${id}`];
  const lst = () => (st.list[st.profileId] ??= []);
  const ser = (it) => {
    const p = prog(it.id);
    const pct = p ? p.positionMs / p.durationMs : 0;
    return { id: it.id, kind: it.kind, title: it.title, year: it.year, summary: it.summary, genres: it.genres, rating: it.rating, contentRating: it.contentRating, durationMin: it.durationMin,
      poster: it.poster, backdrop: it.backdrop, source: 'demo', addedAt: it.addedAt, inList: lst().includes(it.id),
      progress: p && pct >= 0.02 && pct < 0.95 ? { pct, label: p.epLabel, epKey: p.epKey, positionMs: p.positionMs } : null };
  };
  const genreCounts = (arr) => { const m = {}; arr.forEach((i) => i.genres.forEach((g) => { m[g] = (m[g] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([genre, n]) => ({ genre, n })); };

  // 8-second sample clip, embedded at build time.
  const CLIP = URL.createObjectURL(new Blob([Uint8Array.from(atob('__CLIP__'), (c) => c.charCodeAt(0))], { type: 'video/mp4' }));

  const home = () => {
    const vis = visible();
    const rows = [];
    const push = (id, title, list, extra = {}) => { if (list.length) rows.push({ id, title, items: list.map(ser), ...extra }); };
    const cont = vis.filter((i) => { const p = prog(i.id); return p && p.positionMs / p.durationMs >= 0.02 && p.positionMs / p.durationMs < 0.95; })
      .sort((a, b) => prog(b.id).updatedAt - prog(a.id).updatedAt);
    push('continue', 'Continue Watching', cont, { wide: true });
    push('mylist', 'My List', lst().map((id) => vis.find((i) => i.id === id)).filter(Boolean));
    push('recent', 'Recently Added', [...vis].sort((a, b) => b.addedAt - a.addedAt).slice(0, 20));
    push('top', 'Top Rated', [...vis].sort((a, b) => b.rating - a.rating).slice(0, 20));
    push('movies', 'Movies', vis.filter((i) => i.kind === 'movie'));
    push('shows', 'TV Shows', vis.filter((i) => i.kind === 'show'));
    genreCounts(vis).filter((g) => g.n >= 3).slice(0, 4).forEach((g) => push(`genre:${g.genre}`, g.genre, vis.filter((i) => i.genres.includes(g.genre))));
    const hero = [...vis].sort((a, b) => b.rating - a.rating).slice(0, 5);
    return { hero: hero.length ? ser(hero[Math.floor(Date.now() / 86_400_000) % hero.length]) : null, rows, empty: false,
      stats: { movies: vis.filter((i) => i.kind === 'movie').length, shows: vis.filter((i) => i.kind === 'show').length, hours: 0, sources: 1 } };
  };

  const route = (method, path, q, body) => {
    const need = () => { if (!st.user) throw [401, 'Please sign in']; };
    const needP = () => { need(); if (!prof()) throw [409, 'Choose a profile first']; };
    let m;
    if (path === '/api/session') return { user: st.user, profile: prof() ? pub(prof()) : null, setupNeeded: false, signupOpen: true, avatars: AVATARS, maxProfiles: 6 };
    if (path === '/api/auth/login' || path === '/api/auth/register') {
      st.user = { id: 1, name: (body.name || body.email || 'Guest').split('@')[0] || 'Guest', email: body.email || 'guest@demo', isAdmin: false };
      return { ok: true };
    }
    if (path === '/api/auth/logout') { st.user = null; st.profileId = null; return { ok: true }; }
    if (path === '/api/profiles' && method === 'GET') { need(); return { profiles: st.profiles.map(pub) }; }
    if (path === '/api/profiles' && method === 'POST') {
      need(); if (st.profiles.length >= 6) throw [400, 'You can have up to 6 profiles'];
      const p = { id: st.nextProfile++, name: String(body.name || 'Profile').slice(0, 24), avatar: Number(body.avatar) || 0, kids: !!body.kids, pin: body.pin || null };
      st.profiles.push(p); return { profile: pub(p) };
    }
    if ((m = /^\/api\/profiles\/(\d+)\/select$/.exec(path))) {
      need(); const p = st.profiles.find((x) => x.id === +m[1]); if (!p) throw [404, 'Profile not found'];
      if (p.pin && body.pin !== p.pin) throw [401, 'Wrong PIN'];
      st.profileId = p.id; return { profile: pub(p) };
    }
    if ((m = /^\/api\/profiles\/(\d+)$/.exec(path))) {
      need(); const p = st.profiles.find((x) => x.id === +m[1]); if (!p) throw [404, 'Profile not found'];
      if (method === 'DELETE') { if (st.profiles.length <= 1) throw [400, 'You need at least one profile']; st.profiles = st.profiles.filter((x) => x !== p); return { ok: true }; }
      if (body.name !== undefined) p.name = String(body.name).slice(0, 24);
      if (body.avatar !== undefined) p.avatar = Number(body.avatar);
      if (body.kids !== undefined) p.kids = !!body.kids;
      if (body.pin !== undefined) p.pin = body.pin || null;
      return { profile: pub(p) };
    }
    if (path === '/api/profile/leave') { st.profileId = null; return { ok: true }; }
    if (path === '/api/home') { needP(); return home(); }
    if (path === '/api/browse') {
      needP(); let arr = visible();
      if (q.get('kind')) arr = arr.filter((i) => i.kind === q.get('kind'));
      if (q.get('genre')) arr = arr.filter((i) => i.genres.includes(q.get('genre')));
      if (q.get('q')) arr = arr.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q.get('q').toLowerCase()));
      const sort = q.get('sort') || 'recent';
      arr = [...arr].sort({ title: (a, b) => a.title.localeCompare(b.title), rating: (a, b) => b.rating - a.rating, year: (a, b) => b.year - a.year }[sort] || ((a, b) => b.addedAt - a.addedAt));
      const off = +q.get('offset') || 0, lim = +q.get('limit') || 48;
      return { items: arr.slice(off, off + lim).map(ser), hasMore: arr.length > off + lim, genres: genreCounts(visible().filter((i) => !q.get('kind') || i.kind === q.get('kind'))) };
    }
    if (path === '/api/mylist') { needP(); return { items: lst().map((id) => visible().find((i) => i.id === id)).filter(Boolean).map(ser) }; }
    if ((m = /^\/api\/mylist\/(\d+)$/.exec(path))) {
      needP(); const id = +m[1];
      if (method === 'POST') { if (!lst().includes(id)) lst().unshift(id); return { inList: true }; }
      st.list[st.profileId] = lst().filter((x) => x !== id); return { inList: false };
    }
    if ((m = /^\/api\/items\/(\d+)\/play$/.exec(path))) {
      needP(); const it = visible().find((i) => i.id === +m[1]); if (!it) throw [404, 'Title not found'];
      const ep = q.get('ep') || ''; let label = null, title = it.title;
      if (it.kind === 'show') {
        const e = it.seasons.flatMap((s) => s.episodes).find((x) => x.key === ep); if (!e) throw [400, 'Choose an episode'];
        label = `S${e.seasonIndex} · E${e.index}`; title = `${it.title} — ${e.title}`;
      }
      const p = prog(it.id); const resume = p && (p.epKey || '') === ep && p.positionMs / p.durationMs < 0.95 ? Math.min(p.positionMs, 6000) : 0;
      return { type: 'mp4', url: CLIP, mode: 'direct', durationMs: 8000, title, epLabel: label, epKey: ep, startMs: resume };
    }
    if ((m = /^\/api\/items\/(\d+)$/.exec(path))) {
      needP(); const it = visible().find((i) => i.id === +m[1]); if (!it) throw [404, 'Title not found'];
      const out = { item: ser(it), related: visible().filter((x) => x.id !== it.id && x.genres.some((g) => it.genres.includes(g))).slice(0, 12).map(ser) };
      if (it.kind === 'show') {
        out.seasons = it.seasons; out.watched = {};
        const p = prog(it.id); if (p?.epKey) out.watched[p.epKey] = p.positionMs / p.durationMs;
      }
      return out;
    }
    if (path === '/api/progress' && method === 'POST') {
      needP(); st.progress[`${st.profileId}:${body.itemId}`] = { epKey: body.epKey || '', epLabel: body.epLabel || null, positionMs: body.positionMs, durationMs: body.durationMs, updatedAt: Date.now() };
      return { ok: true };
    }
    if ((m = /^\/api\/progress\/(\d+)$/.exec(path)) && method === 'DELETE') { needP(); delete st.progress[`${st.profileId}:${m[1]}`]; return { ok: true }; }
    if (path === '/api/account/password') return { ok: true };
    throw [404, 'Not available in the demo'];
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://demo.local');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* none */ }
    await new Promise((r) => setTimeout(r, 60));
    try {
      const data = route((init.method || 'GET').toUpperCase(), url.pathname, url.searchParams, body);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const [status, error] = Array.isArray(e) ? e : [500, String(e)];
      return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
    }
  };
})();
