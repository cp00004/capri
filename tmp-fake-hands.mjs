const BASE = "http://127.0.0.1:4420";
const AUTH = { Authorization: "Bearer testtoken123" };

async function loop() {
  while (true) {
    let payload;
    try {
      const res = await fetch(`${BASE}/api/hands/next`, { headers: AUTH });
      payload = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!payload.call) continue;
    console.log("CALL", payload.call.name, JSON.stringify(payload.call.args));
    await fetch(`${BASE}/api/hands/result`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: payload.call.id, result: { ok: true, output: "opened roblox" } }),
    });
  }
}
loop();
