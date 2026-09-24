# Signable MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with a Signable e-signature account: envelopes, templates, contacts and users, and (when enabled) sending, reminding, cancelling and expiring envelopes. It is built from Signable's public API documentation and its published OpenAPI spec.

Once it's connected, someone on the account can ask things like:

- "Which envelopes are still waiting for a signature, and who hasn't signed?"
- "Show me the history of the 17 John Street tenancy contract."
- "What does the Tenancy Contract template need before I can send it?"
- "Find Sam Evans and list every document we've sent him."
- With writes enabled: "Send the Mutual NDA template to Priya Shah at Acme, and remind the John Street signers."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_envelopes` | Envelopes with status, timestamps and party names. Filters by one status and/or a title keyword, pages by offset. | `GET /envelopes` |
| `get_envelope` | One envelope: parties with signing status and role, documents with fields and 24-hour download links, audit history, metadata. | `GET /envelopes/{fingerprint}` |
| `list_templates` | Templates with their parties and merge fields. | `GET /templates` |
| `get_template` | One template, so an assistant knows the `party_id`s and `field_id`s a send needs. | `GET /templates/{fingerprint}` |
| `find_contacts` | Search contacts by part of a name or email. The API has no search parameter, so this pages through the list (50 per call). Emails are hidden by default, but a query that matches an email fragment still confirms such an address exists on the account. | `GET /contacts` |
| `get_contact_envelopes` | A contact's document history. The API answers 404 for a contact that exists but has never been sent an envelope (error code 10060); the tool fetches the contact first and turns that case into an empty list. | `GET /contacts/{id}`, `/contacts/{id}/envelopes` |
| `list_users` | Team members with their role (User, Admin, Super-Admin). | `GET /users` |
| `send_envelope_from_template` | Creates an envelope from one template and queues it for sending, or saves it as a draft. Fetches the template first and refuses locally if a template party has no signer, a signer's `party_id` is not in the template, or a merge field is unknown. Only registered when writes are enabled. | `GET /templates/{fingerprint}`, `POST /envelopes` |
| `remind_envelope` | Emails a reminder to every party that has not signed. Writes only. | `PUT /envelopes/{fingerprint}/remind` |
| `cancel_envelope` | Cancels a sent envelope (signers are emailed). Writes only. | `PUT /envelopes/{fingerprint}/cancel` |
| `expire_envelope` | Expires a sent envelope (no email). Writes only. | `PUT /envelopes/{fingerprint}/expire` |

Not covered on purpose: companies, usage, webhooks, branding, settings, embed sessions, party updates, and every delete endpoint.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API key for your Signable account. The API authenticates with HTTP Basic: the key is the username; the password can be anything, Signable recommends `x`, and that is what this server sends.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "signable": {
      "command": "node",
      "args": ["/absolute/path/to/signable-mcp/dist/index.js"],
      "env": { "SIGNABLE_API_KEY": "your-key" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add signable -e SIGNABLE_API_KEY=your-key -- node /absolute/path/to/signable-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `SIGNABLE_API_KEY` | yes | Your API key, sent as the HTTP Basic username with password `x`. |
| `SIGNABLE_ALLOW_WRITES` | no | `true` to register `send_envelope_from_template`, `remind_envelope`, `cancel_envelope` and `expire_envelope`. Off by default. |
| `SIGNABLE_BASE_URL` | no | Defaults to `https://api.signable.co.uk/v1`. Used by the tests. |

## Safety defaults

