import fs from "fs";

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = (env.match(/^FREETHEAI_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!key) throw new Error("no key in .env");

const base = "https://api.freetheai.org/v1";
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const models = await fetch(`${base}/models`, { headers: auth }).then(async (r) => {
  const text = await r.text();
  console.log("models status", r.status);
  try {
    const j = JSON.parse(text);
    const ids = (j.data || []).map((m) => m.id);
    console.log("count", ids.length);
    console.log(ids.filter((id) => /gpt-oss|gpt-4\.1|glm|deepseek|gemini-3/i.test(id)).slice(0, 14).join("\n"));
  } catch {
    console.log(text.slice(0, 300));
  }
});

const tool = [{
  type: "function",
  function: {
    name: "get_time",
    description: "Read the clock.",
    parameters: { type: "object", properties: {} },
  },
}];

for (const model of ["fta/lion/gpt-4.1", "fta/olf/gpt-oss:120b", "fta/meow/gpt-4o-mini"]) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 80,
        messages: [{ role: "user", content: "Call get_time. No words." }],
        tools: tool,
        tool_choice: "auto",
      }),
    });
    const text = await res.text();
    let note = text.slice(0, 160).replace(/\s+/g, " ");
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        const msg = j.choices?.[0]?.message;
        note = msg?.tool_calls ? `tool_calls=${msg.tool_calls.length}` : `text="${(msg?.content || "").slice(0, 60)}"`;
      } catch { /* keep raw */ }
    }
    console.log(`${model} -> ${res.status} ${Date.now() - started}ms ${note}`);
  } catch (err) {
    console.log(`${model} -> network ${err.message}`);
  }
}
