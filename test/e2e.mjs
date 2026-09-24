// End-to-end test: fixtures are validated against Signable's published OpenAPI schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_KEY, AUTH, CONTACT_WITHOUT_ENVELOPES } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://developers.signable.app/_bundle/openapi.yaml";
if (!existsSync(`${root}spec.yaml`)) {
  try {
    writeFileSync(`${root}spec.yaml`, await (await fetch(SPEC_URL)).text());
  } catch (err) {
    console.error(`Could not download the Signable spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.yaml ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = parse(readFileSync(`${root}spec.yaml`, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "sig", components: spec.components });
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`sig#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `sig#/components/schemas/${schema}` }) : ajv.compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (schemaName, obj, id = "") => validateWith(schemaName, obj, `${schemaName} ${id}`);

console.log("fixtures vs OpenAPI spec");
await check("envelope summaries, envelope details, templates, contacts, contact envelopes, users", async () => {
  fx.envelopes.forEach((e) => validate("EnvelopeSignedSummary", e, e.envelope_fingerprint));
  Object.values(fx.envelopeDetails).forEach((e) => validate("EnvelopeDetailResponse", e, e.envelope_fingerprint));
  assert.equal(Object.keys(fx.envelopeDetails).length, fx.envelopes.length);
  fx.templates.forEach((t) => validate("TemplateSummary", t, t.template_fingerprint));
  fx.contacts.forEach((c) => validate("Contact", c, c.contact_id));
  Object.values(fx.contactEnvelopes).flat().forEach((e) => validate("ContactEnvelopeSummary", e, e.envelope_fingerprint));
  fx.users.forEach((u) => validate("User", u, u.user_id));
});

// 2. The mock's responses (lists, single records, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, setPageCap } = await startMock();
const base = `http://127.0.0.1:${port}/v1`;
const raw = async (method, path, init = {}) => {
  const res = await fetch(base + path, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, ...init });
  return { status: res.status, json: await res.json() };
};
await check("mock responses match the documented list, detail and error schemas", async () => {
  // Several response schemas mark nothing as required, so a schema pass alone would not prove the
  // documented keys are present; assert them explicitly.
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  const envelopes = (await raw("GET", "/envelopes?limit=50")).json;
  validate("EnvelopeListResponse", envelopes);
  keys(envelopes, "http", "offset", "limit", "total_envelopes", "envelopes");
  assert.equal(envelopes.limit, 50, "list responses echo the requested limit, as in every spec example");
  validate("EnvelopeDetailResponse", (await raw("GET", `/envelopes/${fx.JOHN_ST}`)).json);
  const limited = await raw("GET", "/templates"); // the mock answers the first templates call with a 429
  assert.equal(limited.status, 429);
  validate("ErrorResponse", limited.json);
  const templates = (await raw("GET", "/templates")).json;
  validate("TemplatesListResponse", templates);
  keys(templates, "http", "offset", "limit", "total_templates", "templates");
  const template = (await raw("GET", `/templates/${fx.NDA_TPL}`)).json;
  validate("TemplateGetResponse", template);
  keys(template, "http", "template_id", "template_fingerprint", "template_title", "template_parties");
  const contacts = (await raw("GET", "/contacts?limit=50")).json;
  validate("ContactsListResponse", contacts);
  keys(contacts, "http", "offset", "limit", "total_contacts", "next", "contacts");
  const contact = (await raw("GET", `/contacts/${fx.ABBY}`)).json;
  validate("ContactGetResponse", contact);
  keys(contact, "http", "contact_id", "contact_name", "contact_email", "contact_outstanding_documents", "contact_created");
  const contactEnvelopes = (await raw("GET", `/contacts/${fx.ABBY}/envelopes`)).json;
  validate("ContactEnvelopesListResponse", contactEnvelopes);
  keys(contactEnvelopes, "http", "offset", "limit", "total_envelopes", "envelopes");
  const users = (await raw("GET", "/users")).json;
  validate("UsersListResponse", users);
  keys(users, "http", "offset", "limit", "total_users", "users");
  const badSend = await raw("POST", "/envelopes", { body: JSON.stringify({ envelope_title: "no parties" }) });
  assert.equal(badSend.status, 400);
  validate("ErrorResponse", badSend.json);
  assert.equal(badSend.json.code, spec.paths["/envelopes"].post.responses["400"].content["application/json"].examples.invalidRequest.value.code);
  validate("EnvelopeRemindResponse", (await raw("PUT", `/envelopes/${fx.JOHN_ST}/remind`)).json);
  validate("EnvelopeCancelResponse", (await raw("PUT", `/envelopes/${fx.JOHN_ST}/cancel`)).json);
  validate("EnvelopeExpireResponse", (await raw("PUT", `/envelopes/${fx.JOHN_ST}/expire`)).json);
  validate("ErrorResponse", (await raw("GET", "/envelopes/0000000000000000000000000000dead")).json);
  validate("ErrorResponse", (await raw("PUT", `/envelopes/${fx.NDA_ENV}/cancel`)).json);
  validate("RouteNotFoundResponse", (await raw("GET", "/contacts/abc")).json);
  // The two contact 404s the spec documents by example: unknown contact (10053) and contact with no envelopes (10060).
  const unknownContact = await raw("GET", "/contacts/1");
  assert.equal(unknownContact.status, 404);
  validate("ErrorResponse", unknownContact.json);
  assert.equal(unknownContact.json.code, spec.paths["/contacts/{contact_id}"].get.responses["404"].content["application/json"].examples.contactNotFound.value.code);
  assert.equal((await raw("GET", `/contacts/${CONTACT_WITHOUT_ENVELOPES}`)).status, 200);
  const noEnvelopes = await raw("GET", `/contacts/${CONTACT_WITHOUT_ENVELOPES}/envelopes`);
  assert.equal(noEnvelopes.status, 404);
  validate("ErrorResponse", noEnvelopes.json);
  assert.equal(noEnvelopes.json.code, spec.paths["/contacts/{contact_id}/envelopes"].get.responses["404"].content["application/json"].examples.noContactEnvelopes.value.code);
  const send = await raw("POST", "/envelopes", { body: JSON.stringify(spec.components.examples.EnvelopeSendTemplateRequestExample.value) });
  assert.equal(send.status, 202);
  validate("EnvelopeSendResponse", send.json);
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal SIGNABLE_ALLOW_WRITES value; null leaves it unset.
const connect = async (key, writes = "true") => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, SIGNABLE_API_KEY: key, SIGNABLE_BASE_URL: base };
  delete env.SIGNABLE_ALLOW_WRITES;
  if (writes !== null) env.SIGNABLE_ALLOW_WRITES = writes;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [`${root}dist/index.js`],
      env,
      stderr: "ignore",
    }),
  );
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);

