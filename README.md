# CAPRI // PROJECT CAPRICORN

A voice-first personality construct with hands on your PC. You talk, she answers out loud, and when you tell her to do something on the machine, she does it.

Capri is a fan-built character construct from *Cyberpunk: Edgerunners 2* — sardonic, theatrical, slightly plural, and very sure she is not an assistant. The interface is one portrait, one microphone, one keyboard, and a settings sheet. No chat log, no dashboards, no rails.

![Capri on the desktop](docs/desktop.png)

## What this is

- **Voice in, voice out.** Whisper transcribes you, `openai/gpt-oss-120b` answers in character, Orpheus speaks her lines with a system-voice fallback.
- **Real PC control.** Shell, PowerShell, files, folders, apps, clipboard, keystrokes, screenshots, system state. Thirteen tools, executed on this machine.
- **Full access by design.** No per-action confirmation for ordinary work. A short catastrophic list (disk format, boot edits, registry hive wipes, audit-log tampering) is refused.
- **A phone link.** The same UI over your LAN, with device pairing, a six-digit code, and a desktop approval modal before a phone gets her hands.
- **An audit trail.** Every tool call lands in `capri-actions.log` and the last actions show up in Settings. One switch locks her out instantly.

| Phone | Settings | Pairing |
| --- | --- | --- |
| ![Phone](docs/mobile.png) | ![Settings](docs/mobile-settings.png) | ![Pair](docs/mobile-pair.png) |

## Requirements

- Windows 10 or 11 (the PC-control layer is PowerShell + Win32).
- Node.js 20 or newer.
- A Groq API key from <https://console.groq.com/keys>.

## Quick start

```bat
copy .env.example .env
notepad .env
```

Set `GROQ_API_KEY=...`, save, then:

```bat
npm start
```

Open <http://localhost:4173>. On Windows you can also double-click `start-capri.cmd`, or `open-capri.ps1` for a chrome app-style window.

The console prints the LAN address and the six-digit pair code on every boot.

### Env

| Key | Default | What it does |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Required. Chat, transcription and speech. |
| `CAPRI_MODEL` | `openai/gpt-oss-120b` | Chat model. Must support tool calls. |
| `PORT` | `4173` | HTTP port for this PC. HTTPS uses `PORT + 1`. |
| `CAPRI_HTTPS_PORT` | `4174` | Override the HTTPS port. |
| `CAPRI_PAIR_CODE` | random | Fixed six-digit pairing code. |
| `CAPRI_PC` | — | Set to `off` to boot with her hands tied. |
| `CAPRI_CERT` / `CAPRI_KEY` | `cert.pem` / `key.pem` | Custom certificate paths. |

`.env`, device tokens, the audit log and certificates are gitignored.

## Her hands

Tools she can call:

| Tool | Use |
| --- | --- |
| `run_shell` | PowerShell or cmd, with cwd and timeout |
| `powershell_object` | Structured queries: processes, services, network, battery |
| `read_file` / `write_file` | Text files, create parents, append or overwrite |
| `list_dir` / `make_dir` / `move_path` / `delete_path` | Filesystem work |
| `open_target` | URLs, files, folders, installed apps |
| `system_info` | OS, CPU, memory, uptime, user, paths |
| `screenshot` | Capture the current screen to PNG |
| `clipboard` | Read or write the Windows clipboard |
| `send_keys` | Type into the focused window |

**Trust model.** Loopback callers (this PC) are trusted and get `local` scope. Paired devices start at `voice` scope: talk, no hands. A phone asks for `full` from Settings, the desktop shows a **CHROME REQUEST** modal, and you decide. Requests expire after five minutes; pairing codes are rate-limited to eight attempts per five minutes per address.

**Kill switch.** Settings → **LOCK HER OUT** disables every tool for every caller immediately, including the desktop. **UNLOCK HER** brings them back.

**Audit.** Each call is appended as one JSON line to `capri-actions.log` with timestamp, tool, arguments, result and a clipped output. Settings shows the last ten. The file is local and gitignored; deleting it is the one file operation Capri refuses.

## Voice

- **Listening:** `whisper-large-v3-turbo`, with silence detection so you do not have to press stop.
- **Talking:** `canopylabs/orpheus-v1-english` (voices: diana, hannah, autumn, tara, leah, mia, zoe), or the browser's speech engine when Orpheus is unavailable.
- **One-time terms:** Groq requires the account admin to accept the Orpheus terms before the model will speak. Open <https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english>, accept once, and restart the server if it still falls back. The app tells you and keeps working with the system voice.
- Tap the mic, or hold **Space** on the desktop. **Esc** cuts her off. The **KEYBOARD** button opens a text line for quiet rooms.
- Audio is sent to Groq for transcription and speech; nothing is written to disk.

## Phone link

Phones only allow microphone access on secure pages, so the server also speaks HTTPS on `4174` when a certificate is present. The desktop stays on plain `http://localhost:4173`, which browsers already treat as secure.

1. On the PC, issue a certificate for this machine's LAN address:

   ```bat
   npm run cert
   ```

   This uses the openssl that ships with Git for Windows and writes `cert.pem` / `key.pem` (gitignored). Run it again if your LAN IP changes.

