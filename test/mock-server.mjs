// Local stand-in for api.signable.co.uk/v1, serving the fixtures with the documented offset/limit pagination.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_KEY = "sig-test-key-123";
export const AUTH = "Basic " + Buffer.from(`${API_KEY}:x`).toString("base64");

// Spec ErrorResponse and RouteNotFoundResponse shapes. Codes 10002 (bad auth), 10253 (unknown envelope), 10274/10275
// (wrong status for cancel/remind), 10250 (POST /envelopes rejected), 10053 (unknown contact) and 10060 (contact with
// no envelopes) come from the spec's examples for those endpoints. The template 404 (code 10300 below) and the 429
// (code 10000) are placeholders: the spec lists only a 200 for GET /templates/{template_fingerprint} and documents no
// 429 anywhere. (10050 is the ErrorResponse schema's own example code, not tied to any endpoint, and is not used here.)
const err = (http, code, message) => ({ http, code, message, company: null, url: `https://developer.signable.co.uk/errors/error-${code}`, detail: null });

// A contact that exists but has never been sent an envelope (the spec's documented 404, code 10060).
export const CONTACT_WITHOUT_ENVELOPES = "17300000";

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer. The suite starts with a single 429 on
  // GET /templates so the retry path is exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/templates", status: 429, times: 1, headers: { "Retry-After": "1" }, body: err(429, 10000, "Too many requests.") });
  let failures = [failure429()];
  // When set, every list page is capped at this many items even if more were requested, to imitate the
  // spec's LimitParam clause ("If more than 50 is requested, 10 will be returned instead") and any other
  // reason the API might answer with fewer items than asked for while total_* says more remain.
  let pageCap;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const routeNotFound = () => send(404, { message: `The route v1${path} could not be found.` });
    if (req.headers.authorization !== AUTH) return send(401, err(401, 10002, "Authentication failed. Please enter the correct API Key and password."));

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // LimitParam: min 1, max 50, default 10; "If more than 50 is requested, 10 will be returned instead."
    const requested = Number(url.searchParams.get("limit") || 10);
    const effective = requested > 50 || requested < 1 || !Number.isFinite(requested) ? 10 : Math.floor(requested);
    const limit = pageCap ? Math.min(effective, pageCap) : effective;
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    // The spec's list examples echo the requested limit (EnvelopeListResponseExample: limit 10 with three envelopes
    // and total 3) although EnvelopeListResponse describes `limit` as "the number of envelopes returned in this
    // response". The mock follows the examples; the client ignores the field either way.
    const paged = (items, key, totalKey, extra = {}) => {
      const data = items.slice(offset, offset + limit);
      return { http: 200, offset, limit, [totalKey]: String(items.length), ...extra(offset + data.length < items.length), [key]: data };
    };
    const noExtra = () => ({});

    const p = path.split("/").filter(Boolean);
    const m = req.method;

    if (p[0] === "envelopes") {
      if (m === "GET" && p.length === 1) {
        const status = url.searchParams.get("envelope_status");
        const q = url.searchParams.get("q")?.toLowerCase();
        const items = fx.envelopes.filter((e) => (!status || e.envelope_status === status) && (!q || e.envelope_title.toLowerCase().includes(q)));
        return send(200, paged(items, "envelopes", "total_envelopes", noExtra));
      }
      if (m === "POST" && p.length === 1) {
        const b = JSON.parse(body);
        // Spec POST /envelopes responses.400 example invalidRequest.
        if (!b.envelope_title || !Array.isArray(b.envelope_parties) || !Array.isArray(b.envelope_documents)) return send(400, err(400, 10250, "The envelope could not be sent. Please check your request and try again."));
        return send(202, {
          http: 202,
          message: `Your envelope with title ${b.envelope_title} will be processed and sent out.`,
          href: "https://api.signable.co.uk/v1/envelopes/0123456789abcdef0123456789abcdef",
          envelope_title: b.envelope_title,
          envelope_fingerprint: "0123456789abcdef0123456789abcdef",
          envelope_password_protect: false,
          envelope_requires_otp: b.envelope_parties.some((x) => x.party_mobile),
          envelope_queued: "2026-09-24T10:00:00+0000",
          envelope_all_at_once_enabled: b.envelope_all_at_once_enabled ?? true,
          envelope_parties: b.envelope_parties.map((x, i) => ({ party_id: String(45900000 + i), party_title: x.party_name, party_mobile_last4: x.party_mobile ? x.party_mobile.slice(-4) : null, party_password: null })),
        });
      }
      const env = fx.envelopes.find((e) => e.envelope_fingerprint === p[1]);
      if (!env) return send(404, err(404, 10253, "The envelope does not exist. Have you used the correct envelope fingerprint?"));
      if (m === "GET" && p.length === 2) return send(200, fx.envelopeDetails[env.envelope_fingerprint]);
      if (m === "PUT" && p.length === 3 && ["remind", "cancel", "expire"].includes(p[2])) {
        const action = p[2];
        if (env.envelope_status !== "sent") {
          const code = action === "cancel" ? 10274 : 10275;
          return send(400, err(400, code, `The envelope you are trying to ${action} doesn't have the correct status. The envelope can't be complete and must still be active.`));
        }
        const base = { http: 200, envelope_fingerprint: env.envelope_fingerprint, envelope_title: env.envelope_title };
        if (action === "remind") return send(200, { ...base, message: "The signing parties for this envelope have been reminded.", envelope_all_at_once_enabled: env.envelope_all_at_once_enabled });
        if (action === "cancel") return send(200, { ...base, message: "The envelope has been cancelled", envelope_status: "cancelled", envelope_processed: "2026-09-24T10:05:00+0000" });
        return send(200, { ...base, message: "The envelope has been expired", envelope_status: "expired", envelope_processed: "2026-09-24T10:05:00+0000" });
      }
    }

    if (p[0] === "templates" && m === "GET") {
      if (p.length === 1) return send(200, paged(fx.templates, "templates", "total_templates", noExtra));
      const t = fx.templates.find((x) => x.template_fingerprint === p[1]);
      if (!t) return send(404, err(404, 10300, "The template does not exist. Have you used the correct template fingerprint?"));
      if (p.length === 2) return send(200, { http: 200, ...t });
    }

    if (p[0] === "contacts" && m === "GET") {
      if (p.length === 1) {
        // ContactsListResponse documents a `next` URL "returned when another page of contacts is available".
        return send(200, paged(fx.contacts, "contacts", "total_contacts", (more) => (more ? { next: `https://api.signable.co.uk/v1/contacts?offset=${offset + limit}&limit=${limit}` } : {})));
      }
      if (!/^\d+$/.test(p[1])) return routeNotFound();
      const c = fx.contacts.find((x) => x.contact_id === p[1]);
      if (!c) return send(404, err(404, 10053, "The contact does not exist. Have you used the correct contact ID?"));
      if (p.length === 2) return send(200, { http: 200, ...c, contact_id: Number(c.contact_id) }); // ContactGetResponse: contact_id is an integer
      if (p.length === 3 && p[2] === "envelopes") {
        const list = fx.contactEnvelopes[c.contact_id];
        // Spec GET /contacts/{contact_id}/envelopes: 404 "Contact has no envelopes", example noContactEnvelopes.
        if (!list || list.length === 0) return send(404, err(404, 10060, "This contact hasn't been sent any envelopes."));
        return send(200, paged(list, "envelopes", "total_envelopes", noExtra));
      }
    }

    if (p[0] === "users" && m === "GET" && p.length === 1) return send(200, paged(fx.users, "users", "total_users", noExtra));

    return routeNotFound();
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Cap every list page at `n` items (undefined removes the cap). */
  const setPageCap = (n) => {
    pageCap = n;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, setPageCap })));
}