const client = await connect(API_KEY);
console.log("mcp tools");

await check("tools/list exposes 11 tools; reads are read-only, cancel/expire destructive, remind/send not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "cancel_envelope", "expire_envelope", "find_contacts", "get_contact_envelopes", "get_envelope", "get_template",
    "list_envelopes", "list_templates", "list_users", "remind_envelope", "send_envelope_from_template",
  ]);
  const writes = new Set(["send_envelope_from_template", "remind_envelope", "cancel_envelope", "expire_envelope"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !writes.has(t.name), `${t.name} readOnlyHint`);
    if (writes.has(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "cancel_envelope" || t.name === "expire_envelope", `${t.name} destructiveHint`);
  }
});

await check("list_envelopes pages by offset (0, 50) and stops at the documented total", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_envelopes", { max_results: 200 });
  assert.equal(data.count, 100);
  assert.equal(data.total_matching, 100);
  assert.equal(data.complete, true);
  assert.deepEqual(since(n).map((r) => [r.query.offset, r.query.limit]), [["0", "50"], ["50", "50"]], "two pages of 50, no third call once total reached");
  assert.equal(data.envelopes[0].fingerprint, fx.JOHN_ST);
  assert.equal(data.envelopes[0].status, "sent");
  assert.deepEqual(data.envelopes[0].parties.map((p) => p.name), ["Abby Signable", "Sam Evans", "Bristol Solicitors"]);
  assert.equal(data.envelopes[0].parties[0].otp_required, true);
  assert.equal(data.envelopes[0].parties[0].mobile_last4, undefined, "mobile digits only on request");
  assert.equal(data.envelopes[0].parties[0].password, undefined, "envelope password only on request");
  assert.equal(data.envelopes[2].signed_pdf_url, fx.envelopes[2].envelope_signed_pdf);
});

