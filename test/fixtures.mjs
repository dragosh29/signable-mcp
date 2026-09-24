// Fake Signable data shaped exactly like the published OpenAPI schemas (validated in e2e.mjs).
// Timestamps use the "+0000" offset style shown in every example of the spec.
const stamp = (d, h = 9, m = 0) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+0000`;
const hex = (seed) => {
  // Deterministic 32-character lowercase hex string, like the fingerprints in the spec's examples.
  let out = "";
  let x = seed * 2654435761 + 12345;
  while (out.length < 32) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, 32);
};

// ---- Templates (TemplateSummary / TemplateGetResponse) ----
export const TENANCY_TPL = "28f9add86f25028df2eee9adee866aba";
export const NDA_TPL = "b786a173554cc06371248caf0b250704";
export const SUPPLIER_TPL = "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";
const tplUrls = (fp, pages) => ({
  template_widget_url: `https://sign.signable.app/#/widget/${fp.slice(0, 10)}`,
  template_widget_embed: `<iframe src='https://sign.signable.app/#/widget/${fp.slice(0, 10)}' frameborder='0' style='border:0;width:100%;height:100vh;' scrolling='yes'></iframe>`,
  template_pdf_url: `https://docs.signable.app/original/${fp}.pdf?Policy=x&Signature=y&Key-Pair-Id=z`,
  template_thumbnails: Array.from({ length: pages }, (_, i) => `https://docs.signable.app/small/${fp}-${i}.jpg?Policy=x`),
  template_pages: Array.from({ length: pages }, (_, i) => `https://docs.signable.app/large/${fp}-${i}.jpg?Policy=x`),
});
export const templates = [
  {
    template_id: "53890528",
    template_fingerprint: TENANCY_TPL,
    template_title: "Tenancy Contract 2025 v2",
    template_page_total: "2",
    template_in_progress: "3",
    template_parties_total: "2",
    ...tplUrls(TENANCY_TPL, 2),
    template_uploaded: stamp(1, 15, 49),
    template_parties: [
      { party_id: "20748256", party_name: "Tenant", party_merge_fields: [{ field_id: "454958773", field_merge: "Rent notes", field_type: "text" }] },
      { party_id: "20748255", party_name: "Landlord", party_merge_fields: [] },
    ],
  },
  {
    template_id: "53690003",
    template_fingerprint: NDA_TPL,
    template_title: "Mutual NDA",
    template_page_total: "1",
    template_in_progress: "0",
    template_parties_total: "1",
    ...tplUrls(NDA_TPL, 1),
    template_uploaded: stamp(2, 8, 40),
    template_parties: [{ party_id: "20459705", party_name: "Counterparty", party_merge_fields: [{ field_id: "450927743", field_merge: "Name of Sender", field_type: "text" }] }],
  },
  // A template whose title, party label and merge-field label have contact details typed into them, to prove the
  // template tools redact them and that the send tool still posts the title as stored.
  {
    template_id: "53910044",
    template_fingerprint: SUPPLIER_TPL,
    template_title: "Supplier onboarding (return to onboarding@example.com or 0117 496 0000)",
    template_page_total: "1",
    template_in_progress: "0",
    template_parties_total: "1",
    ...tplUrls(SUPPLIER_TPL, 1),
    template_uploaded: stamp(3, 10, 5),
    template_parties: [{ party_id: "20760001", party_name: "Supplier (supplier@example.com)", party_merge_fields: [{ field_id: "455000001", field_merge: "Notes (queries to 07700 900111)", field_type: "text" }] }],
  },
];

// ---- Contacts (Contact) ----
export const ABBY = "17225983";
const mkContact = (id, name, email, outstanding = "0", day = 3) => ({ contact_id: id, contact_name: name, contact_email: email, contact_outstanding_documents: outstanding, contact_created: stamp(day, 9, 54) });
export const contacts = [
  mkContact(ABBY, "Abby Signable", "abby@example.com", "1"),
  mkContact("17241370", "Sam Evans", "sam.evans@example.com", "1"),
  ...Array.from({ length: 117 }, (_, i) => mkContact(String(17300000 + i), `Person${i} Surname${i}`, `person${i}@example.org`)),
  mkContact("17224073", "Priya Shah", "priya.shah@example.com"),
  // A contact whose name field has an email typed into it, to prove names are redacted by default.
  mkContact("17224074", "Lee Chen (lee.chen@example.net)", "lee.chen@example.net"),
];

// ---- Envelopes (EnvelopeSignedSummary for lists, EnvelopeDetailResponse for detail) ----
export const JOHN_ST = "584ea8b41b0d4c17a96b967433b211e6";
export const NDA_ENV = "84b6334b5e5249a78e7ae3f4bba33068";
export const DRAFT_ENV = "2a965d809ca943fb98ca71d3c7c98af5";
export const CANCELLED_ENV = "9f1c2b3a4d5e6f708192a3b4c5d6e7f8";

const listParty = (party_id, party_title, last4 = null, password = null) => ({ party_id, party_title, party_mobile_last4: last4, party_password: password });
const detailParty = (base, contact_id, contact_email, party_status, party_role = "signer") => ({ ...base, contact_id, contact_email, party_status, party_signature_type: "remote", party_role });

