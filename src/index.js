function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function badRequest(message, extra = {}) {
  return json({ ok: false, error: message, ...extra }, 400);
}

function notFound() {
  return json({ ok: false, error: "Not found" }, 404);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight for API calls (handy for future use)
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---------- API ROUTES ----------
    if (path === "/api/health") {
      return json({ ok: true, worker: "elliots-invoice-app", time: new Date().toISOString() }, 200, corsHeaders());
    }

    // Customers
    if (path === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, address, created_at FROM customers ORDER BY created_at DESC"
      ).all();
      return json({ ok: true, customers: results }, 200, corsHeaders());
    }

    if (path === "/api/customers" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return badRequest("Invalid JSON body", { hint: "Send JSON with {name,email,address}" });

      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const address = String(body.address || "").trim();

      if (!name) return badRequest("Name is required");
      if (!email) return badRequest("Email is required");

      const res = await env.DB.prepare(
        "INSERT INTO customers (name, email, address) VALUES (?, ?, ?)"
      ).bind(name, email, address).run();

      return json({ ok: true, id: res.meta.last_row_id }, 200, corsHeaders());
    }

    // Invoices list
    if (path === "/api/invoices" && request.method === "GET") {
      const status = (url.searchParams.get("status") || "").trim(); // unpaid/paid
      const customerId = (url.searchParams.get("customer_id") || "").trim();

      let q = `
        SELECT
          i.id, i.invoice_no, i.customer_id, i.status, i.total, i.deposit_amount,
          i.issued_at, i.due_date, i.paid_at, i.receipt_no,
          c.name AS customer_name, c.email AS customer_email
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id
      `;
      const where = [];
      const binds = [];

      if (status) { where.push("i.status = ?"); binds.push(status); }
      if (customerId) { where.push("i.customer_id = ?"); binds.push(Number(customerId)); }

      if (where.length) q += " WHERE " + where.join(" AND ");
      q += " ORDER BY i.issued_at DESC";

      const stmt = env.DB.prepare(q);
      const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
      return json({ ok: true, invoices: results }, 200, corsHeaders());
    }

    // Create invoice
    if (path === "/api/invoices" && request.method === "POST") {
      const b = await readJson(request);
      if (!b) return badRequest("Invalid JSON body");

      const invoiceNo = String(b.invoice_no || "").trim();
      if (!invoiceNo) return badRequest("invoice_no is required");

      const customerId = b.customer_id ?? null;
      const items = Array.isArray(b.items) ? b.items : [];

      const subtotal = Number(b.subtotal || 0);
      const travelFee = Number(b.travel_fee || 0);
      const total = Number(b.total || 0);
      const depositAmount = Number(b.deposit_amount || 0); // £10 if needed

      const notes = String(b.notes || "");
      const dueDate = String(b.due_date || "");

      await env.DB.prepare(
        `INSERT INTO invoices
          (invoice_no, customer_id, status, subtotal, travel_fee, total, deposit_amount, items_json, notes, due_date)
         VALUES (?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        invoiceNo,
        customerId,
        subtotal,
        travelFee,
        total,
        depositAmount,
        JSON.stringify(items),
        notes,
        dueDate
      ).run();

      return json({ ok: true }, 200, corsHeaders());
    }

    // Mark paid (creates receipt_no)
    // POST /api/invoices/123/mark-paid
    const markPaidMatch = path.match(/^\/api\/invoices\/(\d+)\/mark-paid$/);
    if (markPaidMatch && request.method === "POST") {
      const id = Number(markPaidMatch[1]);
      const b = (await readJson(request)) || {};

      const paidAt = String(b.paid_at || new Date().toISOString());
      const paidMethod = String(b.paid_method || "Bank Transfer");
      const paidRef = String(b.paid_ref || "");

      // Example receipt number: R-20260102-123
      const today = new Date();
      const y = String(today.getUTCFullYear());
      const m = String(today.getUTCMonth() + 1).padStart(2, "0");
      const d = String(today.getUTCDate()).padStart(2, "0");
      const receiptNo = `R-${y}${m}${d}-${id}`;

      await env.DB.prepare(
        `UPDATE invoices
         SET status='paid',
             paid_at=?,
             paid_method=?,
             paid_ref=?,
             receipt_no=?
         WHERE id=?`
      ).bind(paidAt, paidMethod, paidRef, receiptNo, id).run();

      return json({ ok: true, receipt_no: receiptNo }, 200, corsHeaders());
    }

    // ---------- NOT API: serve your static site ----------
    return env.ASSETS.fetch(request);
  },
};