await check("list_envelopes honours max_results and reports how to continue", async () => {
  const { data } = await call(client, "list_envelopes", { max_results: 30 });
  assert.equal(data.count, 30);
  assert.equal(data.complete, false);
  assert.match(data.note, /offset 30/);
  const next = await call(client, "list_envelopes", { max_results: 30, offset: 30 });
  assert.equal(next.data.envelopes[0].fingerprint, fx.envelopes[30].envelope_fingerprint);
  assert.equal(requests.at(-1).query.offset, "30");
});

await check("list_envelopes passes envelope_status and q through as documented", async () => {
  const byStatus = await call(client, "list_envelopes", { status: "sent" });
  assert.deepEqual(byStatus.data.envelopes.map((e) => e.fingerprint), [fx.JOHN_ST]);
  assert.equal(requests.at(-1).query.envelope_status, "sent");
  assert.equal(requests.at(-1).query.q, undefined);
  const byTitle = await call(client, "list_envelopes", { q: "john street" });
  assert.deepEqual(byTitle.data.envelopes.map((e) => e.fingerprint), [fx.JOHN_ST]);
  assert.equal(requests.at(-1).query.q, "john street");
  const both = await call(client, "list_envelopes", { status: "signed", q: "acme" });
  assert.deepEqual(both.data.envelopes.map((e) => e.fingerprint), [fx.NDA_ENV]);
  assert.deepEqual([requests.at(-1).query.envelope_status, requests.at(-1).query.q], ["signed", "acme"]);
  assert.equal(both.data.envelopes[0].redirect_url, "https://example.com/thanks?email=[email redacted]", "an email in the redirect URL is redacted by default");
  const withContact = await call(client, "list_envelopes", { status: "signed", q: "acme", include_contact_details: true });
  assert.equal(withContact.data.envelopes[0].redirect_url, "https://example.com/thanks?email=priya.shah@example.com");
});

