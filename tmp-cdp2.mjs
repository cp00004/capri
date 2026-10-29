const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Network.loadingFailed") console.log("FAIL", m.params.errorText, m.params.blockedReason || "");
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) console.log("HTTP", m.params.response.status, m.params.response.url.slice(0, 100));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { ws.onopen = r; });
await send("Network.enable");
await send("Page.enable");
const nav = await send("Page.navigate", { url: "https://cp00004.github.io/capri/" });
console.log("navigate result:", JSON.stringify(nav.result));
await new Promise((r) => setTimeout(r, 9000));
const res = await send("Runtime.evaluate", { expression: "JSON.stringify({url: location.href, title: document.title, text: (document.body.innerText||'').slice(0,120)})", returnByValue: true });
console.log(res.result?.result?.value);
process.exit(0);
