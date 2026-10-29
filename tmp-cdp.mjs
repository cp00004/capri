const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") console.log("EXC", JSON.stringify(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text).slice(0, 500));
  if (msg.method === "Runtime.consoleAPICalled") console.log("CONSOLE", msg.params.type, msg.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { ws.onopen = r; });
await send("Runtime.enable");
await send("Log.enable");
const res = await send("Runtime.evaluate", { expression: `JSON.stringify({
  url: location.href,
  ready: document.readyState,
  title: document.title,
  text: (document.body.innerText || "").slice(0, 400),
  imgs: [...document.images].map(i => [i.id || i.className, i.getAttribute("src"), i.naturalWidth]),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  cls: document.body.className,
  appJs: [...document.scripts].map(s => s.src).filter(Boolean),
})`, returnByValue: true });
console.log(res.result?.result?.value);
setTimeout(() => process.exit(0), 1200);
