function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // remove trailing slash

    // ✅ API route
    if (path === "/api/health") {
      return json({
        ok: true,
        time: new Date().toISOString(),
        hasDB: !!env.DB,
        hasASSETS: !!env.ASSETS,
      });
    }

    // everything else = your static app
    return env.ASSETS.fetch(request);
  },
};

