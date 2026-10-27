export default {
  async fetch(request, env) {
    if (!env.CAPRI_BACKEND_URL || !env.CAPRI_PROXY_TOKEN) {
      return new Response("Backend proxy is not configured.", { status: 503 });
    }

    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/")) {
      return new Response("Not found.", { status: 404 });
    }

    const upstream = new URL(env.CAPRI_BACKEND_URL);
    upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}${incoming.pathname}`;
    upstream.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("X-Capri-Proxy-Token", env.CAPRI_PROXY_TOKEN);

    return fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  },
};