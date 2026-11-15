# NEXUS on Firebase: one-time setup

NEXUS (the real UI) runs on Firebase Hosting. Accounts are in Firebase Authentication; profiles, watch progress and My List
are in Firestore (locked to each account by `firestore.rules`). The sample-title demo stays available at `/demo.html`.
Until step 1 is done the site automatically shows that demo.

1. **Register a web app** (gives the site its config at `/__/firebase/init.json`):
   `npx firebase-tools apps:create web NEXUS --project nexus-9f372`
2. **Turn on email sign-in:** Firebase console → Build → Authentication → Get started → Email/Password → Enable.
3. **Create Firestore:** `npx firebase-tools firestore:databases:create "(default)" --location nam5 --project nexus-9f372`
   (or console → Build → Firestore Database → Create database → production mode).
4. **Publish the security rules:** `npx firebase-tools deploy --only firestore:rules --project nexus-9f372`
5. **Authorized domains:** Authentication → Settings → Authorized domains should list `nexus-9f372.web.app`.
6. Push to `main` (or run the *Deploy demo to Firebase Hosting* workflow by hand).

## What is and is not in this build
- Titles come from `catalog.json` (sample titles) and play the built-in clip. A catalog entry can carry `streamUrl` (mp4 or m3u8) to play real files.
- Plex, Internet Archive import and the owner admin screens need the Node server (see README); they report "not available" here.
- Kids profiles and PINs are household controls enforced in the app, not a defence against the account owner, who can change them with the account password.

## Owner / admin access
The owner is whoever has a document `admins/{their uid}` in Firestore (no client can create it, so nobody can promote themselves).
1. Create your account in the app (Create account), then copy your **User UID** from Firebase console → Authentication → Users.
2. Firestore Database → Start collection `admins` → Document ID = that UID → add one field, e.g. `role` = `owner` → Save.
3. Reload NEXUS. The "Libraries & sources" page now lists everyone with an account and can email them a password-reset link.
Re-publish the rules after pulling updates: `npx firebase-tools deploy --only firestore:rules --project nexus-9f372`.

## Real films from the Internet Archive
When enabled in the deploy workflow (currently switched off, so the site shows the sample titles), each deploy runs `npm run import:archive`, which pulls ~80 of the most-downloaded free feature films from archive.org into the catalog
(they stream straight from archive.org). If archive.org is unreachable the step is skipped and the previous titles stay. A weekly scheduled run refreshes the list.
- Change the list with `ARCHIVE_QUERY` / `ARCHIVE_LIMIT` (see `scripts/import-archive.mjs`).
- Archive films are unrated, so Kids profiles do not show them.
- The fictional sample titles remain at `/demo.html`.

## Invite-only sign-up

Nobody can create an account without an invite code. A code lives in Firestore as `invites/{CODE}` with fields
`email` (optional, lowercase; if set, only that email can use it), `maxUses` (number) and `uses` (number, starts at 0).

- **From the app (owner):** Libraries & sources -> Invites -> type their email (or leave blank for a shared code) -> Create invite.
  The link (`https://nexus-9f372.web.app/?invite=CODE`) is copied; send it. The code is pre-filled on the sign-up form.
- **By hand (fallback):** Firebase console -> Firestore -> Start collection `invites` -> Document ID like `NX-FAMILY2026`
  (UPPERCASE letters, digits, dashes) with fields `email` (string, may be empty), `maxUses` (number), `uses` (number 0).
- Sign-up uses the code in the same write that creates the account record, and the rules enforce it, so a bad, used-up or
  wrong-email code is refused and the half-made login is deleted.
- Deploy the rules after pulling: `npx firebase-tools deploy --only firestore:rules --project nexus-9f372`.
- An invite proves the email is the one you intended, but NEXUS does not verify the person owns it (no confirmation email yet).
