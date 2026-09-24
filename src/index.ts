#!/usr/bin/env node
// Signable MCP server: lets Claude, ChatGPT and other MCP clients work with a Signable e-signature account.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SignableClient, SignableError, PAGE_SIZE } from "./client.js";
import * as fmt from "./format.js";

const apiKey = process.env.SIGNABLE_API_KEY?.trim();
if (!apiKey) {
  console.error("SIGNABLE_API_KEY is not set. Use the API key from your Signable account.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.SIGNABLE_ALLOW_WRITES ?? "");
const api = new SignableClient(apiKey, process.env.SIGNABLE_BASE_URL || undefined);

const server = new McpServer(
  { name: "signable", version: "0.1.0" },
  {
    instructions: [
      "Tools for a Signable e-signature account (envelopes, templates, contacts, users).",
      "Envelopes and templates are identified by a fingerprint (32 lowercase hex characters in all but one of Signable's examples); contacts, parties, fields and users by numeric IDs.",
      "Envelope statuses: processing, failed, draft, sent, signed, cancelled, expired, rejected, verify.",
      "Typical flow for 'what is still waiting for a signature?': list_envelopes with status 'sent', then get_envelope for each fingerprint to see which party has not signed.",
      "Before sending from a template, call get_template to learn its party IDs and merge field IDs.",
      "Signer and user email addresses are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// The spec types fingerprints as plain strings and documents no format. All but one of its examples
// are 32 lowercase hex characters (one, in the webhooks section, is 33), so only reject values that
// could not be a path segment: letters, digits, "_" and "-", up to 64 characters.
const fingerprint = (what: string) =>
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, `${what} fingerprints are short strings of letters, digits, _ and -, e.g. 584ea8b41b0d4c17a96b967433b211e6`);
// contact_id is typed as an integer path parameter in the spec.
const contactId = z.string().regex(/^\d{1,20}$/, "Contact IDs are numeric, e.g. 17224150");
// party_id and field_id are typed as plain strings; every example is a digit string, but the format is
// not fixed by the spec, so the same loose path-segment rule applies.
const shortId = (what: string) => z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, `${what} IDs are short strings of letters, digits, _ and -, e.g. 20748256`);

const STATUSES = ["processing", "failed", "draft", "sent", "signed", "cancelled", "expired", "rejected", "verify"] as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof SignableError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const pageNote = (r: { complete: boolean; next_offset?: number }) =>
  r.complete ? undefined : `More results exist; call again with offset ${r.next_offset} to continue.`;

server.registerTool(
  "list_envelopes",
  {
    title: "List envelopes",
    description:
      "List envelopes on this Signable account in the order the API returns them (the spec does not document the sort order; its example lists newest first), with status, timestamps and the parties' names. Filter by one status and/or a keyword in the title.",
    inputSchema: {
      status: z.enum(STATUSES).optional().describe("Only envelopes with this status"),
      q: z.string().min(1).max(200).optional().describe("Case-insensitive keyword filter on the envelope title (partial words match)"),
      max_results: z.number().int().min(1).max(500).default(50).describe("Maximum number of envelopes to return"),
      offset: z.number().int().min(0).default(0).describe("Index of the first envelope to return (for continuing a previous call)"),
      include_contact_details: z.boolean().default(false).describe("Include the last four digits of signers' mobile numbers and envelope passwords, and stop redacting email addresses and phone numbers from envelope titles, party names and the redirect URL"),
    },
    annotations: READ,
  },
  safe(async ({ status, q, max_results, offset, include_contact_details }) => {
    const r = await api.list("/envelopes", "envelopes", "total_envelopes", { maxItems: max_results, maxPages: 20, offset, query: { envelope_status: status, q } });
    return {
      count: r.items.length,
      total_matching: r.total,
      offset,
      complete: r.complete,
      note: pageNote(r),
      envelopes: r.items.map((e) => fmt.envelopeSummary(e, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_envelope",
  {
    title: "Get envelope details",
    description:
      "Full detail for one envelope: each party with its signing status and role, the documents with their fields and download links (valid 24 hours), the audit history and any metadata.",
    inputSchema: {
      envelope_fingerprint: fingerprint("Envelope").describe("Envelope fingerprint"),
      include_contact_details: z.boolean().default(false).describe("Include party email addresses, mobile digits, passwords, and IP addresses and user agents in the history"),
    },
    annotations: READ,
  },
  safe(async ({ envelope_fingerprint, include_contact_details }) => {
    const e = await api.get(`/envelopes/${envelope_fingerprint}`);
    return { envelope: fmt.envelopeDetail(e, include_contact_details) };
  }),
);

server.registerTool(
  "list_templates",
  {
    title: "List templates",
    description: "Templates on this account with their parties and merge fields, so you know what a send from each template needs.",
    inputSchema: {
      max_results: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe("Index of the first template to return"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, offset }) => {
    const r = await api.list("/templates", "templates", "total_templates", { maxItems: max_results, maxPages: 20, offset });
    return { count: r.items.length, total: r.total, offset, complete: r.complete, note: pageNote(r), templates: r.items.map(fmt.template) };
  }),
);

server.registerTool(
  "get_template",
  {
    title: "Get template",
    description: "One template with its parties (party_id, name) and the merge fields (field_id, label) each party can have pre-filled. Use this before send_envelope_from_template.",
    inputSchema: { template_fingerprint: fingerprint("Template").describe("Template fingerprint") },
    annotations: READ,
  },
  safe(async ({ template_fingerprint }) => ({ template: fmt.template(await api.get(`/templates/${template_fingerprint}`)) })),
);

server.registerTool(
  "find_contacts",
  {
    title: "Find contacts",
    description:
      "Search contacts (signers and recipients) by part of their name or email. The API has no server-side search, so this pages through the contact list (50 per call) up to max_pages. Emails are only returned with include_contact_details; note that a match on an email fragment still confirms that such an address exists on the account.",
    inputSchema: {
      query: z.string().min(2).describe("Name or email fragment"),
      max_results: z.number().int().min(1).max(50).default(10),
      max_pages: z.number().int().min(1).max(50).default(10).describe("Pages of 50 contacts to scan"),
      include_contact_details: z.boolean().default(false).describe("Include contact email addresses"),
    },
    annotations: READ,
  },
  safe(async ({ query, max_results, max_pages, include_contact_details }) => {
    const q = query.toLowerCase().trim();
    const { items, complete } = await api.list("/contacts", "contacts", "total_contacts", { maxItems: max_pages * PAGE_SIZE, maxPages: max_pages });
    const matches = items
      .filter((c) => String(c.contact_name ?? "").toLowerCase().includes(q) || String(c.contact_email ?? "").toLowerCase().includes(q))
      .slice(0, max_results)
      .map((c) => fmt.contact(c, include_contact_details));
    return {
      matches,
      contacts_scanned: items.length,
      note: complete ? undefined : `Only the first ${items.length} contacts were scanned; raise max_pages to search further.`,
    };
  }),
);

server.registerTool(
  "get_contact_envelopes",
  {
    title: "Envelopes for a contact",
    description: "A contact's document history: every envelope they are a recipient of, with status, timestamps and signed PDF link where available. A contact that exists but has never been sent an envelope gives an empty list.",
    inputSchema: {
      contact_id: contactId.describe("Contact ID (numeric)"),
      max_results: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      include_contact_details: z.boolean().default(false).describe("Include the contact's email address"),
    },
    annotations: READ,
  },
  safe(async ({ contact_id, max_results, offset, include_contact_details }) => {
    // The contact is fetched first so that a 404 from the envelopes list can be told apart from an
    // unknown contact: the spec documents GET /contacts/{id}/envelopes answering 404 (code 10060,
    // "This contact hasn't been sent any envelopes.") for a contact with no envelopes. Only a 404 on
    // the first page at offset 0 is read that way (emptyOn404); a 404 at a later offset is an error,
    // so pages already collected are never thrown away and a caller-supplied offset past the end is
    // reported as what it is.
    const c = await api.get(`/contacts/${contact_id}`);
    const contact = fmt.contact(c, include_contact_details);
    const r = await api.list(`/contacts/${contact_id}/envelopes`, "envelopes", "total_envelopes", { maxItems: max_results, maxPages: 20, offset, emptyOn404: true });
    return {
      contact,
      count: r.items.length,
      total: r.total,
      offset,
      complete: r.complete,
      note: r.not_found ? "Signable reports this contact has not been sent any envelopes (error code 10060)." : pageNote(r),
      envelopes: r.items.map((e) => fmt.contactEnvelope(e, include_contact_details)),
    };
  }),
);

server.registerTool(
  "list_users",
  {
    title: "List users",
    description: "Team members on this Signable account with their role (User, Admin or Super-Admin). Emails are only returned with include_contact_details.",
    inputSchema: {
      max_results: z.number().int().min(1).max(500).default(50),
      include_contact_details: z.boolean().default(false).describe("Include user email addresses"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, include_contact_details }) => {
    const r = await api.list("/users", "users", "total_users", { maxItems: max_results, maxPages: 20 });
    return { count: r.items.length, total: r.total, complete: r.complete, users: r.items.map((u) => fmt.user(u, include_contact_details)) };
  }),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    "send_envelope_from_template",
    {
      title: "Send an envelope from a template",
      description:
        "Create an envelope from one template and queue it for sending (or save it as a draft). Every party defined in the template needs a signer with that party_id; merge fields are optional and must belong to the template. The template is fetched first and the request is refused locally if parties or fields do not match. If Signable answers with a gateway error (502/503/504) the send is NOT retried, because it may already have gone out: check list_envelopes before calling again. Only available when SIGNABLE_ALLOW_WRITES=true.",
      inputSchema: {
        template_fingerprint: fingerprint("Template").describe("Template fingerprint (from list_templates)"),
        title: z.string().min(1).max(500).describe("Envelope title shown to signers"),
        parties: z
          .array(
            z.object({
              name: z.string().min(1).describe("Full name"),
              email: z.string().email().describe("Email address"),
              party_id: shortId("Party").describe("party_id from the template (also required for copy recipients by the API spec)"),
              role: z.enum(["signer", "copy"]).default("signer"),
              message: z.string().max(2000).optional().describe("Optional message in the email to this party"),
              mobile: z.string().regex(/^\+[1-9]\d{6,14}$/, "Mobile numbers must be in E.164 format, e.g. +447712345678").optional().describe("E.164 mobile number; providing it requires one-time-password verification for this signer. Signers only: the spec says not to provide it for copy recipients, and the request is refused locally if it is."),
            }),
          )
          .min(1),
        merge_fields: z.array(z.object({ field_id: shortId("Field").describe("field_id from the template"), value: z.string().max(5000) })).default([]),
        document_title: z.string().min(1).max(500).optional().describe("Title of the document inside the envelope; defaults to the template title"),
        is_draft: z.boolean().default(false).describe("Save as a draft instead of sending"),
        all_at_once: z.boolean().optional().describe("Send to all parties at once (true) or one at a time in the order given (false). Account default when omitted."),
        // The spec sets minimum 12 on these fields in its "Send Doc Request" variant only; the template
        // variant used here defines them as plain integers. The minimum is kept as a conservative assumption.
        auto_expire_hours: z.number().int().min(12).optional().describe("Hours until the envelope expires automatically (minimum 12: documented for direct-document sends, assumed for template sends)"),
        auto_remind_hours: z.number().int().min(12).optional().describe("Hours between automatic reminder emails (minimum 12: documented for direct-document sends, assumed for template sends)"),
        redirect_url: z.string().url().optional().describe("Where to send the signer after completion"),
        user_id: z.number().int().positive().optional().describe("Signable user to send as (see list_users); notifications go to the company email when omitted"),
      },
      annotations: WRITE,
    },
    safe(async ({ template_fingerprint, title, parties, merge_fields, document_title, is_draft, all_at_once, auto_expire_hours, auto_remind_hours, redirect_url, user_id }) => {
      const rawTemplate = await api.get(`/templates/${template_fingerprint}`);
      // fmt.template redacts contact details from the title and labels, which is what the refusal
      // messages below should carry; the document title posted to Signable comes from the raw record.
      const tpl = fmt.template(rawTemplate);
      const rawTitle = typeof rawTemplate?.template_title === "string" && rawTemplate.template_title !== "" ? (rawTemplate.template_title as string) : undefined;
      const templateParties = new Map(tpl.parties.map((p) => [p.party_id, p]));
      const templateFields = new Map(tpl.parties.flatMap((p) => p.merge_fields.map((f) => [f.field_id, { ...f, party: p.name }])));

      const problems: string[] = [];
      const signers = parties.filter((p) => p.role === "signer");
      for (const p of signers) if (!templateParties.has(p.party_id)) problems.push(`Party ${p.party_id} (${p.name}) is not defined in template "${tpl.title}". Its parties are: ${describeParties(tpl)}.`);
      for (const tp of tpl.parties) if (!signers.some((p) => p.party_id === tp.party_id)) problems.push(`Template party "${tp.name}" (party_id ${tp.party_id}) has no signer. Add a party with that party_id.`);
      const seen = new Set<string>();
      for (const p of signers) {
        if (seen.has(p.party_id)) problems.push(`Two signers were given party_id ${p.party_id}; each template party takes exactly one signer.`);
        seen.add(p.party_id);
      }
      for (const f of merge_fields) if (!templateFields.has(f.field_id)) problems.push(`Merge field ${f.field_id} is not in template "${tpl.title}". Its merge fields are: ${describeFields(tpl)}.`);
      // Spec, Send Template Request, party_mobile: "Do not provide this for copy recipients."
      for (const p of parties) if (p.role === "copy" && p.mobile) problems.push(`Copy recipient ${p.name} was given a mobile number; the API does not accept one for copy recipients. Remove it or make them a signer.`);
      if (problems.length) throw new SignableError(`Not sent. ${problems.join(" ")}`);

      // Body shape: spec POST /envelopes, "Send Template Request" variant.
      const body = {
        envelope_title: title,
        ...(user_id !== undefined ? { user_id } : {}),
        ...(redirect_url ? { envelope_redirect_url: redirect_url } : {}),
        ...(all_at_once !== undefined ? { envelope_all_at_once_enabled: all_at_once } : {}),
        ...(auto_expire_hours !== undefined ? { envelope_auto_expire_hours: auto_expire_hours } : {}),
        ...(auto_remind_hours !== undefined ? { envelope_auto_remind_hours: auto_remind_hours } : {}),
        is_draft,
        envelope_parties: parties.map((p) => ({
          party_name: p.name,
          party_email: p.email,
          party_id: p.party_id,
          party_role: p.role,
          ...(p.message ? { party_message: p.message } : {}),
          ...(p.mobile ? { party_mobile: p.mobile } : {}),
        })),
        envelope_documents: [
          {
            document_title: document_title ?? rawTitle ?? title,
            document_template_fingerprint: template_fingerprint,
            ...(merge_fields.length ? { document_merge_fields: merge_fields.map((f) => ({ field_id: f.field_id, field_value: f.value })) } : {}),
          },
        ],
      };
      const res = await api.request("POST", "/envelopes", { body });
      return {
        result: is_draft ? "saved as draft" : "queued for sending",
        message: res?.message,
        envelope_fingerprint: res?.envelope_fingerprint,
        title: res?.envelope_title,
        queued_at: res?.envelope_queued,
        parties: Array.isArray(res?.envelope_parties) ? res.envelope_parties.map((p: any) => fmt.party(p, false)) : undefined,
      };
    }),
  );

  const envelopeAction = (name: string, action: "remind" | "cancel" | "expire", title: string, description: string, annotations: typeof WRITE | typeof DESTRUCTIVE) =>
    server.registerTool(
      name,
      {
        title,
        description: `${description} Only available when SIGNABLE_ALLOW_WRITES=true.`,
        inputSchema: { envelope_fingerprint: fingerprint("Envelope").describe("Envelope fingerprint") },
        annotations,
      },
      safe(async ({ envelope_fingerprint }) => {
        const res = await api.request("PUT", `/envelopes/${envelope_fingerprint}/${action}`);
        return { message: res?.message, envelope_fingerprint: res?.envelope_fingerprint, title: res?.envelope_title, status: res?.envelope_status, processed: res?.envelope_processed };
      }),
    );

  envelopeAction("remind_envelope", "remind", "Remind signers", "Email a reminder to every party that has not yet signed a sent envelope.", WRITE);
  envelopeAction("cancel_envelope", "cancel", "Cancel an envelope", "Cancel a sent envelope. Signers receive a cancellation email and can no longer sign. Cannot be undone.", DESTRUCTIVE);
  envelopeAction("expire_envelope", "expire", "Expire an envelope", "Expire a sent envelope so it can no longer be signed. No email is sent to signers. Cannot be undone.", DESTRUCTIVE);
}

function describeParties(t: ReturnType<typeof fmt.template>) {
  return t.parties.map((p) => `${p.party_id} "${p.name}"`).join(", ") || "none";
}
function describeFields(t: ReturnType<typeof fmt.template>) {
  return t.parties.flatMap((p) => p.merge_fields.map((f) => `${f.field_id} "${f.label}" (${p.name})`)).join(", ") || "none";
}

await server.connect(new StdioServerTransport());
console.error(`Signable MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