await check("get_envelope redacts party emails, mobile digits, IPs, and emails and phone numbers inside history, fields and metadata by default", async () => {
  const { data } = await call(client, "get_envelope", { envelope_fingerprint: fx.JOHN_ST });
  const e = data.envelope;
  assert.equal(e.title, "17 John Street Tenancy Contract - 25th Aug 2026");
  assert.deepEqual(e.parties.map((p) => [p.name, p.status, p.role]), [["Abby Signable", "in progress", "signer"], ["Sam Evans", "signed", "signer"], ["Bristol Solicitors", "pending", "copy"]]);
  assert.equal(e.parties[0].contact_id, fx.ABBY);
  for (const p of e.parties) assert.equal(p.email, undefined);
  assert.equal(e.parties[0].mobile_last4, undefined);
  assert.equal(e.documents[0].fields.length, 6);
  assert.equal(e.documents[0].fields[1].value, "Reach me at [email redacted]");
  assert.equal(e.documents[0].fields[3].value, "Call me on [phone redacted]");
  assert.equal(e.documents[0].fields[4].value, "Landlord [phone redacted], office [phone redacted], agent [phone redacted], alt [phone redacted], fax [phone redacted]", "the +44 (0), bracketed area code, 00-prefixed, extra-spaced and dot-separated forms are all redacted");
  assert.equal(e.documents[0].fields[4].merge_label, "Other numbers ([email redacted])", "an email in a merge-field label is redacted");
  assert.equal(e.documents[0].fields[5].type, "upload");
  assert.equal(e.documents[0].fields[5].value, "[uploaded file: download link available with include_contact_details]", "a signer's uploaded file link is withheld by default");
  assert.equal(e.history[1].detail, "Sent the envelope to Abby Signable ([email redacted]) for signing");
  assert.equal(e.history[3].detail, "OTP sent to [phone redacted]");
  assert.equal(e.history[1].ip, undefined);
  assert.equal(e.history[1].user_agent, undefined);
  const { deep, ...meta } = e.meta;
  assert.deepEqual(meta, { internal_id: "JS17", VIP: false, landlord_contact: "[email redacted]", phone: "[phone redacted]", nested: { deep: "call [phone redacted] or mail [email redacted]" } });
  // 24 levels of nesting under meta.deep: objects at depth 0-19 (meta itself is depth 0, deep is depth 1) are walked,
  // the object at depth 20 is replaced by a placeholder rather than returned as stored.
  let node = deep;
  for (let i = 0; i < 18; i++) node = node.n;
  assert.equal(typeof node, "object", "depth 19 is still walked");
  assert.match(node.n, /^\[metadata nested deeper than 20 levels omitted/, "metadata below the depth limit is replaced, not passed through");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example.com"), "no email address anywhere in the default output");
  assert.ok(!text.includes(fx.UPLOAD_URL) && !text.includes("download/field"), "upload URL leaked in the default output");
  for (const phone of ["07700 900789", "+447700900321", "+44 7700 900123", "07700 900456", "07700 900999", "(0)7700 900123", "(0117) 496 0000", "0044 20 7946 0958", "07 700 900 789", "07700.900555", "7946 0958", "900123"]) assert.ok(!text.includes(phone), `phone number ${phone} leaked in the default output`);
  assert.ok(text.includes(fx.JOHN_ST) && text.includes("452902790") && text.includes("45631121"), "fingerprints and numeric IDs are not mistaken for phone numbers");
});

await check("get_envelope returns contact details when explicitly asked", async () => {
  const { data } = await call(client, "get_envelope", { envelope_fingerprint: fx.JOHN_ST, include_contact_details: true });
  const e = data.envelope;
  assert.equal(e.parties[0].email, "abby@example.com");
  assert.equal(e.parties[0].mobile_last4, "5678");
  assert.equal(e.history[1].detail, "Sent the envelope to Abby Signable (abby@example.com) for signing");
  assert.equal(e.history[3].detail, "OTP sent to +447700900321");
  assert.equal(e.history[1].ip, "147.147.97.34");
  assert.equal(e.documents[0].fields[1].value, "Reach me at sam.evans@example.com");
  assert.equal(e.documents[0].fields[3].value, "Call me on 07700 900789");
  assert.equal(e.documents[0].fields[4].value, fx.envelopeDetails[fx.JOHN_ST].envelope_documents[0].document_fields[4].field_value);
  assert.equal(e.documents[0].fields[4].merge_label, "Other numbers (merge@example.com)");
  assert.equal(e.documents[0].fields[5].value, fx.UPLOAD_URL, "the upload link is returned on request");
  assert.deepEqual(e.meta, fx.envelopeDetails[fx.JOHN_ST].envelope_meta, "metadata is returned as stored on request, including the deeply nested part");
});

await check("list_templates (after a 429 retry that waits for Retry-After) and get_template expose parties and merge fields", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_templates");
  const tries = since(n).filter((r) => r.path === "/templates");
  assert.equal(tries.length, 2, "templates should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.templates.map((t) => t.title), ["Tenancy Contract 2025 v2", "Mutual NDA", "Supplier onboarding (return to [email redacted] or [phone redacted])"]);
  assert.equal(data.complete, true);
  assert.deepEqual(data.templates[2].parties.map((p) => [p.name, p.merge_fields[0].label]), [["Supplier ([email redacted])", "Notes (queries to [phone redacted])"]], "template party and merge-field labels are redacted");
  assert.ok(!JSON.stringify(data).includes("@example.com") && !JSON.stringify(data).includes("0117 496") && !JSON.stringify(data).includes("07700 900111"));
  const supplier = await call(client, "get_template", { template_fingerprint: fx.SUPPLIER_TPL });
  assert.equal(supplier.data.template.title, "Supplier onboarding (return to [email redacted] or [phone redacted])");
  const one = await call(client, "get_template", { template_fingerprint: fx.TENANCY_TPL });
  assert.deepEqual(one.data.template.parties.map((p) => [p.party_id, p.name]), [["20748256", "Tenant"], ["20748255", "Landlord"]]);
  assert.deepEqual(one.data.template.parties[0].merge_fields, [{ field_id: "454958773", label: "Rent notes", type: "text" }]);
  assert.equal(one.data.template.pages, 2);
});

await check("find_contacts scans 50-per-page (offsets 0, 50, 100) and matches name or email, emails hidden by default", async () => {
  const n = requests.length;
  const byName = await call(client, "find_contacts", { query: "sam evans" });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.offset, r.query.limit]), [["/contacts", "0", "50"], ["/contacts", "50", "50"], ["/contacts", "100", "50"]]);
  assert.deepEqual(byName.data.matches.map((m) => m.contact_id), ["17241370"]);
  assert.equal(byName.data.matches[0].name, "Sam Evans");
  assert.equal(byName.data.matches[0].email, undefined);
  assert.equal(byName.data.contacts_scanned, 121);
  const byEmail = await call(client, "find_contacts", { query: "priya.shah@", include_contact_details: true });
  assert.deepEqual(byEmail.data.matches.map((m) => m.email), ["priya.shah@example.com"]);
  const emailInName = await call(client, "find_contacts", { query: "lee chen" });
  assert.equal(emailInName.data.matches[0].name, "Lee Chen ([email redacted])", "an email typed into a name is redacted by default");
  assert.ok(!emailInName.text.includes("lee.chen@"));
  const emailInNameRaw = await call(client, "find_contacts", { query: "lee chen", include_contact_details: true });
  assert.equal(emailInNameRaw.data.matches[0].name, "Lee Chen (lee.chen@example.net)");
  const partial = await call(client, "find_contacts", { query: "person1", max_results: 3, max_pages: 1 });
  assert.equal(partial.data.matches.length, 3);
  assert.match(partial.data.note, /first 50 contacts/);
});

