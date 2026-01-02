// src/index.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS (same-origin is fine, but this keeps tools like curl happy)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, url);
    }

    // Static assets fallback
    if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function bad(status, message, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function gbp(n) {
  const num = Number(n || 0);
  return `£${num.toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function handleApi(request, env, ctx, url) {
  const { pathname, searchParams } = url;

  // --- Health
  if (pathname === "/api/health" && request.method === "GET") {
    const hasDB = !!env.emm_invoices;
    const hasASSETS = !!env.ASSETS;
    let dbTest = null;

    if (hasDB) {
      try {
        await env.emm_invoices.prepare("SELECT 1 as ok").first();
        dbTest = "ok";
      } catch (e) {
        dbTest = String(e?.message || e);
      }
    }

    return json({ ok: true, time: nowIso(), hasDB, dbTest, hasASSETS });
  }

  // --- Customers (list/search)
  if (pathname === "/api/customers" && request.method === "GET") {
    if (!env.emm_invoices) return bad(500, "DB not configured");

    const q = safeStr(searchParams.get("q") || searchParams.get("search"));
    const limit = Math.min(Number(searchParams.get("limit") || 25), 100);

    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await env.emm_invoices
        .prepare(
          `SELECT id, name, email, address, phone, created_at
           FROM customers
           WHERE name LIKE ? OR email LIKE ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .bind(like, like, limit)
        .all();
    } else {
      rows = await env.emm_invoices
        .prepare(
          `SELECT id, name, email, address, phone, created_at
           FROM customers
           ORDER BY id DESC
           LIMIT ?`
        )
        .bind(limit)
        .all();
    }

    return json({ ok: true, customers: rows.results || [] });
  }

  // --- Invoices list
  if (pathname === "/api/invoices" && request.method === "GET") {
    if (!env.emm_invoices) return bad(500, "DB not configured");
    const limit = Math.min(Number(searchParams.get("limit") || 30), 100);

    const rows = await env.emm_invoices
      .prepare(
        `SELECT i.id, i.invoice_no, i.programme, i.total, i.deposit_amount, i.issued_at, i.due_date,
                i.paid_at, i.receipt_no,
                c.name as customer_name, c.email as customer_email
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id
         ORDER BY i.id DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return json({ ok: true, invoices: rows.results || [] });
  }

  // --- Get invoice by id
  {
    const m = pathname.match(/^\/api\/invoices\/(\d+)$/);
    if (m && request.method === "GET") {
      if (!env.emm_invoices) return bad(500, "DB not configured");
      const id = Number(m[1]);

      const row = await env.emm_invoices
        .prepare(
          `SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address, c.phone as customer_phone
           FROM invoices i
           LEFT JOIN customers c ON c.id = i.customer_id
           WHERE i.id = ?`
        )
        .bind(id)
        .first();

      if (!row) return bad(404, "Invoice not found");

      let items = [];
      try { items = JSON.parse(row.items_json || "[]"); } catch {}

      return json({
        ok: true,
        invoice: {
          id: row.id,
          invoice_no: row.invoice_no,
          programme: row.programme,
          subtotal: row.subtotal,
          travel_fee: row.travel_fee,
          total: row.total,
          deposit_amount: row.deposit_amount,
          notes: row.notes,
          issued_at: row.issued_at,
          due_date: row.due_date,
          paid_at: row.paid_at,
          paid_method: row.paid_method,
          paid_ref: row.paid_ref,
          receipt_no: row.receipt_no,
          emailed_receipt_at: row.emailed_receipt_at,
          customer: {
            id: row.customer_id,
            name: row.customer_name,
            email: row.customer_email,
            address: row.customer_address,
            phone: row.customer_phone,
          },
          items,
        },
      });
    }
  }

  // --- Upsert invoice (also upserts customer by email)
  if (pathname === "/api/invoices" && request.method === "POST") {
    if (!env.emm_invoices) return bad(500, "DB not configured");

    const body = await readJson(request);
    if (!body) return bad(400, "Invalid JSON");

    const invoiceNo = safeStr(body.invoice_no);
    if (!invoiceNo) return bad(400, "invoice_no is required");

    const programme = safeStr(body.programme) || "lessons";

    const subtotal = Number(body.subtotal || 0);
    const travelFee = Number(body.travel_fee || 0);
    const total = Number(body.total || 0);
    const depositAmount = Number(body.deposit_amount || 0);

    const dueDate = safeStr(body.due_date) || null;
    const notes = safeStr(body.notes) || null;

    const items = Array.isArray(body.items) ? body.items : [];
    const itemsJson = JSON.stringify(items);

    const cust = body.customer || {};
    const custName = safeStr(cust.name);
    const custEmail = safeStr(cust.email);
    const custAddress = safeStr(cust.address);
    const custPhone = safeStr(cust.phone);

    if (!custName) return bad(400, "Customer name is required");

    // Upsert customer
    let customerId = null;

    if (custEmail) {
      const existing = await env.emm_invoices
        .prepare("SELECT id FROM customers WHERE email = ? LIMIT 1")
        .bind(custEmail)
        .first();

      if (existing?.id) {
        customerId = existing.id;
        await env.emm_invoices
          .prepare("UPDATE customers SET name = ?, address = ?, phone = ? WHERE id = ?")
          .bind(custName, custAddress || null, custPhone || null, customerId)
          .run();
      } else {
        const ins = await env.emm_invoices
          .prepare("INSERT INTO customers (name, email, address, phone) VALUES (?, ?, ?, ?)")
          .bind(custName, custEmail, custAddress || null, custPhone || null)
          .run();
        customerId = ins.meta?.last_row_id ?? null;
      }
    } else {
      // No email: insert a new customer record (can duplicate, but fine)
      const ins = await env.emm_invoices
        .prepare("INSERT INTO customers (name, email, address, phone) VALUES (?, ?, ?, ?)")
        .bind(custName, null, custAddress || null, custPhone || null)
        .run();
      customerId = ins.meta?.last_row_id ?? null;
    }

    // Upsert invoice by invoice_no
    await env.emm_invoices
      .prepare(
        `INSERT INTO invoices (
          invoice_no, customer_id, programme,
          subtotal, travel_fee, total,
          deposit_amount, items_json, notes, due_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(invoice_no) DO UPDATE SET
          customer_id = excluded.customer_id,
          programme = excluded.programme,
          subtotal = excluded.subtotal,
          travel_fee = excluded.travel_fee,
          total = excluded.total,
          deposit_amount = excluded.deposit_amount,
          items_json = excluded.items_json,
          notes = excluded.notes,
          due_date = excluded.due_date`
      )
      .bind(
        invoiceNo,
        customerId,
        programme,
        subtotal,
        travelFee,
        total,
        depositAmount,
        itemsJson,
        notes,
        dueDate
      )
      .run();

    const saved = await env.emm_invoices
      .prepare("SELECT id FROM invoices WHERE invoice_no = ? LIMIT 1")
      .bind(invoiceNo)
      .first();

    return json({ ok: true, id: saved?.id, invoice_no: invoiceNo, customer_id: customerId });
  }

  // --- Mark paid (auto emails receipt)
  {
    const m = pathname.match(/^\/api\/invoices\/(\d+)\/mark-paid$/);
    if (m && request.method === "POST") {
      if (!env.emm_invoices) return bad(500, "DB not configured");
      const id = Number(m[1]);
      const body = (await readJson(request)) || {};

      const paidAt = safeStr(body.paid_at) || nowIso();
      const paidMethod = safeStr(body.paid_method) || "Bank Transfer";
      const paidRef = safeStr(body.paid_ref) || null;

      // Generate receipt number if missing
      const existing = await env.emm_invoices
        .prepare("SELECT receipt_no, invoice_no FROM invoices WHERE id = ?")
        .bind(id)
        .first();
      if (!existing) return bad(404, "Invoice not found");

      const receiptNo =
        existing.receipt_no ||
        `RCPT-${existing.invoice_no}-${paidAt.slice(0, 10).replaceAll("-", "")}`;

      await env.emm_invoices
        .prepare(
          `UPDATE invoices
           SET paid_at = ?, paid_method = ?, paid_ref = ?, receipt_no = ?
           WHERE id = ?`
        )
        .bind(paidAt, paidMethod, paidRef, receiptNo, id)
        .run();

      // Auto email receipt (if configured)
      let emailed = false;
      let emailError = null;

      try {
        const result = await sendReceiptEmail({ env, invoiceId: id, receiptNo });
        emailed = result.emailed;
        emailError = result.error;

        if (emailed) {
          await env.emm_invoices
            .prepare("UPDATE invoices SET emailed_receipt_at = ? WHERE id = ?")
            .bind(nowIso(), id)
            .run();
        }
      } catch (e) {
        emailed = false;
        emailError = String(e?.message || e);
      }

      return json({ ok: true, id, receipt_no: receiptNo, emailed, emailError });
    }
  }

  // --- Mark unpaid
  {
    const m = pathname.match(/^\/api\/invoices\/(\d+)\/mark-unpaid$/);
    if (m && request.method === "POST") {
      if (!env.emm_invoices) return bad(500, "DB not configured");
      const id = Number(m[1]);

      await env.emm_invoices
        .prepare(
          `UPDATE invoices
           SET paid_at = NULL, paid_method = NULL, paid_ref = NULL
           WHERE id = ?`
        )
        .bind(id)
        .run();

      return json({ ok: true, id });
    }
  }

  // --- Manual resend receipt (optional)
  {
    const m = pathname.match(/^\/api\/invoices\/(\d+)\/email-receipt$/);
    if (m && request.method === "POST") {
      if (!env.emm_invoices) return bad(500, "DB not configured");
      const id = Number(m[1]);

      const row = await env.emm_invoices
        .prepare("SELECT receipt_no FROM invoices WHERE id = ?")
        .bind(id)
        .first();

      const receiptNo = row?.receipt_no || null;
      const result = await sendReceiptEmail({ env, invoiceId: id, receiptNo });

      if (result.emailed) {
        await env.emm_invoices
          .prepare("UPDATE invoices SET emailed_receipt_at = ? WHERE id = ?")
          .bind(nowIso(), id)
          .run();
      }

      return json({ ok: true, id, emailed: result.emailed, error: result.error || null });
    }
  }

  return bad(404, "Not found");
}

async function sendReceiptEmail({ env, invoiceId, receiptNo }) {
  // If no Resend key configured, skip (frontend can fallback to mailto)
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    return { emailed: false, error: "Email not configured (missing RESEND_API_KEY or RESEND_FROM)" };
  }

  const row = await env.emm_invoices
    .prepare(
      `SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.id = ?`
    )
    .bind(invoiceId)
    .first();

  if (!row) return { emailed: false, error: "Invoice not found" };
  if (!row.customer_email) return { emailed: false, error: "Customer email missing" };

  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch {}

  const total = Number(row.total || 0);
  const deposit = Number(row.deposit_amount || 0);
  const balanceDue = Math.max(0, total - deposit);

  const subject = `Receipt — ${row.invoice_no} — Paid`;
  const effectiveReceiptNo =
    receiptNo || row.receipt_no || `RCPT-${row.invoice_no}-${nowIso().slice(0, 10).replaceAll("-", "")}`;

  const html = renderReceiptHtml({
    receiptNo: effectiveReceiptNo,
    invoiceNo: row.invoice_no,
    paidAt: row.paid_at,
    paidMethod: row.paid_method,
    paidRef: row.paid_ref,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerAddress: row.customer_address,
    items,
    travelFee: Number(row.travel_fee || 0),
    total,
    deposit,
    balanceDue,
    programme: row.programme,
  });

  const text = renderReceiptText({
    receiptNo: effectiveReceiptNo,
    invoiceNo: row.invoice_no,
    paidAt: row.paid_at,
    paidMethod: row.paid_method,
    paidRef: row.paid_ref,
    customerName: row.customer_name,
    items,
    travelFee: Number(row.travel_fee || 0),
    total,
    deposit,
    balanceDue,
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: row.customer_email,
      subject,
      html,
      text,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { emailed: false, error: `Resend error ${resp.status}: ${errText.slice(0, 300)}` };
  }

  return { emailed: true, error: null };
}

function renderReceiptHtml(data) {
  const paidDate = data.paidAt ? new Date(data.paidAt).toLocaleString("en-GB") : "—";
  const rows = data.items
    .map((it) => {
      const desc = escapeHtml(it.desc || "");
      const when =
        it.date || it.time
          ? ` <span style="color:#6b7280;font-size:12px;">(${escapeHtml(it.date || "")}${it.time ? " " + escapeHtml(it.time) : ""})</span>`
          : "";
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">${desc}${when}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${Number(it.qty || 0)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${gbp(it.unit)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${gbp(it.amount)}</td>
        </tr>
      `;
    })
    .join("");

  const travelRow =
    data.travelFee && Number(data.travelFee) !== 0
      ? `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">Travel Fee</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">1</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${gbp(data.travelFee)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;">${gbp(data.travelFee)}</td>
        </tr>
      `
      : "";

  const depositBlock =
    Number(data.deposit || 0) > 0
      ? `
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <div style="color:#374151;">Stripe deposit already paid:</div>
          <div style="font-weight:700;">${gbp(data.deposit)}</div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <div style="color:#111827;font-weight:800;">Payment received today:</div>
          <div style="font-weight:900;color:#047857;">${gbp(data.balanceDue)}</div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:10px;border-top:3px solid #10b981;">
          <div style="color:#111827;font-weight:900;">Total paid to date:</div>
          <div style="font-weight:900;color:#047857;">${gbp(data.total)}</div>
        </div>
      `
      : `
        <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:10px;border-top:3px solid #10b981;">
          <div style="color:#111827;font-weight:900;">Total paid:</div>
          <div style="font-weight:900;color:#047857;">${gbp(data.total)}</div>
        </div>
      `;

  return `
  <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:680px;margin:0 auto;padding:22px;color:#111827;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e5e7eb;padding-bottom:14px;">
      <div>
        <div style="font-size:28px;font-weight:900;color:#047857;">RECEIPT</div>
        <div style="margin-top:6px;color:#6b7280;">Payment confirmation for your records.</div>
      </div>
      <div style="text-align:right;color:#374151;">
        <div style="font-weight:800;">Elliot’s Mobile Music</div>
        <div style="font-size:13px;">Pudsey, UK</div>
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #f3f4f6;padding:16px 0;">
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;">RECEIPT TO</div>
        <div style="font-weight:800;">${escapeHtml(data.customerName || "—")}</div>
        <div style="color:#4b5563;font-size:13px;">${escapeHtml(data.customerAddress || "")}</div>
        <div style="color:#4b5563;font-size:13px;">${escapeHtml(data.customerEmail || "")}</div>
      </div>
      <div style="text-align:right;min-width:240px;">
        <div style="color:#374151;">Receipt No: <span style="font-weight:800;color:#111827;">${escapeHtml(data.receiptNo || "—")}</span></div>
        <div style="color:#374151;margin-top:6px;">Invoice No: <span style="font-weight:800;color:#111827;">${escapeHtml(data.invoiceNo || "—")}</span></div>
        <div style="color:#374151;margin-top:6px;">Paid Date: <span style="font-weight:800;color:#111827;">${escapeHtml(paidDate)}</span></div>
        <div style="color:#374151;margin-top:6px;">Method: <span style="font-weight:800;color:#111827;">${escapeHtml(data.paidMethod || "—")}</span></div>
        ${data.paidRef ? `<div style="color:#374151;margin-top:6px;">Ref: <span style="font-weight:800;color:#111827;">${escapeHtml(data.paidRef)}</span></div>` : ""}
      </div>
    </div>

    <div style="padding-top:16px;">
      <div style="font-weight:800;color:#374151;margin-bottom:10px;">Items Paid</div>

      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#ecfdf5;color:#6b7280;text-transform:uppercase;font-size:12px;">
            <th style="text-align:left;padding:10px 0;border-bottom:1px solid #e5e7eb;">Description</th>
            <th style="text-align:right;padding:10px 0;border-bottom:1px solid #e5e7eb;">Qty</th>
            <th style="text-align:right;padding:10px 0;border-bottom:1px solid #e5e7eb;">Unit</th>
            <th style="text-align:right;padding:10px 0;border-bottom:1px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${travelRow}
        </tbody>
      </table>

      <div style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <div style="color:#374151;">Total (package):</div>
          <div style="font-weight:700;">${gbp(data.total)}</div>
        </div>

        ${depositBlock}
      </div>

      <div style="margin-top:16px;color:#374151;font-size:13px;">
        Thank you — your payment has been received.
      </div>
    </div>
  </div>`;
}

