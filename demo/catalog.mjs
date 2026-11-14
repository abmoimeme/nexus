// Sample catalog shared by the demo and the Firebase build (fictional titles). Generated from demo/shim.js data.
export const AVATARS = [
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
export const items = [];
RAW.forEach((m, i) => items.push({ id: i + 1, kind: 'movie', title: m.title, year: m.year, contentRating: m.cr, rating: m.rating, durationMin: m.min, genres: m.genres, hue: m.hue, summary: m.summary, addedAt: now - i * 3600_000 }));
SHOWS.forEach((s, i) => {
  let ek = 1000 + i * 100;
  items.push({ id: RAW.length + i + 1, kind: 'show', title: s.title, year: s.year, contentRating: s.cr, rating: s.rating, durationMin: null, genres: s.genres, hue: s.hue, summary: s.summary, addedAt: now - (i + RAW.length) * 3600_000,
    seasons: s.seasons.map((eps, si) => ({ key: `s${i}-${si}`, index: si + 1, title: `Season ${si + 1}`, episodes: eps.map((t, ei) => ({ key: String(ek++), index: ei + 1, seasonIndex: si + 1, title: t, summary: `${s.title} — episode ${ei + 1}.`, durationMs: 42 * 60000, thumb: null })) })) });
});
items.forEach((it) => { it.poster = art(it.title, it.hue, 360, 540); it.backdrop = art(it.title, it.hue, 1600, 900); it.source = 'demo'; });
