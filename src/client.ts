// Minimal Signable API client used by the MCP tools.
// Docs: https://developers.signable.app  Spec: https://developers.signable.app/_bundle/openapi.yaml
import { redactContacts } from "./format.js";

export class SignableError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SignableError";
  }
}

export interface ListPage<T> {
  offset?: number;
  limit?: number;
  next?: string;
  [key: string]: unknown | T[];
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET: repeating a POST /envelopes could send the same envelope twice, and repeating a PUT
// .../remind could email signers twice.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// The spec's LimitParam: minimum 1, maximum 50, default 10; asking for more than 50 returns 10.
export const PAGE_SIZE = 50;

export class SignableClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  // Signable does not document a rate limit. Space requests at about four per second so a tool
  // call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(apiKey: string, baseUrl = "https://api.signable.co.uk/v1") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // Spec securitySchemes.basicAuth: HTTP Basic, API key as the username; the password "can be
    // anything", Signable recommends "x".
    this.authHeader = "Basic " + Buffer.from(`${apiKey}:x`, "utf8").toString("base64");
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        throw new SignableError(`Could not reach Signable at ${this.baseUrl}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new SignableError(
            `Signable asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`,
            res.status,
          );
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 2xx body is a JSON object. A 200 with HTML (a proxy, a captive portal, a
        // login page) must not be mistaken for an empty list or an empty envelope.
        if (!json || typeof json !== "object") {
          throw new SignableError(
            `Signable returned ${res.status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(text.slice(0, 60))}). Check SIGNABLE_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Signable's own message/detail strings are free text; redact anything that looks like a
      // contact detail in case the live API ever echoes a party's email or phone number back.
      const detail = redactContacts(describeError(json) ?? text.slice(0, 300), false);
      if (res.status === 401 || res.status === 403) {
        throw new SignableError(
          `Signable rejected the API key (${res.status}). Check SIGNABLE_API_KEY: it must be the API key from your Signable account, which the server sends as the HTTP Basic username with password "x".${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (res.status === 404) throw new SignableError(`Not found: ${path}. Check the fingerprint or ID.${detail ? " " + detail : ""}`, 404);
      if (res.status === 429) throw new SignableError("Signable rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400) throw new SignableError(`Signable refused ${method} ${path} (400).${detail ? " " + detail : ""}`, 400);
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        const how = path === "/envelopes" ? "list_envelopes (and get_envelope)" : "get_envelope";
        throw new SignableError(
          `Signable returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with ${how} before repeating it.${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a JSON
        // message/detail is passed on.
        const jsonDetail = redactContacts(describeError(json), false);
        throw new SignableError(
          `Signable returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`,
          res.status,
        );
      }
      throw new SignableError(`Signable returned ${res.status} for ${method} ${path}.${detail ? " " + detail : ""}`, res.status);
    }
  }

  get<T = any>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch an offset/limit paginated collection. `key` is the array property in the response
   * (envelopes, templates, contacts, users) and `totalKey` the documented string total.
   * Stops at `maxItems`, at `maxPages`, at an empty page, or when the documented total has been
   * reached. When no total is known, a short page is taken as the end. When a total is known it
   * decides: the spec's LimitParam says a request for more than 50 gets 10 back, so a short page
   * on its own does not prove the list is exhausted.
   * With `emptyOn404`, a 404 on the first page at offset 0 is returned as an empty, complete list
   * with `not_found: true` (GET /contacts/{id}/envelopes documents that 404 for a contact with no
   * envelopes); a 404 on any later page or at a caller-supplied offset is thrown as usual.
   */
  async list<T = any>(
    path: string,
    key: string,
    totalKey: string,
    { maxItems = PAGE_SIZE, maxPages = 10, offset = 0, query = {} as Record<string, string | number | undefined>, emptyOn404 = false } = {},
  ): Promise<{ items: T[]; total?: number; complete: boolean; next_offset?: number; not_found?: true }> {
    const items: T[] = [];
    let total: number | undefined;
    let cursor = offset;
    for (let page = 0; page < maxPages; page++) {
      const limit = Math.min(PAGE_SIZE, maxItems - items.length);
      let res: ListPage<T>;
      try {
        res = await this.get<ListPage<T>>(path, { ...query, offset: cursor, limit });
      } catch (err) {
        if (emptyOn404 && page === 0 && offset === 0 && err instanceof SignableError && err.status === 404) return { items, total: 0, complete: true, not_found: true };
        throw err;
      }
      const data = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
      // The spec types total_* as strings with numeric examples ("3"). Anything else (empty string,
      // missing, non-numeric) is treated as "no total known" rather than as zero.
      const rawTotal = res?.[totalKey];
      if (/^\d+$/.test(String(rawTotal ?? ""))) total = Number(rawTotal);
      items.push(...data);
      cursor += data.length;
      // End conditions: an empty page; the documented total reached; or, when no total is known, a
      // short page. ContactsListResponse also documents a `next` URL "returned when another page of
      // contacts is available".
      const exhausted = data.length === 0 || (total !== undefined ? cursor >= total : data.length < limit);
      const hasNext = (typeof res?.next === "string" && data.length > 0) || !exhausted;
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), total, complete: !hasNext, next_offset: hasNext ? cursor : undefined };
      if (!hasNext) return { items, total, complete: true };
    }
    return { items, total, complete: false, next_offset: cursor };
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Spec: ErrorResponse {http, code, message, company, url, detail} and RouteNotFoundResponse {message}.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts = [json.message, json.detail].filter((x) => typeof x === "string" && x.trim()).join(" ");
  if (!parts) return undefined;
  return json.code !== undefined ? `${parts} (error code ${json.code})` : parts;
}
