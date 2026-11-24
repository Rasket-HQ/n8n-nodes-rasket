import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
} from "n8n-workflow";
import { vi } from "vitest";

/**
 * A stand-in for the n8n contexts the nodes run in. The one HTTP helper the nodes use,
 * `httpRequestWithAuthentication`, is a mock that records each request and answers from a queue,
 * so nothing reaches the network and every test can assert the exact URL, method, body and headers.
 */

export interface Reply {
  readonly statusCode?: number;
  readonly body?: unknown;
  readonly headers?: IDataObject;
}

export interface Sent {
  readonly credential: string;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly qs: IDataObject | undefined;
  readonly headers: IDataObject;
}

export interface Harness {
  readonly sent: Sent[];
  /** Answers still queued; a test that leaves one unused asserted less than it meant to. */
  readonly queue: Reply[];
  readonly staticData: IDataObject;
  readonly response: { statusCode: number | undefined; json: unknown };
  readonly context: IExecuteFunctions & ILoadOptionsFunctions & IHookFunctions & IWebhookFunctions;
}

export interface HarnessOptions {
  /** Parameters, one object per input item (or one object for a single item). */
  readonly parameters?: IDataObject | IDataObject[];
  readonly replies?: Reply[];
  readonly continueOnFail?: boolean;
  readonly staticData?: IDataObject;
  readonly webhookUrl?: string;
  readonly request?: { rawBody?: unknown; headers?: IDataObject; body?: IDataObject };
}

/** `a.b` paths, as `getNodeParameter("variables.value")` reads them. */
function lookup(source: IDataObject, name: string): unknown {
  return name.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as IDataObject)[key];
  }, source);
}

function extract(value: unknown, extractValue: boolean | undefined): unknown {
  if (
    extractValue === true &&
    typeof value === "object" &&
    value !== null &&
    "__rl" in value &&
    "value" in value
  ) {
    return (value as IDataObject).value;
  }
  return value;
}

/** A resource locator value, as n8n stores one. */
export function rl(value: string, mode = "list"): IDataObject {
  return { __rl: true, mode, value };
}

export function harness(options: HarnessOptions = {}): Harness {
  const items = Array.isArray(options.parameters) ? options.parameters : [options.parameters ?? {}];
  const queue: Reply[] = [...(options.replies ?? [])];
  const sent: Sent[] = [];
  const staticData: IDataObject = options.staticData ?? {};
  const response: Harness["response"] = { statusCode: undefined, json: undefined };

  const httpRequestWithAuthentication = vi.fn(
    (credential: string, request: IHttpRequestOptions) => {
      sent.push({
        credential,
        method: request.method ?? "GET",
        url: request.url,
        body: request.body,
        qs: request.qs,
        headers: request.headers ?? {},
      });
      const reply = queue.shift();
      if (reply === undefined) {
        throw new Error(`No reply queued for ${request.method ?? "GET"} ${request.url}`);
      }
      return Promise.resolve({
        statusCode: reply.statusCode ?? 200,
        body: reply.body ?? {},
        headers: reply.headers ?? {},
      });
    },
  );

  const node = {
    id: "node-1",
    name: "Rasket",
    type: "n8n-nodes-rasket.rasket",
    typeVersion: 1,
    position: [0, 0] as [number, number],
    parameters: {},
  };

  const context = {
    getNode: () => node,
    getInputData: () => items.map(() => ({ json: {} })),
    continueOnFail: () => options.continueOnFail ?? false,
    getNodeParameter: (
      name: string,
      itemIndexOrFallback?: unknown,
      fallback?: unknown,
      parameterOptions?: { extractValue?: boolean },
    ) => {
      // Execute contexts pass an item index; hook and webhook contexts pass the fallback first.
      const indexed = typeof itemIndexOrFallback === "number";
      const parameters = items[indexed ? itemIndexOrFallback : 0] ?? {};
      const value = lookup(parameters, name);
      if (value === undefined) {
        const backup = indexed ? fallback : itemIndexOrFallback;
        if (backup === undefined) throw new Error(`Could not get parameter "${name}"`);
        return backup;
      }
      return extract(value, parameterOptions?.extractValue);
    },
    getCurrentNodeParameter: (name: string, parameterOptions?: { extractValue?: boolean }) =>
      extract(lookup(items[0] ?? {}, name), parameterOptions?.extractValue),
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => options.webhookUrl ?? "https://n8n.example.com/webhook/abc/webhook",
    getRequestObject: () => ({ rawBody: options.request?.rawBody }),
    getResponseObject: () => ({
      status(code: number) {
        response.statusCode = code;
        return {
          json(body: unknown) {
            response.json = body;
          },
        };
      },
    }),
    getHeaderData: () => options.request?.headers ?? {},
    getBodyData: () => options.request?.body ?? {},
    helpers: {
      httpRequestWithAuthentication,
      returnJsonArray: (data: IDataObject | IDataObject[]) =>
        (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
    },
  };

  return {
    sent,
    queue,
    staticData,
    response,
    context: context as unknown as Harness["context"],
  };
}

/** The API's error body. */
export function apiError(
  statusCode: number,
  name: string,
  message = `${name}.`,
  extra: IDataObject = {},
): Reply {
  return { statusCode, body: { statusCode, name, message, ...extra } };
}