const mkSummary = (fp, title, status, created, sent, processed, parties, signedPdf) => ({
  envelope_fingerprint: fp,
  envelope_title: title,
  envelope_status: status,
  envelope_redirect_url: "",
  envelope_created: created,
  envelope_sent: sent,
  envelope_processed: processed,
  envelope_all_at_once_enabled: true,
  envelope_requires_otp: parties.some((p) => p.party_mobile_last4 !== null),
  envelope_parties: parties,
  ...(signedPdf ? { envelope_signed_pdf: signedPdf } : {}),
});

const johnParties = [listParty("45631119", "Abby Signable", "5678", "Test123"), listParty("45631121", "Sam Evans"), listParty("45631122", "Bristol Solicitors")];
const ndaParties = [listParty("45583236", "Priya Shah")];
const draftParties = [listParty("45583378", "Abby Signable")];
const cancelledParties = [listParty("45583400", "Sam Evans")];

const named = [
  mkSummary(JOHN_ST, "17 John Street Tenancy Contract - 25th Aug 2026", "sent", stamp(20, 14, 58), stamp(20, 15, 2), null, johnParties),
  mkSummary(DRAFT_ENV, "Another Test", "draft", stamp(19, 11, 30), null, null, draftParties),
  mkSummary(NDA_ENV, "Acme Ltd Mutual NDA", "signed", stamp(18, 10, 30), stamp(18, 11, 26), stamp(18, 11, 27), ndaParties, "https://api.signableapi.com/shareable/envelope?t=03cbb315-4f68-400d-a5cc-c2884996d061"),
  mkSummary(CANCELLED_ENV, "Old Supplier Agreement", "cancelled", stamp(10, 9, 0), stamp(10, 9, 5), stamp(12, 16, 0), cancelledParties),
];
// A redirect URL with an email address in its query string, to prove it is redacted by default.
named[2].envelope_redirect_url = "https://example.com/thanks?email=priya.shah@example.com";
// 96 more signed envelopes so the list spans two full pages of 50 (total 100).
const bulk = Array.from({ length: 96 }, (_, i) =>
  mkSummary(hex(i + 1), `Bulk contract ${i + 1}`, "signed", stamp(1 + (i % 9), 8, i % 60), stamp(1 + (i % 9), 9, i % 60), stamp(1 + (i % 9), 10, i % 60), [listParty(String(45600000 + i), `Signer ${i + 1}`)], `https://api.signableapi.com/shareable/envelope?t=bulk-${i + 1}`),
);
export const envelopes = [...named, ...bulk];

