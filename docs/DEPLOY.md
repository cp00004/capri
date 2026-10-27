# Online deployment

GitHub Pages hosts only the UI. The included deployment uses a Node service on Render and a Cloudflare Worker as its API gateway. Both run online; neither needs your PC to stay on. The Render origin is kept in Worker secrets, while the Worker URL is necessarily public because the app calls it.

The cloud backend does not control your home PC. This deployment disables PC tools, and Capri's shell, screen, and file tools are Windows-specific. Use the local server and a tunnel only when you want phone-to-home-PC control.

Render's Starter service and persistent disk are paid resources. Review current pricing in Render before creating the service. The disk keeps profiles, device pairings, settings, and audit logs across restarts.

## 1. Deploy the backend

1. In Render, create a Blueprint from this repository and select `render.yaml`.
2. Set the prompted `GROQ_API_KEY`, `GEMINI_API_KEY`, and `CAPRI_PROXY_TOKEN` values in Render. Generate a long random value for `CAPRI_PROXY_TOKEN`; do not commit it.
3. Wait for the service to deploy and copy its `onrender.com` origin. Do not put that origin in the app.

The blueprint sets `CAPRI_PC=off`, disables auto-publishing, and mounts persistent storage at `/var/data`.

## 2. Deploy the Cloudflare Worker

From the project directory, authenticate Wrangler and set the two Worker secrets. Use the Render origin from step 1 and the exact same proxy token entered in Render:

```powershell
npx wrangler login
npx wrangler secret put CAPRI_BACKEND_URL --config cloudflare/wrangler.toml
npx wrangler secret put CAPRI_PROXY_TOKEN --config cloudflare/wrangler.toml
npx wrangler deploy --config cloudflare/wrangler.toml
```

Wrangler prints a public `workers.dev` URL. The Worker accepts only `/api/` requests and sends the private proxy token to the Node service. Direct API calls to the Render origin are rejected once the token is configured.

## 3. Point the app at the Worker

Set `DEFAULT_BACKEND` in both `app.js` and `public/app.js` to the `workers.dev` URL, then publish the static UI to GitHub Pages. The URL of the Worker is public; the Render origin and proxy token are not. Existing installed APKs need to be rebuilt with `npx cap sync android` before building the APK.

## Google Sign-In

1. In Google Cloud Console, add `https://cp00004.github.io` to the OAuth client's authorized JavaScript origins.
2. Set `GOOGLE_CLIENT_ID` in the Render service environment.
3. Redeploy the service.

## Mobile app (APK)

The Capacitor Android project is in `android/`. To build:
```
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```
APK output: `android/app/build/outputs/apk/debug/app-debug.apk`.

Install on any Android device. In Settings, set the backend URL. Sign in with Google — memory, preferences and history sync per Gmail account across devices.

## Notes

- Provider keys and the proxy token stay in Render/Cloudflare secrets, never in the app bundle.
- The Worker URL is visible to users and is not a secret. The Render origin is protected by `CAPRI_PROXY_TOKEN`.
- To enable home-PC control, run Capri on that PC and use a tunnel instead; that option requires the PC and tunnel process to remain online.