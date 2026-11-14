import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const trimSlash = (s) => s.replace(/\/+$/, '');

export const config = {
  root,
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  publicDir: path.join(root, 'public'),
  // Set TRUST_PROXY=1 when running behind a reverse proxy / tunnel that sets X-Forwarded-* headers.
  trustProxy: env.TRUST_PROXY === '1',
  cookieSecure: env.COOKIE_SECURE === '1',
  // Optional. If unset, a random key is generated into DATA_DIR/secret.key on first run.
  secret: env.NEXUS_SECRET || '',
  plexTvUrl: trimSlash(env.PLEX_TV_URL || 'https://clients.plex.tv'),
  archiveUrl: trimSlash(env.ARCHIVE_URL || 'https://archive.org'),
  sessionDays: 30,
  fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS || 15000),
  // Automatic library re-sync interval in hours (0 disables).
  syncHours: Number(env.SYNC_HOURS ?? 6),
};
