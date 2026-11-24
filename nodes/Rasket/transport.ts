import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  IN8nHttpFullResponse,
  IWebhookFunctions,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, sleep } from "n8n-workflow";

/**
 * Every request the Rasket nodes make goes through `rasketRequest`: the public API on its own host,
 * the API key from the `rasketApi` credential, the `User-Agent` the API requires, and Rasket's error
 * body turned into a message that says what happened and what to do about it.
 */

/**
 * The public API. The OpenAPI document's paths carry an `/api/v1` prefix that this host does not,
 * exactly as the Rasket SDK and the Zapier app strip it.
 */
export const API_BASE_URL = "https://api.rasket.com";

/** package.json's `version`; `test/package.test.ts` fails when the two drift. */
export const PACKAGE_VERSION = "0.3.0";

/** A request without a `User-Agent` is refused (`403 validation_error`). */
export const USER_AGENT = `n8n-nodes-rasket/${PACKAGE_VERSION}`;

export const CREDENTIAL_NAME = "rasketApi";

/**
 * The waits the nodes take (a `Retry-After`, a locked job): n8n-workflow's `sleep`, since a verified
 * node may not touch the timer globals. An object so tests can replace it rather than wait.
 */
export const timing = { sleep };

/** The quota refusals are 429s too, but waiting a second does not help them. */
const QUOTA_ERRORS = new Set([
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "marketing_quota_exceeded",
  "sms_quota_exceeded",
]);

/** The campaign option that sends past failing pre-send checks (`acknowledge_checks`). */
export const ACKNOWLEDGE_CHECKS_LABEL = "Send Despite Failed Checks";

/** How long one `rate_limit_exceeded` retry may wait. The limit is per second, so this is ample. */
const MAX_RETRY_AFTER_SECONDS = 10;

type RasketContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

/** The API's one error shape (`components.schemas.Error`). */
export interface RasketErrorBody {
  readonly statusCode?: number;
  readonly name?: string;
  readonly message?: string;
  readonly errors?: ReadonlyArray<{ readonly path?: string; readonly message?: string }>;
  /** Other errors carry other shapes here, so `details.checks` is read at run time. */
  readonly details?: { readonly checks?: unknown };
}

export interface RasketResponse<T = IDataObject> {
  readonly statusCode: number;
  readonly body: T;
  readonly headers: IDataObject;
  /** The request's path, so an error's guidance can tell an SMS or webhook refusal apart. */
  readonly path?: string;
}

export interface RasketRequest {
  readonly method?: IHttpRequestMethods;
  /** A path on the public host, with any path parameters already encoded (`segment` does this). */
  readonly path: string;
  readonly body?: IDataObject;
  readonly qs?: IDataObject;
  readonly headers?: IDataObject;
  /** Item index for the error message (`[item 2]`). */
  readonly itemIndex?: number;
}

/** One path segment, encoded, so an address with `+` or a key with `/` survives. */
export function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

/** The parsed body when it is one of ours, `null` for anything else (a proxy's 502 page). */
export function readErrorBody(body: unknown): RasketErrorBody | null {
  if (typeof body === "string") {
    try {
      return readErrorBody(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body;
  }
  return null;
}

function header(headers: IDataObject, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first: unknown = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" || typeof first === "number" ? String(first) : undefined;
  }
  return undefined;
}

/** `Retry-After` in seconds, within (0, 10]; one second when it is missing or unusable. */
export function retryAfterSeconds(headers: IDataObject): number {
  const value = Number.parseInt(header(headers, "retry-after") ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(value, MAX_RETRY_AFTER_SECONDS);
}

/**
 * The failing pre-send checks of a refused campaign send (`details.checks`), as `title: message`.
 * Empty for every other error.
 */
export function failingChecks(body: RasketErrorBody | null): string[] {
  const checks = body?.details?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check: unknown) => {
    if (typeof check !== "object" || check === null) return [];
    const { title, message } = check as { title?: unknown; message?: unknown };
    if (typeof title !== "string") return [];
    return [typeof message === "string" ? `${title}: ${message}` : title];
  });
}

/**
 * `message`, then each `path: message` from `errors[]`, so a 422 names the field it is about, then
 * every failing pre-send check of a refused campaign send.
 */
export function describeError(statusCode: number, body: RasketErrorBody | null): string {
  const message = body?.message ?? `Rasket answered HTTP ${String(statusCode)}.`;
  const issues = (body?.errors ?? [])
    .filter((issue) => typeof issue.message === "string")
    .map((issue) =>
      issue.path === undefined || issue.path === ""
        ? String(issue.message)
        : `${issue.path}: ${String(issue.message)}`,
    );
  const described = issues.length === 0 ? message : `${message} (${issues.join("; ")})`;
  const checks = failingChecks(body);
  return checks.length === 0 ? described : `${described} Failing checks: ${checks.join("; ")}.`;
}

/**
 * What the user should do next, by the error's stable `name` and the request's path (never by
 * parsing `message`, which stays Rasket's own and is shown as the error):
 *
 * - 401 `restricted_api_key`: a Send only (or store) key on an endpoint only Full access reaches.
 * - 403 `invalid_permission` on `/sms…`: the key's SMS access (A512) does not reach the call.
 * - 403 `invalid_permission` on `/webhooks…`: only the Inbox-events gate refuses a Full access key
 *   there, and it wants a key with Inbox access and no channel limit.
 * - 403 `restricted_api_key`: the key was revoked.
 *
 * Any other 403 (a suspended key or team, a policy refusal, `inbox_not_set_up`) is left to
 * Rasket's message, since no other key would help.
 */