const doc = (fp, title, pages, fields, signedPdf = null) => ({
  document_fingerprint: fp,
  document_title: title,
  document_page_total: String(pages),
  document_pdf_url: `https://docs.signable.app/original/${fp}.pdf?Policy=x&Signature=y&Key-Pair-Id=z`,
  document_thumbnails: Array.from({ length: pages }, (_, i) => `https://docs.signable.app/small/${fp}-${i}.jpg?Policy=x`),
  document_pages: Array.from({ length: pages }, (_, i) => `https://docs.signable.app/large/${fp}-${i}.jpg?Policy=x`),
  document_fields: fields,
  document_signed_pdf: signedPdf,
});
export const UPLOAD_URL = "https://api.signable.co.uk/download/field/N2I5YmZhMGU0NDAzMGFmMGFhZTZiYmVmODRmYWMxOTA6NTGvATg5MjE1?expires=1779373241&signature=a569a4b52ef1e3c2d47bf9d0c0de2642fc86da851ad936cb2aa090e568b8b102";
// envelope_meta nested 24 levels deep with contact details at the bottom: deeper than the redaction's recursion
// limit, so the redacted output must replace that subtree rather than return it as stored.
export const DEEP_LEAF = { leaf: "deep@example.com or 07700 900999" };
export const deepMeta = (levels) => (levels === 0 ? DEEP_LEAF : { n: deepMeta(levels - 1) });
const history = (detail, date) => ({ history_detail: detail, history_ip: "147.147.97.34", history_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0", history_date: date });

const mkDetail = (summary, parties, documents, historyEvents, meta) => {
  const { envelope_parties: _ignored, ...rest } = summary;
  return { http: 200, ...rest, envelope_parties: parties, envelope_documents: documents, envelope_history: historyEvents, ...(meta ? { envelope_meta: meta } : {}) };
};

export const envelopeDetails = {
  [JOHN_ST]: mkDetail(
    named[0],
    [
      detailParty(johnParties[0], ABBY, "abby@example.com", "in progress"),
      detailParty(johnParties[1], "17241370", "sam.evans@example.com", "signed"),
      detailParty(johnParties[2], "17241371", "office@example.com", "pending", "copy"),
    ],
    [
      doc("78c54190abc34179919e6c2197465926", "Tenancy Contract 2025 v2", 2, [
        { field_id: "452902787", field_title: "Rent notes", field_type: "text", field_value: "Breakables not included", party_id: "45631119", field_merge: "Rent notes" },
        { field_id: "452902788", field_title: "Contact email", field_type: "text", field_value: "Reach me at sam.evans@example.com", party_id: "45631121", field_merge: null },
        { field_id: "452902789", field_title: "Move-in date", field_type: "date", field_value: "", party_id: "45631119", field_merge: null },
        { field_id: "452902790", field_title: "Phone", field_type: "text", field_value: "Call me on 07700 900789", party_id: "45631121", field_merge: null },
        // Phone numbers in the written forms the redaction must recognise (see PHONE in src/format.ts), and a
        // merge label with an email typed into it.
        { field_id: "452902791", field_title: "Other numbers", field_type: "text", field_value: "Landlord +44 (0)7700 900123, office (0117) 496 0000, agent 0044 20 7946 0958, alt 07 700 900 789, fax 07700.900555", party_id: "45631119", field_merge: "Other numbers (merge@example.com)" },
        // Spec EnvelopeField.field_value: "For `upload` fields, this contains a temporary uploaded file URL". The URL
        // is the spec's own example ("Passport Copy").
        { field_id: "452902792", field_title: "Passport Copy", field_type: "upload", field_value: UPLOAD_URL, party_id: "45631119", field_merge: null },
      ]),
    ],
    [
      history("Created the envelope", stamp(20, 14, 58)),
      history("Sent the envelope to Abby Signable (abby@example.com) for signing", stamp(20, 15, 2)),
      history("Sent the envelope to Sam Evans (sam.evans@example.com) for signing", stamp(20, 15, 2)),
      history("OTP sent to +447700900321", stamp(20, 15, 3)),
      history("Sam Evans (sam.evans@example.com) signed the envelope", stamp(21, 9, 12)),
    ],
    // envelope_meta is free-form (additionalProperties: true); emails and phones inside it must be redacted by default.
    { internal_id: "JS17", VIP: false, landlord_contact: "landlord@example.com", phone: "+44 7700 900123", nested: { deep: "call 07700 900456 or mail x@example.com" }, deep: deepMeta(24) },
  ),
  [NDA_ENV]: mkDetail(
    named[2],
    [detailParty(ndaParties[0], "17224073", "priya.shah@example.com", "signed")],
    [doc("8ab4248168761318178b5c747c643a27", "Mutual NDA", 1, [{ field_id: "450927743", field_title: "Name of Sender", field_type: "text", field_value: "Alex Example", party_id: "45583236", field_merge: "Name of Sender" }], named[2].envelope_signed_pdf)],
    [history("Created the envelope", stamp(18, 10, 30)), history("Priya Shah (priya.shah@example.com) signed the envelope", stamp(18, 11, 27))],
  ),
  [DRAFT_ENV]: mkDetail(named[1], [detailParty(draftParties[0], ABBY, "abby@example.com", "pending")], [doc("1b2c3d4e5f60718293a4b5c6d7e8f901", "Another Test", 1, [])], [history("Created the envelope", stamp(19, 11, 30))]),
  [CANCELLED_ENV]: mkDetail(named[3], [detailParty(cancelledParties[0], "17241370", "sam.evans@example.com", "pending")], [doc("a1b2c3d4e5f60718293a4b5c6d7e8f90", "Supplier Agreement", 3, [])], [history("Created the envelope", stamp(10, 9, 0)), history("Cancelled the envelope", stamp(12, 16, 0))]),
};
// Bulk envelopes get a minimal detail record when fetched.
for (const e of bulk) {
  envelopeDetails[e.envelope_fingerprint] = mkDetail(
    e,
    [detailParty(e.envelope_parties[0], String(17400000 + Number(e.envelope_parties[0].party_id) - 45600000), `signer${e.envelope_parties[0].party_id}@example.org`, "signed")],
    [doc(hex(1000 + Number(e.envelope_parties[0].party_id) - 45600000), e.envelope_title, 1, [], e.envelope_signed_pdf)],
    [history("Created the envelope", e.envelope_created)],
  );
}

// ---- Envelopes for a contact (ContactEnvelopeSummary) ----
const contactEnv = (e) => {
  const { envelope_fingerprint, envelope_title, envelope_status, envelope_created, envelope_sent, envelope_processed, envelope_signed_pdf } = e;
  return { envelope_fingerprint, envelope_title, envelope_status, envelope_created, envelope_sent, envelope_processed, ...(envelope_signed_pdf ? { envelope_signed_pdf } : {}) };
};
export const contactEnvelopes = {
  [ABBY]: [contactEnv(named[0]), contactEnv(named[1])],
  "17241370": [contactEnv(named[0]), contactEnv(named[3])],
  "17224073": [contactEnv(named[2])],
};

// ---- Users (User) ----
export const users = [
  { user_id: "836499", role_id: "3", user_name: "Alex Example", user_email: "alex@example.com", user_added: stamp(1, 8, 40), user_last_updated: stamp(7, 7, 57) },
  { user_id: "837142", role_id: "1", user_name: "Jo Bloggs", user_email: "jo@example.com", user_added: stamp(7, 7, 58), user_last_updated: stamp(7, 7, 58) },
];
