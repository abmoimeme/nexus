# NEXUS on GitHub + Firebase

## What goes where

| Piece | Home | Why |
|---|---|---|
| Source code, CI | **GitHub** | `npm test` runs on every push (`.github/workflows/ci.yml`). |
| Public demo (sample titles) | **Firebase Hosting** | Free permanent URL like `your-project.web.app`; deployed from GitHub on push. |
| Real app (Plex streaming, accounts) | **Cloud Run** *(or a home machine + tunnel)* | NEXUS needs a running Node process and a database; Firebase Hosting alone is static. |

## Step 1 — GitHub
```bash
cd nexus
git remote add origin https://github.com/<you>/nexus.git
git push -u origin main
```

## Step 2 — Firebase demo link (free, permanent)
1. Create (or reuse) a Firebase project; note its **project ID**.
2. Replace `YOUR_FIREBASE_PROJECT_ID` in `.firebaserc` and `.github/workflows/deploy-demo.yml`.
3. Run `firebase init hosting:github` once (choose this repo, keep `hosting` as the public folder, do not overwrite files). It stores the deploy secret in GitHub.
4. Push to `main` → the demo is live at `https://<project-id>.web.app`.

Local preview: `npm run build:demo && npx firebase-tools emulators:start --only hosting`.

## Step 3 — the real app online (decide first)

Things Firebase changes about the design:

* **Persistence.** NEXUS stores accounts and watch history in SQLite on disk. Cloud Run's disk is wiped when the container restarts, and SQLite should not live on a network bucket. Either keep NEXUS on a machine with a real disk (home server + tunnel, or a small VM), or move accounts/profiles/progress to **Firestore** (and optionally Firebase Auth). That is a contained change to `server/db.js`, `auth.js` and `library.js`.
* **Reaching Plex.** A server in Google's cloud cannot see `192.168.x.x`. Plex Remote Access (or Tailscale) must be on.
* **Video traffic.** NEXUS relays Plex video through itself. On Cloud Run that is billed bandwidth and request time, so heavy use gets expensive. Home hosting costs nothing extra.

Recommended path: **demo on Firebase Hosting now; real app on the home server with the Cloudflare share link** until you know how many people will stream, then decide between Cloud Run + Firestore or a VM.