- Read-only unless `SIGNABLE_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation; `cancel_envelope` and `expire_envelope` are marked destructive.
- Email addresses of signers, contacts and users, the last four digits of signers' mobile numbers, envelope passwords, the IP addresses and user agents in the audit history, and the download link of a file a signer uploaded into an `upload` field (the spec's example is a passport copy) are only returned when the assistant explicitly asks (`include_contact_details`). In free text (history lines, field values, field and merge-field labels, envelope and document titles, envelope metadata, redirect URLs, and signer, contact and user names) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]` by default. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers written with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings that happen to start with `0` (an order number, say) are redacted too, while hex fingerprints, numeric IDs, timestamps and hyphenated references such as `PO-0001-000123` are left alone; the raw text is available with `include_contact_details`. Envelope metadata nested more than 20 levels deep is replaced by a placeholder rather than returned unredacted. Template titles, template party labels and merge-field labels are always redacted (the template tools have no `include_contact_details` switch); names are always returned, minus any email or phone typed into them. The same redaction is applied to Signable's own error messages before they are passed on.
- Document download links (`pdf_url`, `signed_pdf_url` and the envelope's signed PDF) are returned by default: the spec documents them as direct links that give access to the whole document for 24 hours after generation. They are passed through as stored so they keep working; the redaction is not applied to them.
- IDs are checked before any call is made: contact IDs must be numeric (the spec types them as integers); fingerprints and party/field IDs must be short strings of letters, digits, `_` and `-` (up to 64 characters, no slashes or spaces), because the spec does not document their format (all but one fingerprint example are 32 lowercase hex characters, one is 33; every party and field ID example is a number).
- `send_envelope_from_template` compares the request with the template before posting anything. Its `auto_expire_hours` and `auto_remind_hours` have a minimum of 12: the spec documents that minimum for direct-document sends only, and it is assumed here for template sends.
- Signable does not document a rate limit. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method, including `POST /envelopes`, on the assumption that a rate-limited request was not processed (see Status). The retry waits for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds so a tool call stays under the MCP client's default 60-second request timeout: if Signable asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML. A `POST /envelopes` or a `PUT …/remind|cancel|expire` is never retried after a gateway error, because the request may already have been processed and a retry could send an envelope or a reminder twice; the error tells the assistant to check with `list_envelopes` or `get_envelope` before repeating it.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `SIGNABLE_BASE_URL`, never as an empty list or an empty envelope.
- A rejected API key produces a message that says which variable to fix; a 400 from the API (for example cancelling an envelope that is not `sent`) is passed on with Signable's own message and error code.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the component schemas in Signable's published OpenAPI spec (`EnvelopeSignedSummary`, `EnvelopeDetailResponse`, `TemplateSummary`, `Contact`, `ContactEnvelopeSummary`, `User`). The spec is downloaded from `developers.signable.app/_bundle/openapi.yaml` to `spec.yaml` on the first run.
2. Starts a local mock of the API under `/v1` that serves those fixtures with the documented offset/limit pagination, returns Basic-auth 401s, 404s (including the spec's two contact cases: unknown contact, code 10053, and contact with no envelopes, code 10060) and 400s in the documented error shapes (the `POST /envelopes` 400 uses the spec's example code 10250), and answers the first `GET /templates` with a 429. The mock's list, detail, action and error responses are validated against the spec's response schemas, and the documented keys of each list and get response are asserted explicitly (see the note below).
3. Starts the built server and drives it over stdio with the official MCP client: 29 checks covering every tool, tool annotations, offset pagination stopping at the documented total and continuing across pages that come back shorter than requested, the `envelope_status` and `q` filters, redaction of emails and phone numbers by default (parties, contacts, users, history, fields and merge-field labels, template titles and party labels, metadata including a 24-level nested value, redirect URL, names; the `+44 (0)…`, bracketed, `00`-prefixed, extra-spaced and dot-separated phone forms), the upload-field link withheld by default, and their return on request, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 429 on `POST /envelopes` retried once, a 502 retried for `GET` and never for `POST /envelopes` or a `PUT` action, a `GET` failing three times with 503 reported with advice and without the gateway HTML, a 200 with a non-JSON body reported as an error, the write gate with the variable unset and set to `false`, the `POST /envelopes` body validated against the spec's "Send Template Request" schema, the local refusal of mismatched parties and fields and of a `copy` recipient with a mobile number, the three `PUT` actions, the empty-list handling of the contact-with-no-envelopes 404 only on the first page at offset 0, ID validation before any call, the 401 and 404 messages, and that every request used `Basic base64(key:x)` and a documented method and path.

Note that the spec marks no fields as required on `TemplateSummary`, `Contact`, `ContactEnvelopeSummary`, `User`, `TemplateGetResponse`, `ContactGetResponse`, `TemplatesListResponse`, `ContactsListResponse`, `ContactEnvelopesListResponse` and `UsersListResponse`, so schema validation of those only proves the types of fields that are present. Step 2 therefore also asserts that the documented keys are present in the mock's list and get responses; the fixture records themselves are only type-checked.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a Signable account. Everything below is taken from the published spec and should be confirmed on a real account:

- The format of envelope and template fingerprints and of party and field IDs. The spec types them as strings; the validation here is deliberately loose.
- The sort order of `GET /envelopes`. The spec does not document one; its example lists newest first, and the server returns whatever order the API uses.
- `GET /envelopes/{fingerprint}` on a `draft` or `processing` envelope, and whether `envelope_history` and `document_fields` are present for every status.
- `GET /contacts/{id}/envelopes` for a contact with no envelopes. The spec documents a 404 with code 10060 and the message "This contact hasn't been sent any envelopes.", but the example's summary says "Unknown or wrong-account contact", so the server fetches the contact first and only treats the 404 as "no envelopes" when that succeeded and the request was for the first page at offset 0. What the API answers for an `offset` past the end of a list is not documented; the mock answers 200 with an empty list, and a 404 at a non-zero offset is passed on as an error rather than read as "no envelopes".
- The wording of Signable's error messages and whether any of them echo request data such as a party's email address; the texts here are the spec's examples, and the server redacts contact details from them regardless.
- Whether the 12-hour minimum on `envelope_auto_expire_hours` and `envelope_auto_remind_hours` applies to template sends; the spec documents it only for direct-document sends.
- The end of pagination. The server stops at an empty page or when `offset + returned` reaches the documented `total_*` string; when no total is present a short page is taken as the end. A short page on its own is not, because `LimitParam` says a request for more than 50 gets 10 back: the next page is then requested from `offset + returned`. `ContactsListResponse` also documents a `next` URL, which is honoured when present. The list responses' `limit` field is ambiguous in the spec (the schema describes it as the number of items returned, the examples echo the requested limit) and the server ignores it.
- A 429 on `POST /envelopes` is retried on the assumption that a rate-limited request was not processed. The spec documents no 429 at all; confirm on a live account that Signable never creates the envelope before answering 429.
- The `POST /envelopes` body for a template send, in particular what `party_id` a `copy` recipient should carry (the spec marks `party_id` as required for every party, copy recipients included, without saying which ID a copy recipient should use) and whether `document_title` may differ from the template title.
- Whether `PUT .../remind`, `.../cancel` and `.../expire` accept an empty body, as documented (no request body is defined for them).
- The wording of the 400 returned when reminding, cancelling or expiring an envelope that is not `sent`; the messages here are the spec's examples.
- `role_id` to role-name mapping (`1` User, `2` Admin, `3` Super-Admin) comes from the spec's user-creation schema.
- How many requests per second the API tolerates; the spec says nothing, so the throttle here is a guess on the polite side.

`find_contacts` pages through the contact list because `GET /contacts` has only `offset` and `limit` parameters. On large accounts, a search parameter on that endpoint would make this much cheaper.

## Going to production

This version runs locally over stdio, with the account holder's own API key. For customers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Signable, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