function renderReceiptText(data) {
  const paidDate = data.paidAt ? new Date(data.paidAt).toLocaleString("en-GB") : "—";
  const lines = [];
  lines.push("RECEIPT / PAYMENT CONFIRMATION");
  lines.push("");
  lines.push(`Receipt No: ${data.receiptNo || "—"}`);
  lines.push(`Invoice No: ${data.invoiceNo || "—"}`);
  lines.push(`Paid Date: ${paidDate}`);
  lines.push(`Method: ${data.paidMethod || "—"}`);
  if (data.paidRef) lines.push(`Ref: ${data.paidRef}`);
  lines.push("");
  lines.push(`Receipt To: ${data.customerName || "—"}`);
  lines.push("");
  lines.push("Items:");
  (data.items || []).forEach((it) => {
    lines.push(`- ${it.desc} — ${it.qty} × £${Number(it.unit).toFixed(2)} = £${Number(it.amount).toFixed(2)}`);
  });
  if (Number(data.travelFee || 0) !== 0) lines.push(`- Travel Fee — £${Number(data.travelFee).toFixed(2)}`);
  lines.push("");
  lines.push(`Total (package): £${Number(data.total).toFixed(2)}`);
  if (Number(data.deposit || 0) > 0) {
    lines.push(`Stripe deposit already paid: £${Number(data.deposit).toFixed(2)}`);
    lines.push(`Payment received today: £${Number(data.balanceDue).toFixed(2)}`);
    lines.push(`Total paid to date: £${Number(data.total).toFixed(2)}`);
  } else {
    lines.push(`Total paid: £${Number(data.total).toFixed(2)}`);
  }
  lines.push("");
  lines.push("Thank you,");
  lines.push("Elliot’s Mobile Music");
  return lines.join("\n");
}

