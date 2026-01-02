function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Normalize path:
    // - remove trailing slashes
    // - if your Worker is mounted under a prefix, strip everything before /api/
    let path = url.pathname.replace(/\/+$/, "");
    const apiIndex = path.indexOf("/api/");
    const apiPath = apiIndex >= 0 ? path.slice(apiIndex) : path;

    // CORS preflight
    if (request.method === "OPTIONS" && apiPath.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---------------- API ----------------
    if (apiPath === "/api/health") {
      return json(
        { ok: true, time: new Date().toISOString(), hasDB: !!env.DB, hasASSETS: !!env.ASSETS },
        200,
        corsHeaders()
      );
    }

    // Customers (GET)
    if (apiPath === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB
        .prepare("SELECT id, name, email, address, created_at FROM customers ORDER BY created_at DESC")
        .all();
      return json({ ok: true, customers: results }, 200, corsHeaders());
    }

    // Customers (POST)
    if (apiPath === "/api/customers" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders());

      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const address = String(body.address || "").trim();

      if (!name) return json({ ok: false, error: "Name is required" }, 400, corsHeaders());
      if (!email) return json({ ok: false, error: "Email is required" }, 400, corsHeaders());

      const res = await env.DB
        .prepare("INSERT INTO customers (name, email, address) VALUES (?, ?, ?)")
        .bind(name, email, address)
        .run();

      return json({ ok: true, id: res.meta.last_row_id }, 200, corsHeaders());
    }

    // ---------------- ASSETS ----------------
    return env.ASSETS.fetch(request);
  },
};
