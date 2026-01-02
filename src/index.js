function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function trimSlash(p) {
  return p.replace(/\/+$/, "") || "/";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = trimSlash(url.pathname);

    // CORS preflight
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: cors() });
    }

    // ---------- HEALTH ----------
    if (path === "/api/health") {
      let dbTest = "missing";
      if (env.DB) {
        try {
          await env.DB.prepare("SELECT 1").first();
          dbTest = "ok";
        } catch {
          dbTest = "error";
        }
      }
      return json(
        {
          ok: true,
          time: new Date().toISOString(),
          hasDB: !!env.DB,
          dbTest,
          hasASSETS: !!env.ASSETS,
        },
        200,
        cors()
      );
    }

    // ---------- CUSTOMERS ----------
    if (path === "/api/customers" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, address, created_at FROM customers ORDER BY created_at DESC"
      ).all();
      return json({ ok: true, customers: results }, 200, cors());
    }

    if (path === "/api/customers" && request.method === "POST") {
      const b = await readJson(request);
      if (!b) return json({ ok: false, error: "Invalid JSON body" }, 400, cors());

      const name = String(b.name || "").trim();
      const email = String(b.email || "").trim();
      const address = String(b.address || "").trim();

      if (!name) return json({ ok: false, error: "Name is required" }, 400, cors());
      if (!email) return json({ ok: false, error: "Email is required" }, 400, cors());

      const res = await env.DB.prepare(
        "INSERT INTO customers (name, email, address) VALUES (?, ?, ?)"
      )
        .bind(name, email, address)
        .run();

      return json({ ok: true, id: res.meta.last_row_id }, 200, cors());
    }

    // ---------- INVOICES ----------
    if (path === "/api/invoices" && request.method === "GET") {
      const status = (url.searchParams.get("status") || "").trim(); // paid/unpaid
      const programme = (url.searchParams.get("programme") || "").trim(); // lessons/school_band

      let q = `
        SELECT
          i.id, i.invoice_no, i.customer_id, i.status, i.programme,
          i.subtotal, i.travel_fee, i.total, i.deposit_amount,
          i.issued_at, i.due_date, i.paid_at, i.paid_method, i.paid_ref,
          i.receipt_no, i.emailed_receipt_at,
          c.name AS customer_name, c.email AS customer_email
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id
      `;

      const where = [];
      const binds = [];
      if (status) { where.push("i.status = ?"); binds.push(status); }
      if (programme) { where.push("i.programme = ?"); binds.push(programme); }

      if (where.length) q += " WHERE " + where.join(" AND ");
      q += " ORDER BY i.issued_at DESC";

      const stmt = env.DB.prepare(q);
      const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();

      return json({ ok: true, invoices: results }, 200, cors());
    }

    if (path === "/api/invoices" && request.method === "POST") {
      const b = await readJson(request);
      if (!b) return json({ ok: false, error: "Invalid JSON body" }, 400, cors());

      const invoiceNo = String(b.invoice_no || "").trim();
      if (!invoiceNo) return json({ ok: false, error: "invoice_no is required" }, 400, cors());

      const customerId = b.customer_id ?? null;
      const programme = String(b.programme || "lessons"); // lessons | school_band
      const items = Array.isArray(b.items) ? b.items : [];

      const subtotal = Number(b.subtotal || 0);
      const travelFee = Number(b.travel_fee || 0);
      const total = Number(b.total || 0);
      const depositAmount = Number(b.deposit_amount || 0);

      const notes = String(b.notes || "");
      const dueDate = String(b.due_date || "");

      await env.DB.prepare(
        `INSERT INTO invoices
          (invoice_no, customer_id, status, programme, subtotal, travel_fee, total, deposit_amount, items_json, notes, due_date)
         VALUES (?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          invoiceNo,
          customerId,
          programme,
          subtotal,
          travelFee,
          total,
          depositAmount,
          JSON.stringify(items),
          notes,
          dueDate
        )
        .run();

      return json({ ok: true }, 200, cors());
    }

    // POST /api/invoices/:id/mark-paid  (generates receipt number)
    const paidMatch = path.match(/^\/api\/invoices\/(\d+)\/mark-paid$/);
    if (paidMatch && request.method === "POST") {
      const id = Number(paidMatch[1]);
      const b = (await readJson(request)) || {};

      const paidAt = String(b.paid_at || new Date().toISOString());
      const paidMethod = String(b.paid_method || "Stripe/Bank");
      const paidRef = String(b.paid_ref || "");

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
      )
        .bind(paidAt, paidMethod, paidRef, receiptNo, id)
        .run();

      return json({ ok: true, receipt_no: receiptNo }, 200, cors());
    }

    // ---------- STATIC SITE ----------
    return env.ASSETS.fetch(request);
  },
};
