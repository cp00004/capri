# Sign in with Google

Capri uses **Google Identity Services** (the modern "Sign in with Google" button) to tie a profile to a Google account. The browser gets a signed ID token from Google, the local server verifies it, and everything else — settings, what she calls you, conversation history, favourites, music — is stored in a local profile keyed by that account.

No client secret. No redirect URL. No data leaves this PC except the token check itself.

---

## 1. Make a Google Cloud project

1. Open <https://console.cloud.google.com/projectcreate>.
2. Name it something like `capri-local` and press **Create**. You do not need billing.

## 2. Configure the consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (a private Gmail account is fine) and press **Create**.
3. Fill in:
   - **App name:** `Capri`
   - **User support email:** your Gmail
   - **Developer contact email:** your Gmail
4. Press **Save and continue**.
5. **Scopes** — leave the defaults. Press **Save and continue**. Capri only asks for `openid`, `email`, `profile`.
6. **Test users** — press **Add users** and add the Gmail account you will sign in with. While the app is in "Testing", only these accounts can sign in. That is what you want.
7. Press **Save and continue**, then **Back to dashboard**.

You do not need to publish the app. Leave it in **Testing**.

## 3. Create a Web OAuth client

1. Go to **APIs & Services → Credentials**.
2. Press **Create credentials → OAuth client ID**.
3. **Application type:** `Web application`.
4. **Name:** `Capri on this PC`.
5. Under **Authorized JavaScript origins**, add every address you will load Capri from:

   ```
   http://localhost:4173
   https://localhost:4174
   https://192.168.101.2:4174
   ```

   - `http://localhost:4173` is the desktop page.
   - `https://localhost:4174` is the desktop over HTTPS.
   - The third is the phone link on your LAN. Use the IP printed by the server on boot (`phone:` line). If your router hands out a different address later, come back and add that one too.
   - Origins have **no trailing slash** and **no path**. `https://192.168.101.2:4174` — not `https://192.168.101.2:4174/` and not `/app`.

6. Leave **Authorized redirect URIs** empty. This flow does not use them.
7. Press **Create** and copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

## 4. Put it in `.env`

Open `.env` on the PC and set:

```ini
GOOGLE_CLIENT_ID=1234567890-abcdefghijklmnop.apps.googleusercontent.com
```

Restart the server. The boot banner should now say:

```
google:    sign-in ready
```

## 5. Sign in

1. Open Capri, press the gear, find **ACCOUNT**.
2. Press the Google button and pick your account.
3. On success the sheet shows `Signed in as you@gmail.com`, and `memory` starts counting again.

The first Google account on a PC inherits the local profile's name, settings, memory and recent turns, so you do not start empty.

## What is stored, and where

| Thing | Where | Published? |
| --- | --- | --- |
| Profiles, settings, memory, history | `.capri-users.json` | No — gitignored |
| Session tokens (hashed) | `.capri-users.json` | No |
| Official settings schema | `settings.registry.json` | Yes |
| Device pairing tokens | `.capri-devices.json` | No |

Signing out (`SIGN OUT` in Settings) drops that session token from the server. The profile stays, so signing back in with the same Google account restores everything.

The session token is sent as `X-Capri-Profile` on API calls. It is stored in this browser's `localStorage`, so treat a shared browser profile the way you would treat a shared password manager.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Google sign-in is not configured yet` | `GOOGLE_CLIENT_ID` is empty | Set it, restart the server. |
| The button does not appear | Script blocked, or the origin is not authorised | Check the browser console; add the exact origin in Google Cloud. |
| `The given origin is not allowed for the given client ID` | Origin mismatch | The origin in the address bar must match an entry character for character, including port and `http`/`https`. |
| `Google rejected that sign-in token` | Token expired or audience mismatch | Reload the page and try again; confirm you copied the *client ID*, not the secret. |
| `That Google token was minted for another app` | Token belongs to a different client ID | One client ID per `.env`; do not reuse another app's token. |
| `Verify that Google email address first` | Unverified Google email | Use a verified account. |
| Sign-in works on desktop but not the phone | Phone origin missing, or page is `http://` | Add `https://<lan-ip>:4174` and open the HTTPS link (the mic needs it anyway). |
| Works until the router restarts | LAN IP changed | Re-run `npm run cert`, add the new origin to Google Cloud, update `.env`/phone bookmark. |

### Why HTTPS matters on the phone

Google Identity Services refuses to run on an insecure origin that is not `localhost`. The desktop is fine on `http://localhost:4173`; the phone must use the HTTPS link on port 4174. The certificate is local and self-signed, so install it on the phone once — see the main README.

### Privacy

The server verifies the ID token with `https://oauth2.googleapis.com/tokeninfo`. Google sees that a token was checked; it does not see your conversations. Chat and speech still go to Groq and Google AI Studio as described in the README.
