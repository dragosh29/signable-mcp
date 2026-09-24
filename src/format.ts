// Turn Signable API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Signable's OpenAPI spec (EnvelopeSignedSummary,
// EnvelopeDetailResponse, TemplateSummary, Contact, ContactEnvelopeSummary, User).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so hex fingerprints, numeric IDs,
// timestamps with a "+0000" offset and hyphenated references such as PO-0001-000123 are left alone.
// Any other 9-11 digit string starting with 0 (an order number, say) is redacted too; the raw text
// is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (history lines, field
 * values, metadata, names, redirect URLs, titles) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// envelope_meta is free-form and may be nested arbitrarily. Objects and arrays below this depth are
// replaced by a placeholder rather than returned unredacted.
const MAX_META_DEPTH = 20;

/** Apply redactContacts to every string key and value inside an arbitrary JSON value (envelope_meta). */
export function redactDeep(value: unknown, includeContact: boolean, depth = 0): unknown {
  if (includeContact) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_META_DEPTH) return `[metadata nested deeper than ${MAX_META_DEPTH} levels omitted; available with include_contact_details]`;
    return value.map((v) => redactDeep(v, includeContact, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_META_DEPTH) return `[metadata nested deeper than ${MAX_META_DEPTH} levels omitted; available with include_contact_details]`;
    const out: Rec = {};
    for (const [k, v] of Object.entries(value as Rec)) out[redactString(k)] = redactDeep(v, includeContact, depth + 1);
    return out;
  }
  return value;
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};

// EnvelopeParty (list) and EnvelopeDetailParty (detail). party_password is an access credential
// for the envelope and party_mobile_last4 part of a phone number: both only on request.
export function party(p: Rec, includeContact: boolean) {
  return {
    party_id: str(p.party_id),
    name: redactContacts(p.party_title, includeContact),
    role: str(p.party_role),
    status: str(p.party_status),
    contact_id: str(p.contact_id),
    otp_required: p.party_mobile_last4 !== undefined ? p.party_mobile_last4 !== null : undefined,
    password_protected: p.party_password !== undefined ? p.party_password !== null : undefined,
    ...(includeContact
      ? { email: str(p.contact_email), mobile_last4: str(p.party_mobile_last4), password: str(p.party_password) }
      : {}),
  };
}

export function envelopeSummary(e: Rec, includeContact: boolean) {
  return {
    fingerprint: str(e.envelope_fingerprint),
    title: redactContacts(e.envelope_title, includeContact),
    status: str(e.envelope_status),
    created: str(e.envelope_created),
    sent: str(e.envelope_sent),
    processed: str(e.envelope_processed),
    all_at_once: e.envelope_all_at_once_enabled,
    requires_otp: e.envelope_requires_otp,
    redirect_url: redactContacts(e.envelope_redirect_url, includeContact),
    signed_pdf_url: str(e.envelope_signed_pdf),
    parties: Array.isArray(e.envelope_parties) ? e.envelope_parties.map((p: Rec) => party(p, includeContact)) : undefined,
  };
}

// Spec EnvelopeField.field_value: "For `upload` fields, this contains a temporary uploaded file URL"
// (the spec's own example is a "Passport Copy"), so the link to a signer's uploaded file is third-party
// data and only returned on request.
export function field(f: Rec, includeContact: boolean) {
  const isUpload = f.field_type === "upload";
  const rawValue = str(f.field_value);
  return {
    field_id: str(f.field_id),
    title: redactContacts(f.field_title, includeContact),
    type: str(f.field_type),
    value: isUpload && rawValue && !includeContact ? "[uploaded file: download link available with include_contact_details]" : redactContacts(f.field_value, includeContact),
    party_id: str(f.party_id),
    merge_label: redactContacts(f.field_merge, includeContact),
  };
}

