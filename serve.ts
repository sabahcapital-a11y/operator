// Production server for the dashboard site.
// Serves static dashboard files and proxies /api to the API server on port 3001.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/packages/dashboard/dist`;

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

// Free PORT regardless of which user owns the current listener.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const url = new URL(req.url);
        const { pathname } = url;

        // Proxy /api to the API server
        if (pathname.startsWith("/api")) {
          try {
            const apiRes = await fetch(`http://127.0.0.1:3001${pathname}${url.search}`, {
              method: req.method,
              headers: req.headers,
              body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
            });
            return apiRes;
          } catch {
            return new Response("API unavailable", { status: 502 });
          }
        }

        // Serve static files with correct MIME types
        const ext = pathname.includes(".") ? pathname.slice(pathname.lastIndexOf(".")) : "";
        if (STATIC_TYPES[ext]) {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": STATIC_TYPES[ext] },
            });
          }
        }

        // SPA fallback — serve index.html
        const indexFile = Bun.file(CLIENT_DIR + "/index.html");
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`LeadGuard serving on http://${HOST}:${String(PORT)}`);
