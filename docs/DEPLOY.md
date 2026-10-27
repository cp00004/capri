# Deploy Capri worldwide

GitHub Pages only hosts the static UI. To make Capri work for anyone, anywhere, you must host the Node server (`server.js`) on a public HTTPS endpoint. The app (web or APK) then points to that endpoint.

## 1. Host the backend

Pick any Node-capable host that supports HTTPS and WebSockets-friendly HTTP:

- **Render** (free tier): New Web Service → connect your GitHub repo → build command `npm install`, start command `node server.js`, add env vars.
- **Railway**: New Project → Deploy from GitHub → add env vars.
- **Fly.io**: `fly launch` then `fly secrets set ...`.
- **VPS (DigitalOcean/Hetzner)**: clone repo, `npm install`, run with pm2 or systemd behind nginx + Let's Encrypt.

Required env vars on the host:
```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AQ...
CAPRI_CHAT_PROVIDER=groq
GOOGLE_CLIENT_ID=your-web-oauth-client-id.apps.googleusercontent.com
CAPRI_AUTOPUBLISH=0
PORT=4173
CAPRI_ALLOW_ORIGINS=https://cp00004.github.io,https://your-app-origin
```

Set `CAPRI_AUTOPUBLISH=0` on hosted environments (no git push from a container).

## 2. Set up Google Sign-In (OAuth)

1. Go to https://console.cloud.google.com/ → APIs & Services → Credentials.
2. Create an OAuth 2.0 Client ID → Application type: **Web application**.
3. Authorized JavaScript origins: add your GitHub Pages URL (`https://cp00004.github.io`) and your hosted backend URL.
4. Authorized redirect URIs: leave empty (GIS uses popup).
5. Copy the Client ID (ends in `.apps.googleusercontent.com`).
6. Paste it as `GOOGLE_CLIENT_ID` in your backend `.env` and restart.

## 3. Point the app at the backend

In the app (web or APK): Settings → **PC address / backend** → paste your hosted URL (e.g. `https://capri.yourdomain.com`). Tap SAVE. The app reloads and connects.

## 4. Mobile app (APK)

The Capacitor Android project is in `android/`. To build:
```
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```
APK output: `android/app/build/outputs/apk/debug/app-debug.apk`

Install on any Android device. In Settings, set the backend URL. Sign in with Google — memory, preferences and history sync per Gmail account across devices.

## Notes

- The backend holds all secret keys. The APK and GitHub Pages never contain keys.
- PC control tools (`run_shell`, etc.) only work when the backend runs on a PC with those tools available. On a cloud host, those tools run on the host machine.
- For true PC control from a phone, host the backend on the PC itself and expose it via a tunnel (Cloudflare Tunnel, Tailscale) instead of a cloud host.