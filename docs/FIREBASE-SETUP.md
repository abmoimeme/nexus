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
