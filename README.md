# NEXUS — a premium streaming front-end for Plex and online sources

NEXUS gives your media a Netflix/Hulu-style experience: accounts, up to 6 profiles per account (Kids profiles and PIN locks),
a curated home page, Continue Watching, My List, search, a custom player, and library sources you manage from the UI.

**Sources:** Plex servers (local or remote), Internet Archive public-domain films, and single video links (MP4 / WebM / HLS).
It is one small Node.js app (no npm dependencies, SQLite built in) that you run once and open from any browser.

## Run it

```bash
# Requires Node 22.13+ (or use Docker below)
npm start                 # http://localhost:8080
# or
docker compose up -d --build
```

First visit: create the owner account → pick a profile → **Connect Plex** or **Add public-domain classics**.
The first account is the owner; sign-ups then close (Libraries & sources → Access lets you open them temporarily).

## Adding media

| Source | How | Notes |
|---|---|---|
| Plex (sign-in) | Sources → Plex → *Sign in with Plex* | Lists every server on your account. NEXUS picks the address *it* can reach: LAN → direct remote → Plex relay. |
| Plex (address) | Sources → Plex → server address + token | e.g. `http://192.168.1.20:32400`. Token: Plex Web → any item → Get Info → View XML → `X-Plex-Token` in the URL. |
| Internet Archive | Sources → Internet Archive | Public-domain features. Plays from archive.org directly. |
| Video link | Sources → Video link | Any MP4/WebM/HLS URL you have rights to. Other-domain links need CORS. |

Plex libraries re-sync every 6 hours (`SYNC_HOURS`) and on demand. Removing a source never touches your files.
Direct-play MP4/H.264/AAC where possible; anything else (MKV, HEVC, AC3…) is remuxed/transcoded by Plex to HLS. A quality menu in the player lets viewers cap bitrate.

## Get a test link for users (2 minutes)

```bash
TRUST_PROXY=true docker compose --profile share up -d --build
docker compose logs tunnel | grep trycloudflare.com      # your public https:// link
```

1. Open the link, create the owner account, then **Libraries & sources → Connect Plex** (or add classics).
2. For testers: **Access → Allow others to create accounts**, send the link, then switch sign-ups off.
3. Stop sharing any time with `docker compose --profile share down`.

This link is temporary (it changes each time the tunnel restarts) and only works while your computer and Docker are running.
For a permanent address use a named Cloudflare Tunnel or a small VPS (next section).
A static look-and-feel demo with sample titles (no server needed) is built with `node scripts/build-demo.mjs`.

## Putting it online

NEXUS streams Plex through itself, so **where NEXUS runs decides which Plex address it can use**.

1. **Home server + secure tunnel (recommended to start, ~$0).** Run NEXUS on the same machine/LAN as Plex.
   Expose only NEXUS with a Cloudflare Tunnel or Tailscale Funnel (HTTPS, no open router ports). Set `TRUST_PROXY=true`.
   Plex is reached over the LAN, so streams are fast and Plex never has to be public.
2. **Cloud VPS (Hetzner, DigitalOcean, Fly.io…).** `docker compose up -d`, put Caddy/nginx in front for HTTPS, set `TRUST_PROXY=true`.
   NEXUS must reach Plex over the internet: enable Plex *Remote Access* or join both machines to a Tailscale network and use the Tailscale address
   (Plex relay connections are bandwidth-capped by Plex). Your home upload speed limits how many people stream at once.

Back up the `data/` folder (SQLite database + encryption key). Keep `NEXUS_SECRET` or `data/secret.key` private: it protects stored Plex tokens.

## Settings (environment variables)

`PORT` (8080) · `HOST` · `DATA_DIR` · `TRUST_PROXY` · `COOKIE_SECURE` · `NEXUS_SECRET` · `SYNC_HOURS` · `FETCH_TIMEOUT_MS`

## Everyday help for viewers

Built in, so household members rarely need the owner: a **Help & Troubleshooting** page and **Copy support info** in the profile menu, a recovery card in the
player (lower quality / retry / copy error info), **Change password** for everyone, and **Reset password** for the owner under Libraries & sources → Access.
Changing a profile's PIN or Kids setting requires the account password, so a child can't unlock an adult profile from "Manage profiles".

## Admin CLI (fallback)

```bash
npm run cli -- users
npm run cli -- reset-password you@example.com "new password"
npm run cli -- signup on|off
```

## Security model

scrypt-hashed passwords and PINs · HttpOnly/SameSite sessions (Secure over HTTPS) · login and PIN rate limiting · Origin checks on writes ·
strict CSP (no inline scripts) · Plex tokens encrypted at rest (AES-256-GCM) and never sent to browsers · the media proxy only allows
Plex stream/artwork paths (no admin or arbitrary endpoints) · Kids profiles are enforced on the server.

## Tests

`npm test` runs 27 end-to-end tests against a mock Plex / plex.tv / archive.org (`tests/mock-plex.js`, needs `ffmpeg`).
Try the UI offline: `node tests/mock-plex.js` then add `http://127.0.0.1:32400` with token `mock-plex-token`.

## Legal

Use NEXUS only with media you own or are licensed to stream. Sharing a Plex library with people outside your household
may conflict with Plex's terms; check them before opening access widely.