function guidance(
  statusCode: number,
  body: RasketErrorBody | null,
  headers: IDataObject,
  path: string,
): string | undefined {
  const name = body?.name ?? "";
  const sms = path === "/sms" || path.startsWith("/sms/") || path.startsWith("/sms?");
  const webhooks = path === "/webhooks" || path.startsWith("/webhooks/");
  if (statusCode === 401 && name === "restricted_api_key") {
    const full =
      "This key can't do this. Use a key with Email access: Full access from Rasket → API keys.";
    return sms ? `${full} To read texts it also needs SMS access Read or Send and manage.` : full;
  }
  if (statusCode === 401) {
    return "Check the API key in the Rasket credential. Create a new one in Rasket → API keys if it was deleted.";
  }
  if (statusCode === 403 && /insufficient_scope/.test(header(headers, "www-authenticate") ?? "")) {
    return "This API key can't do this. Use a Full access key from Rasket → API keys.";
  }
  if (statusCode === 403 && name === "invalid_permission" && sms) {
    return "Give this key SMS access in Rasket → API keys: Send only to send texts, Read to read them, Send and manage for both.";
  }
  if (statusCode === 403 && name === "invalid_permission" && webhooks) {
    return "Inbox events need a key with Inbox access Read or Read and reply, and no channel limit. Set it in Rasket → API keys, or remove the Inbox events.";
  }
  if (statusCode === 403 && name === "restricted_api_key") {
    return "This API key was revoked. Create a new one in Rasket → API keys and update the credential.";
  }
  if (name === "not_found" || statusCode === 404) {
    return "It may have been deleted. Pick it again from the list, or check the ID you mapped.";
  }
  if (QUOTA_ERRORS.has(name)) {
    return "Raise the limit in Rasket → Billing, or wait for the quota to reset.";
  }
  if (name === "rate_limit_exceeded") {
    return "Turn on 'Retry On Fail' in the node's settings, or send fewer items at once.";
  }
  if (failingChecks(body).length > 0) {
    return `Fix the content in Rasket, or turn on '${ACKNOWLEDGE_CHECKS_LABEL}' in the step's options to send anyway.`;
  }
  return undefined;
}

/**
 * The error n8n shows for a refused request. The message says what happened in Rasket's own
 * words; the description says how to get unstuck.
 */
export function rasketError(
  context: RasketContext,
  response: RasketResponse<unknown>,
  itemIndex?: number,
): NodeApiError {
  const body = readErrorBody(response.body);
  const description = guidance(response.statusCode, body, response.headers, response.path ?? "");
  return new NodeApiError(context.getNode(), (body ?? {}) as JsonObject, {
    message: describeError(response.statusCode, body),
    httpCode: String(response.statusCode),
    ...(description === undefined ? {} : { description }),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  });
}

/**
 * One request, returned whatever its status. Callers that treat a 404 or a 409 as an answer read
 * `statusCode`; everyone else uses `rasketRequest`, which throws for anything ≥ 400.
 *
 * A `rate_limit_exceeded` 429 is waited out once (its `Retry-After`, at most ten seconds) and
 * retried. A second one is thrown: more retries are the node's own Retry On Fail setting. A quota
 * 429 is never retried, since waiting cannot fix it.
 */
export async function rasketRawRequest<T = IDataObject>(
  context: RasketContext,
  request: RasketRequest,
): Promise<RasketResponse<T>> {
  const options: IHttpRequestOptions = {
    method: request.method ?? "GET",
    url: `${API_BASE_URL}${request.path}`,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(request.headers ?? {}),
    },
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.qs === undefined ? {} : { qs: request.qs }),
  };

  for (let attempt = 0; ; attempt += 1) {
    const raw = (await context.helpers.httpRequestWithAuthentication.call(
      context,
      CREDENTIAL_NAME,
      options,
    )) as IN8nHttpFullResponse;
    const response: RasketResponse<T> = {
      statusCode: raw.statusCode,
      body: raw.body as T,
      headers: raw.headers ?? {},
      path: request.path,
    };
    const name = readErrorBody(response.body)?.name;
    if (response.statusCode === 429 && name === "rate_limit_exceeded" && attempt === 0) {
      await timing.sleep(retryAfterSeconds(response.headers) * 1000);
      continue;
    }
    return response;
  }
}

/** One request whose non-2xx answer is an error. */
export async function rasketRequest<T = IDataObject>(
  context: RasketContext,
  request: RasketRequest,
): Promise<T> {
  const response = await rasketRawRequest<T>(context, request);
  if (response.statusCode >= 400) throw rasketError(context, response, request.itemIndex);
  return response.body;
}

interface ListPage {
  readonly data?: IDataObject[];
  readonly has_more?: boolean;
}

/**
 * A list endpoint, page by page over the `after` cursor (the last row's `id`), until `limit` rows
 * or the end. `limit` undefined reads everything.
 */
export async function rasketList(
  context: RasketContext,
  request: RasketRequest,
  limit?: number,
): Promise<IDataObject[]> {
  const rows: IDataObject[] = [];
  let after: string | undefined;
  for (;;) {
    const pageSize = limit === undefined ? 100 : Math.min(100, limit - rows.length);
    const page = await rasketRequest<ListPage>(context, {
      ...request,
      qs: { ...(request.qs ?? {}), limit: pageSize, ...(after === undefined ? {} : { after }) },
    });
    const data = page.data ?? [];
    rows.push(...data);
    const last = data[data.length - 1];
    if (page.has_more !== true || last === undefined || typeof last.id !== "string") break;
    if (limit !== undefined && rows.length >= limit) break;
    after = last.id;
  }
  return limit === undefined ? rows : rows.slice(0, limit);
}