await check("get_contact_envelopes lists a contact's document history", async () => {
  const { data } = await call(client, "get_contact_envelopes", { contact_id: fx.ABBY });
  assert.equal(data.contact.name, "Abby Signable");
  assert.equal(data.contact.email, undefined);
  assert.deepEqual(data.envelopes.map((e) => [e.fingerprint, e.status]), [[fx.JOHN_ST, "sent"], [fx.DRAFT_ENV, "draft"]]);
  assert.equal(data.total, 2);
  assert.equal(requests.at(-1).path, `/contacts/${fx.ABBY}/envelopes`);
});

await check("get_contact_envelopes turns the documented 404 for a contact with no envelopes into an empty list, but not an unknown contact", async () => {
  const n = requests.length;
  const { res, data } = await call(client, "get_contact_envelopes", { contact_id: CONTACT_WITHOUT_ENVELOPES });
  assert.ok(!res.isError, `expected success, got: ${res.content[0].text}`);
  assert.deepEqual(since(n).map((r) => r.path), [`/contacts/${CONTACT_WITHOUT_ENVELOPES}`, `/contacts/${CONTACT_WITHOUT_ENVELOPES}/envelopes`], "contact fetched first, then the list");
  assert.equal(data.contact.contact_id, CONTACT_WITHOUT_ENVELOPES);
  assert.deepEqual([data.count, data.total, data.complete, data.envelopes], [0, 0, true, []]);
  assert.match(data.note, /has not been sent any envelopes \(error code 10060\)/);
  const unknown = await call(client, "get_contact_envelopes", { contact_id: "1" });
  assert.ok(unknown.res.isError);
  assert.match(unknown.text, /Not found: \/contacts\/1\. Check the fingerprint or ID\. The contact does not exist.*error code 10053/);
  assert.equal(requests.at(-1).path, "/contacts/1", "no envelopes call for an unknown contact");
  // The empty-list reading only applies to the first page at offset 0; a 404 at a caller-supplied offset is passed on.
  const atOffset = await call(client, "get_contact_envelopes", { contact_id: CONTACT_WITHOUT_ENVELOPES, offset: 5 });
  assert.ok(atOffset.res.isError, "a 404 at offset 5 must not be reported as an empty first page");
  assert.match(atOffset.text, /Not found: \/contacts\/17300000\/envelopes.*error code 10060/);
  const pastEnd = await call(client, "get_contact_envelopes", { contact_id: fx.ABBY, offset: 5 });
  assert.deepEqual([pastEnd.data.count, pastEnd.data.total, pastEnd.data.complete], [0, 2, true], "the mock answers an offset past the end with 200 and an empty list");
});

await check("list_users maps role_id to role names and hides emails unless asked", async () => {
  const { data } = await call(client, "list_users");
  assert.deepEqual(data.users.map((u) => [u.name, u.role]), [["Alex Example", "Super-Admin"], ["Jo Bloggs", "User"]]);
  assert.equal(data.users[0].email, undefined);
  const withEmail = await call(client, "list_users", { include_contact_details: true });
  assert.equal(withEmail.data.users[1].email, "jo@example.com");
});