2. Restart `npm start`. The console now prints `https://<your-ip>:4174`.

3. On the phone, download and install the certificate once:

   - Open `http://<your-ip>:4173/cert` in the phone browser.
   - **Android:** Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → **CA certificate** → pick the downloaded file. The path varies by vendor.
   - **iPhone:** download it in Safari, then Settings → **Profile Downloaded** → Install. Finally Settings → General → About → **Certificate Trust Settings** → enable **Capri Local**.

4. Open `https://<your-ip>:4174`. Tap **LINK ME**, give the device a name, and type the six-digit code shown in Settings on the PC.

5. You are paired at voice scope. Settings → **REQUEST FULL ACCESS**. The PC shows **CHROME REQUEST**; press **GIVE HER THE KEYS**. The phone updates within a few seconds.

6. **Add to Home Screen** for a standalone, full-screen app. A web manifest and 192/512 icons are included.

If you skip the certificate, the phone can still use the keyboard and hear her, but the mic will be blocked by the browser. The app explains this if you tap the mic on an insecure page.

## Settings

- **Voice** — Orpheus voice or installed system voice, plus a mute toggle.
- **Her hands** — current scope, request access (phone), lock/unlock (PC).
- **Pair a device** — six-digit code and a copyable LAN link (PC only).
- **Paired devices** — name, address, scope, and a CUT button (PC only).
- **Link** — cut voice, reset the conversation.
- **PC address** — where the UI should look for the server. Leave blank when the page is served by the PC. Set it when a wrapper app hosts the page elsewhere.
- **Last actions** — recent audit entries (PC only).

## Using a wrapper app or a hosted UI

This repository is a small Node server plus a static UI. The mobile app you build from it has to reach the PC server; a bundled copy of the HTML alone cannot control anything.

- If your builder wraps a URL, point it at the PC's LAN address. Use `https://<ip>:4174` so the mic works. The app is served same-origin, so nothing else is needed.
- If your builder hosts the UI on its own domain, put the PC's address in **PC address**. The API sends CORS headers and accepts bearer tokens, so a cross-origin page can pair and talk to it. Keep it on HTTPS or the browser may block the calls as mixed content.
- For a certificate the phone already trusts, run a tunnel in front of the PC (for example `cloudflared tunnel --url http://localhost:4173`) and use the tunnel URL as the PC address. A tunnel publishes the app beyond your LAN: the pair code and token model still apply, but treat it as an internet-facing service and lock her out when you are done.

## Security

- Loopback is trusted; everything on the LAN needs a token from pairing.
- Tokens are random 192-bit values, stored hashed in `.capri-devices.json`.
- The static shell, manifest and `/api/config` are readable without a token. Config hides the code, device list and secrets from unpaired callers.
- Chat, speech, transcription and every tool action require a valid token.
- The pair endpoint throttles failed codes per IP.
- Full-access requests need a click on the desktop and expire.
- Every action is logged; the log is append-only through the app and cannot be deleted by Capri.
- There is no telemetry. Groq receives your audio and prompts.

Do not forward `4173` or `4174` on your router unless you understand the trade-off. A tunnel is safer than a port-forward, and the lock switch is still your friend.

## Layout

```
capri-desktop/
  server.js                 static shell, Groq relay, agent loop, pairing, access
  lib/pc.js                 tool definitions, PowerShell executor, guards, audit
  public/
    index.html              portrait, mic, keyboard, settings/pair/approval sheets
    app.js                  recording, SSE, speech, settings, pairing, approval
    styles.css              pink/mint/black hex portrait, dock, sheets, mobile
    manifest.webmanifest    PWA
    assets/                 portrait, logo, favicon, 192/512 icons
  scripts/make-cert.ps1     local HTTPS certificate for the phone
  open-capri.ps1            chrome app-style window
  start-capri.cmd           console launcher
  docs/                     screenshots used above
```

Runtime files, all gitignored: `.env`, `.capri-devices.json`, `capri-actions.log`, `cert.pem`, `key.pem`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No Groq key loaded" | Put `GROQ_API_KEY` in `.env` and restart. |
| Her voice is flat / robotic | Orpheus terms are not accepted yet. Accept them once, then reload. |
| Phone mic does nothing | You are on `http://`. Issue the certificate, open `https://<ip>:4174`, and trust it on the phone. |
| Phone says "not paired" | Read the six-digit code in Settings on the PC. It changes every boot unless `CAPRI_PAIR_CODE` is set. |
| Phone link is dead after a restart | Pairing survives restarts; a revoked or edited device list does not. Pair again. |
| Phone cannot load the page | Allow Node through Windows Firewall on private networks, and confirm both devices are on the same Wi-Fi. |
| "Port already in use" | Change `PORT` in `.env`, or stop the other server. |
| No sound on the first tap | Browsers need one gesture; tap the mic once. Check the voice toggle in Settings. |
| Screenshot tool saves somewhere unexpected | She chooses a path; ask for the full path in the reply, or say where to put it. |

## Notes

- Windows-only control layer. The voice and chat parts are portable; `lib/pc.js` is not.
- The character and setting belong to CD Projekt Red / the Edgerunners creators. This is a private fan project, not affiliated.
- Built to be read, not to be safe by default: full access is the point, and the lock switch is the brake.
