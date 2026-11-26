/**
 * Ask each provider directly and report the real upstream status.
 *
 * The user's error said "speech reader refused (502)", but 502 is Capri's own
 * wrapper status for stt_failed. This prints what each upstream actually
 * answered, so the report can name the provider instead of the wrapper.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];

function keys(name) {
  const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = raw.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "").split(/[\s,;]+/).filter(Boolean) : [];
}

const show = (provider, status, body) => {
  const brief = String(body).replace(/\s+/g, " ").slice(0, 220);
  console.log(`${provider.padEnd(8)} ${status}  ${brief}`);
};

(async () => {
  const buf = fs.readFileSync(WAV);
  console.log(`audio ${(buf.length / 1024).toFixed(0)}KB\n`);

  // Groq
  for (const k of keys("GROQ_API_KEY")) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
      form.append("model", process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${k}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      show("groq", r.status, r.ok ? `words ok (${(await r.json()).text?.slice(0, 60)})` : await r.text());
    } catch (e) { show("groq", "ERR", e.message); }
  }

  // Gemini
  for (const k of keys("GEMINI_API_KEY")) {
    for (const model of ["gemini-3.5-flash", "gemini-2.5-flash"]) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": k },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [
                { text: "Transcribe the speech in this audio exactly." },
                { inline_data: { mime_type: "audio/wav", data: buf.toString("base64") } },
              ] }],
              generationConfig: { temperature: 0 },
            }),
            signal: AbortSignal.timeout(60_000),
          }
        );
        show(`gemini/${model}`, r.status, r.ok ? "ok" : await r.text());
      } catch (e) { show(`gemini/${model}`, "ERR", e.message); }
    }
  }

  // Mistral
  for (const k of keys("MISTRAL_API_KEY")) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
      form.append("model", process.env.CAPRI_STT_MISTRAL_MODEL || "voxtral-mini-latest");
      form.append("response_format", "verbose_json");
      const r = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${k}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      show("mistral", r.status, r.ok ? "ok" : await r.text());
    } catch (e) { show("mistral", "ERR", e.message); }
  }
})();