const sendSchema = spec.paths["/envelopes"].post.requestBody.content["application/json"].schema;
const templateBranch = sendSchema.oneOf.find((s) => s.title === "Send Template Request");
const goodSend = {
  template_fingerprint: fx.TENANCY_TPL,
  title: "12 Melbourne Road tenancy",
  parties: [
    { name: "Sam Evans", email: "sam.evans@example.com", party_id: "20748256", message: "Please sign by Friday" },
    { name: "Alex Landlord", email: "alex@example.com", party_id: "20748255", mobile: "+447712345678" },
    { name: "Bristol Solicitors", email: "office@example.com", party_id: "20750393", role: "copy" },
  ],
  merge_fields: [{ field_id: "454958773", value: "Breakables not included" }],
  auto_expire_hours: 144,
};

await check("send_envelope_from_template posts a body that validates against the spec's Send Template Request", async () => {
  const n = requests.length;
  const { data } = await call(client, "send_envelope_from_template", goodSend);
  assert.equal(data.result, "queued for sending");
  assert.equal(data.envelope_fingerprint, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`GET /templates/${fx.TENANCY_TPL}`, "POST /envelopes"]);
  const post = requests.at(-1);
  validateWith(sendSchema, post.body, "POST /envelopes body vs requestBody schema (oneOf)");
  validateWith(templateBranch, post.body, "POST /envelopes body vs Send Template Request");
  assert.equal(post.body.is_draft, false);
  assert.equal(post.body.envelope_auto_expire_hours, 144);
  assert.deepEqual(post.body.envelope_parties[0], { party_name: "Sam Evans", party_email: "sam.evans@example.com", party_id: "20748256", party_role: "signer", party_message: "Please sign by Friday" });
  assert.equal(post.body.envelope_parties[1].party_mobile, "+447712345678");
  assert.equal(post.body.envelope_parties[2].party_role, "copy");
  assert.deepEqual(post.body.envelope_documents, [
    { document_title: "Tenancy Contract 2025 v2", document_template_fingerprint: fx.TENANCY_TPL, document_merge_fields: [{ field_id: "454958773", field_value: "Breakables not included" }] },
  ]);
  const draft = await call(client, "send_envelope_from_template", { ...goodSend, is_draft: true });
  assert.equal(draft.data.result, "saved as draft");
  assert.equal(requests.at(-1).body.is_draft, true);
});

await check("send_envelope_from_template refuses locally when template parties or merge fields do not match", async () => {
  const n = requests.length;
  const missing = await call(client, "send_envelope_from_template", { ...goodSend, parties: goodSend.parties.slice(0, 1) });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not sent.*"Landlord" \(party_id 20748255\) has no signer/);
  const unknownParty = await call(client, "send_envelope_from_template", { ...goodSend, parties: [{ ...goodSend.parties[0], party_id: "99" }, goodSend.parties[1]] });
  assert.match(unknownParty.text, /Party 99 \(Sam Evans\) is not defined in template/);
  const unknownField = await call(client, "send_envelope_from_template", { ...goodSend, merge_fields: [{ field_id: "1", value: "x" }] });
  assert.match(unknownField.text, /Merge field 1 is not in template .* 454958773 "Rent notes"/);
  const copyWithMobile = await call(client, "send_envelope_from_template", { ...goodSend, parties: [...goodSend.parties.slice(0, 2), { ...goodSend.parties[2], mobile: "+447712345678" }] });
  assert.ok(copyWithMobile.res.isError, "a copy recipient with a mobile number must be refused (spec: do not provide party_mobile for copy recipients)");
  assert.match(copyWithMobile.text, /Not sent.*Copy recipient Bristol Solicitors was given a mobile number/);
  assert.ok(since(n).every((r) => r.method === "GET"), "no POST was made for a refused send");
});

