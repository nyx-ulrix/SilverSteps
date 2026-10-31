// Sits on silversteps.liewjiaen.com. Sends traffic to the Deployer copy on the laptop (via its Cloudflare
// tunnel) and falls back to the static Firebase copy when the laptop doesn't answer.
const BACKUP = "https://silversteps-sg.web.app";
const DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]); // 530 = tunnel offline

export default {
  async fetch(req) {
    try {
      const res = await fetch(req, { signal: AbortSignal.timeout(8000) });
      if (!DOWN.has(res.status)) return res;
    } catch {
      // laptop asleep, tunnel gone or too slow
    }
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      // The backup is static: corrections can't be saved until the laptop is back.
      return Response.json({ error: "Saving is paused while the backup copy is serving" },
        { status: 503, headers: { "x-silversteps": "backup" } });
    }
    const res = await fetch(BACKUP + url.pathname + url.search, { method: req.method === "HEAD" ? "HEAD" : "GET" });
    const out = new Response(res.body, res);
    out.headers.set("x-silversteps", "backup");
    return out;
  },
};