export function document(d: Rec, includeContact: boolean) {
  return {
    fingerprint: str(d.document_fingerprint),
    title: redactContacts(d.document_title, includeContact),
    pages: num(d.document_page_total),
    pdf_url: str(d.document_pdf_url), // spec: expires 24 hours after generation
    signed_pdf_url: str(d.document_signed_pdf),
    fields: Array.isArray(d.document_fields) ? d.document_fields.map((f: Rec) => field(f, includeContact)) : [],
  };
}

export function historyEvent(h: Rec, includeContact: boolean) {
  return {
    date: str(h.history_date),
    detail: redactContacts(h.history_detail, includeContact),
    ...(includeContact ? { ip: str(h.history_ip), user_agent: str(h.history_user_agent) } : {}),
  };
}

export function envelopeDetail(e: Rec, includeContact: boolean) {
  return {
    ...envelopeSummary(e, includeContact),
    documents: Array.isArray(e.envelope_documents) ? e.envelope_documents.map((d: Rec) => document(d, includeContact)) : [],
    history: Array.isArray(e.envelope_history) ? e.envelope_history.map((h: Rec) => historyEvent(h, includeContact)) : [],
    // envelope_meta is free-form ("any contextual information relevant to your system"), so it gets the same redaction as text.
    meta: e.envelope_meta && typeof e.envelope_meta === "object" ? redactDeep(e.envelope_meta, includeContact) : undefined,
  };
}

// Template titles, party labels and merge-field labels are free text typed by the account holder.
// The template tools have no include_contact_details switch, so these are always redacted; the
// send tool takes the document title it posts from the raw record, not from here.
export function mergeField(f: Rec) {
  return { field_id: str(f.field_id), label: redactContacts(f.field_merge, false), type: str(f.field_type) };
}

export function templateParty(p: Rec) {
  return {
    party_id: str(p.party_id),
    name: redactContacts(p.party_name, false),
    merge_fields: Array.isArray(p.party_merge_fields) ? p.party_merge_fields.map(mergeField) : [],
  };
}

export function template(t: Rec) {
  return {
    template_id: str(t.template_id),
    fingerprint: str(t.template_fingerprint),
    title: redactContacts(t.template_title, false),
    pages: num(t.template_page_total),
    envelopes_in_progress: num(t.template_in_progress),
    parties_total: num(t.template_parties_total),
    uploaded: str(t.template_uploaded),
    widget_url: str(t.template_widget_url),
    parties: Array.isArray(t.template_parties) ? t.template_parties.map(templateParty) : [],
  };
}

// Contact (list) and ContactGetResponse (contact_id is a string in one and an integer in the other).
export function contact(c: Rec, includeContact: boolean) {
  return {
    contact_id: str(c.contact_id),
    name: redactContacts(c.contact_name, includeContact),
    ...(includeContact ? { email: str(c.contact_email) } : {}),
    outstanding_documents: num(c.contact_outstanding_documents),
    created: str(c.contact_created),
  };
}

export function contactEnvelope(e: Rec, includeContact: boolean) {
  return {
    fingerprint: str(e.envelope_fingerprint),
    title: redactContacts(e.envelope_title, includeContact),
    status: str(e.envelope_status),
    created: str(e.envelope_created),
    sent: str(e.envelope_sent),
    processed: str(e.envelope_processed),
    signed_pdf_url: str(e.envelope_signed_pdf),
  };
}

// role_id values as documented in the spec's UserCreateRequest: "1" User, "2" Admin, "3" Super-Admin.
const ROLES: Record<string, string> = { "1": "User", "2": "Admin", "3": "Super-Admin" };

export function user(u: Rec, includeContact: boolean) {
  const roleId = str(u.role_id);
  return {
    user_id: str(u.user_id),
    name: redactContacts(u.user_name, includeContact),
    role: roleId ? ROLES[roleId] ?? `role ${roleId}` : undefined,
    role_id: roleId,
    ...(includeContact ? { email: str(u.user_email) } : {}),
    added: str(u.user_added),
    last_updated: str(u.user_last_updated),
  };
}