await check("send_envelope_from_template redacts template labels in its refusal but posts the stored template title", async () => {
  const supplierSend = { template_fingerprint: fx.SUPPLIER_TPL, title: "Acme supplier onboarding", parties: [{ name: "Priya Shah", email: "priya.shah@example.com", party_id: "20760001" }] };
  const refused = await call(client, "send_envelope_from_template", { ...supplierSend, merge_fields: [{ field_id: "1", value: "x" }] });
  assert.ok(refused.res.isError);
  assert.match(refused.text, /Not sent\. Merge field 1 is not in template "Supplier onboarding \(return to \[email redacted\] or \[phone redacted\]\)"\. Its merge fields are: 455000001 "Notes \(queries to \[phone redacted\]\)" \(Supplier \(\[email redacted\]\)\)/);
  assert.ok(!refused.text.includes("@example.com") && !refused.text.includes("07700 900111") && !refused.text.includes("0117 496 0000"), "the refusal message leaks template contact details");
  const sent = await call(client, "send_envelope_from_template", supplierSend);
  assert.ok(!sent.res.isError, sent.text);
  assert.equal(requests.at(-1).body.envelope_documents[0].document_title, fx.templates[2].template_title, "the document title posted to Signable is the stored title, not the redacted one");
});

await check("remind, cancel and expire hit the documented PUT endpoints; wrong status gives the API's message", async () => {
  for (const [tool, action] of [["remind_envelope", "remind"], ["cancel_envelope", "cancel"], ["expire_envelope", "expire"]]) {
    const { data } = await call(client, tool, { envelope_fingerprint: fx.JOHN_ST });
    assert.equal(requests.at(-1).method, "PUT");
    assert.equal(requests.at(-1).path, `/envelopes/${fx.JOHN_ST}/${action}`);
    assert.equal(requests.at(-1).body, undefined);
    assert.equal(data.envelope_fingerprint, fx.JOHN_ST);
    if (action !== "remind") assert.equal(data.status, action === "cancel" ? "cancelled" : "expired");
  }
  const wrong = await call(client, "cancel_envelope", { envelope_fingerprint: fx.NDA_ENV });
  assert.ok(wrong.res.isError);
  assert.match(wrong.text, /\(400\).*doesn't have the correct status.*error code 10274/);
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_envelope", { envelope_fingerprint: "../envelopes" }],
    ["get_template", { template_fingerprint: "has space" }],
    ["get_contact_envelopes", { contact_id: "abc" }],
    ["cancel_envelope", { envelope_fingerprint: "" }],
    ["send_envelope_from_template", { ...goodSend, parties: [{ ...goodSend.parties[0], party_id: "20748256/x" }] }],
    ["send_envelope_from_template", { ...goodSend, merge_fields: [{ field_id: "bad id", value: "x" }] }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_envelope", { envelope_fingerprint: "0000000000000000000000000000dead" });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/envelopes\/0000000000000000000000000000dead\. Check the fingerprint or ID\..*does not exist/);
  const missingContact = await call(client, "get_contact_envelopes", { contact_id: "1" });
  assert.match(missingContact.text, /Not found: \/contacts\/1/);
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_templates");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/templates").length, 3, "exactly three attempts");
  assert.match(text, /Signable rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once, naming the wait", async () => {
  arm429({ retryAfter: "600" });
  const n = requests.length;
  const { res, text } = await call(client, "list_templates");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/templates").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(text, /asked to wait 600 seconds before retrying GET \/templates \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  arm429({ retryAfter: new Date(Date.now() + 1500).toUTCString() }); // HTTP-dates have 1 s resolution: 0.5 to 1.5 s ahead
  const n = requests.length;
  const { res } = await call(client, "list_templates");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/templates");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 400 && gap < 1900, `retry should wait until the given date (0.5 to 1.5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a fractional Retry-After is read as seconds, not as a date", async () => {
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which used to mean "retry now"
  const n = requests.length;
  const { res } = await call(client, "list_templates");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/templates");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a GET that keeps failing with 503 gives up after three attempts with advice and without the gateway's HTML", async () => {
  arm({ method: "GET", path: "/users", status: 503, times: 3, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const { res, text } = await call(client, "list_users");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/users").length, 3);
  assert.match(text, /Signable returned 503 for GET \/users 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!text.includes("<html>"), "gateway HTML should not be passed on");
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list", async () => {
  arm({ method: "GET", path: "/envelopes", status: 200 }); // the mock answers with an HTML page
  const { res, text } = await call(client, "list_envelopes");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/envelopes but the body was not JSON \(starts with: "<html>.*Check SIGNABLE_BASE_URL/);
  disarm();
  const ok = await call(client, "list_envelopes", { max_results: 1 });
  assert.ok(!ok.res.isError);
});

await check("a 429 on POST /envelopes is retried once (a rate-limited request is assumed not to have been processed)", async () => {
  arm({ method: "POST", path: "/envelopes", status: 429, headers: { "Retry-After": "0" }, body: { http: 429, code: 10000, message: "Too many requests.", company: null, url: "https://developer.signable.co.uk/errors/error-10000", detail: null } });
  const n = requests.length;
  const { res, data } = await call(client, "send_envelope_from_template", goodSend);
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.result, "queued for sending");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "one retry after the 429");
  disarm();
});

await check("when pages come back shorter than requested but total_* says more remain, paging continues from the returned count", async () => {
  setPageCap(10); // LimitParam: "If more than 50 is requested, 10 will be returned instead"
  const n = requests.length;
  const { data } = await call(client, "list_envelopes", { max_results: 200 });
  assert.equal(data.count, 100, "all 100 envelopes collected across short pages");
  assert.equal(data.total_matching, 100);
  assert.equal(data.complete, true);
  assert.equal(data.note, undefined);
  assert.deepEqual(since(n).map((r) => r.query.offset), Array.from({ length: 10 }, (_, i) => String(i * 10)), "ten pages of ten, offset advancing by the number returned");
  const capped = await call(client, "find_contacts", { query: "person", max_pages: 2 });
  assert.equal(capped.data.contacts_scanned, 20);
  assert.match(capped.data.note, /Only the first 20 contacts were scanned/, "hitting max_pages before the total reports an incomplete scan");
  setPageCap(undefined);
});

await check("a 502 on a GET is retried once, even with a non-JSON gateway body", async () => {
  arm({ method: "GET", path: "/users", status: 502, headers: { "Retry-After": "1" } });
  const n = requests.length;
  const { res, data } = await call(client, "list_users");
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 2);
  assert.equal(since(n).filter((r) => r.path === "/users").length, 2);
  disarm();
});

await check("a 502 on POST /envelopes is never retried and the error says to check list_envelopes first", async () => {
  arm({ method: "POST", path: "/envelopes", status: 502, headers: { "Retry-After": "1" } });
  const n = requests.length;
  const { res, text } = await call(client, "send_envelope_from_template", goodSend);
  assert.ok(res.isError, "a 502 on a send must surface as an error, not a success");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 1, "exactly one POST /envelopes");
  assert.match(text, /returned 502 for POST \/envelopes\. The request was not retried because it may already have been processed: check with list_envelopes/);
  disarm();
  const remind = await call(client, "remind_envelope", { envelope_fingerprint: fx.JOHN_ST });
  assert.ok(!remind.res.isError, "mock back to normal");
  arm({ method: "PUT", path: `/envelopes/${fx.JOHN_ST}/remind`, status: 503 });
  const m = requests.length;
  const failedRemind = await call(client, "remind_envelope", { envelope_fingerprint: fx.JOHN_ST });
  assert.ok(failedRemind.res.isError);
  assert.equal(since(m).length, 1, "a PUT action is not retried after a 5xx either");
  assert.match(failedRemind.text, /returned 503 for PUT .*not retried.*check with get_envelope/);
  disarm();
});

await check("every request used Basic auth base64(key:x) and a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 30);
  for (const r of requests) {
    assert.equal(r.auth, `Basic ${Buffer.from(`${API_KEY}:x`).toString("base64")}`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-f]{32}(?=\/|$)/g, "/{fp}").replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    ["GET /contacts", "GET /contacts/{id}", "GET /contacts/{id}/envelopes", "GET /envelopes", "GET /envelopes/{fp}", "GET /templates", "GET /templates/{fp}", "GET /users", "POST /envelopes", "PUT /envelopes/{fp}/cancel", "PUT /envelopes/{fp}/expire", "PUT /envelopes/{fp}/remind"],
  );
});
await client.close();

await check("writes are off when SIGNABLE_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(API_KEY, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => ["send_envelope_from_template", "remind_envelope", "cancel_envelope", "expire_envelope"].includes(t.name)), [], `writes exposed with SIGNABLE_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, 7);
    await ro.close();
  }
});

await check("a wrong API key gives an actionable error", async () => {
  const bad = await connect("sig-wrong-key");
  const { res, text } = await call(bad, "list_envelopes");
  assert.ok(res.isError);
  assert.match(text, /rejected the API key \(401\)\. Check SIGNABLE_API_KEY/);
  await bad.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock.`);
