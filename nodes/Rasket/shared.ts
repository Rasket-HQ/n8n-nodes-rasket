import type {
  IDataObject,
  IDisplayOptions,
  IExecuteFunctions,
  INodeProperties,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import { ACKNOWLEDGE_CHECKS_LABEL } from "./transport";

/**
 * What the resources share: the shape of an operation, the reusable parameters (the pickers, the
 * Return All/Limit pair, Simplify), and reading n8n's loosely typed parameter values.
 */

/** One operation: run for one input item, return the JSON it outputs (one item or several). */
export type Operation = (
  this: IExecuteFunctions,
  itemIndex: number,
) => Promise<IDataObject | IDataObject[]>;

/** `POST /emails` caps `to` at 50 recipients, and `Idempotency-Key` at 256 characters. */
export const MAX_RECIPIENTS = 50;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export function show(resource: string, operation: readonly string[]): IDisplayOptions {
  return { show: { resource: [resource], operation: [...operation] } };
}

/** A picker for one Rasket record: a searchable list first, an ID second. */
export function locator(options: {
  readonly name: string;
  readonly displayName: string;
  readonly searchListMethod: string;
  readonly placeholder: string;
  readonly description: string;
  readonly displayOptions: IDisplayOptions;
  readonly required?: boolean;
}): INodeProperties {
  return {
    displayName: options.displayName,
    name: options.name,
    type: "resourceLocator",
    default: { mode: "list", value: "" },
    required: options.required ?? true,
    description: options.description,
    displayOptions: options.displayOptions,
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        typeOptions: { searchListMethod: options.searchListMethod, searchable: true },
      },
      {
        displayName: "By ID",
        name: "id",
        type: "string",
        placeholder: options.placeholder,
      },
    ],
  };
}

/**
 * The sender: `hello@<domain>` for each verified sending domain, or any address typed in. A team
 * with no verified domain sees that said in the list's empty state, and the API refuses the send.
 */
export function fromLocator(displayOptions: IDisplayOptions, required: boolean): INodeProperties {
  return {
    displayName: "From",
    name: "from",
    type: "resourceLocator",
    default: { mode: "list", value: "" },
    required,
    description: required
      ? "The sender, on one of your verified domains"
      : "The sender, on one of your verified domains. Leave empty to use the template's sender.",
    displayOptions,
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        typeOptions: { searchListMethod: "searchFromAddresses", searchable: false },
      },
      {
        displayName: "Address",
        name: "address",
        type: "string",
        placeholder: "e.g. Nathan Smith <nathan@example.com>",
      },
    ],
  };
}

export function returnAllAndLimit(resource: string): INodeProperties[] {
  return [
    {
      displayName: "Return All",
      name: "returnAll",
      type: "boolean",
      default: false,
      description: "Whether to return all results or only up to a given limit",
      displayOptions: show(resource, ["getAll"]),
    },
    {
      displayName: "Limit",
      name: "limit",
      type: "number",
      default: 50,
      typeOptions: { minValue: 1 },
      description: "Max number of results to return",
      displayOptions: { show: { resource: [resource], operation: ["getAll"], returnAll: [false] } },
    },
  ];
}

export function simplifyParameter(
  resource: string,
  operations: readonly string[],
): INodeProperties {
  return {
    displayName: "Simplify",
    name: "simplify",
    type: "boolean",
    default: true,
    description: "Whether to return a simplified version of the response instead of the raw data",
    displayOptions: show(resource, operations),
  };
}

/** The Limit for Get Many, or `undefined` when Return All is on. */
export function readLimit(context: IExecuteFunctions, itemIndex: number): number | undefined {
  const returnAll = context.getNodeParameter("returnAll", itemIndex, false);
  return returnAll ? undefined : context.getNodeParameter("limit", itemIndex, 50);
}

/** A resource locator's value, trimmed; empty when nothing was picked. */
export function locatorValue(context: IExecuteFunctions, name: string, itemIndex: number): string {
  const value = context.getNodeParameter(name, itemIndex, "", { extractValue: true });
  return scalarText(value);
}

/** A string trimmed, a number or boolean written out, anything else empty. */
export function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** A required text parameter, trimmed; a blank one names the parameter in the error. */
export function requiredString(
  context: IExecuteFunctions,
  name: string,
  displayName: string,
  itemIndex: number,
): string {
  const raw = context.getNodeParameter(name, itemIndex, "");
  const value = scalarText(raw);
  if (value === "") {
    throw new NodeOperationError(context.getNode(), `The '${displayName}' parameter is empty`, {
      itemIndex,
      description: `Fill in '${displayName}', or map a value into it from an earlier node.`,
    });
  }
  return value;
}

/** A required locator value; a blank one names the parameter in the error. */
export function requiredLocator(
  context: IExecuteFunctions,
  name: string,
  displayName: string,
  itemIndex: number,
): string {
  const value = locatorValue(context, name, itemIndex);
  if (value === "") {
    throw new NodeOperationError(context.getNode(), `No ${displayName.toLowerCase()} is selected`, {
      itemIndex,
      description: `Pick one in '${displayName}', or switch it to 'By ID' and map an ID.`,
    });
  }
  return value;
}

/** Text, a number or a boolean as trimmed text; anything else is `undefined`. */
export function optionalText(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Addresses as a list: an array, or one comma-separated string. Blanks are dropped. */
export function addressList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cleaned = items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
  return cleaned.length === 0 ? undefined : cleaned;
}

/** A multi-select value as a list of IDs. */
export function idList(value: unknown): string[] {
  return addressList(value) ?? [];
}

/** Leave out every key whose value is `undefined`, so the API never sees a `null` it did not ask for. */
export function defined(body: Record<string, unknown>): IDataObject {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  ) as IDataObject;
}

/** `true`/`false` from a boolean, or from the text an expression may produce. */
export function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return undefined;
}

/** A number from a number, or from numeric text. */
export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The values a resource mapper holds, blanks left out. */
export function mappedValues(
  context: IExecuteFunctions,
  name: string,
  itemIndex: number,
): Record<string, unknown> {
  const raw = context.getNodeParameter(`${name}.value`, itemIndex, {}) as Record<
    string,
    unknown
  > | null;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    values[key] = value;
  }
  return values;
}

/** A fixed collection of name/value pairs as an object. */
export function pairs(value: unknown): Record<string, string> | undefined {
  const rows =
    typeof value === "object" && value !== null && Array.isArray((value as IDataObject).pair)
      ? ((value as IDataObject).pair as IDataObject[])
      : [];
  const entries = rows
    .map((row) => [optionalText(row.name), scalarText(row.value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[0] !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** A name/value fixed collection parameter. */
export function pairsParameter(options: {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly placeholder: string;
}): INodeProperties {
  return {
    displayName: options.displayName,
    name: options.name,
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: options.placeholder,
    description: options.description,
    options: [
      {
        displayName: "Pair",
        name: "pair",
        values: [
          { displayName: "Name", name: "name", type: "string", default: "" },
          { displayName: "Value", name: "value", type: "string", default: "" },
        ],
      },
    ],
  };
}

/** The Idempotency-Key header, when one was given; a key that is too long is refused here. */
export function idempotencyHeader(
  context: IExecuteFunctions,
  key: unknown,
  itemIndex: number,
): IDataObject | undefined {
  const value = optionalText(key);
  if (value === undefined) return undefined;
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new NodeOperationError(
      context.getNode(),
      `The idempotency key is ${String(value.length)} characters long`,
      {
        itemIndex,
        description: `Rasket accepts at most ${String(MAX_IDEMPOTENCY_KEY_LENGTH)}. Map a shorter unique value, such as an ID.`,
      },
    );
  }
  return { "Idempotency-Key": value };
}

export const IDEMPOTENCY_KEY_OPTION: INodeProperties = {
  displayName: "Idempotency Key",
  name: "idempotencyKey",
  type: "string",
  default: "",
  description:
    "Map something unique, such as an ID from your trigger. A second send with the same key within 24 hours returns the first email instead of sending again.",
};

/** `409 resource_locked`: the job is being claimed right now; a moment later the answer is final. */
export function isLocked(statusCode: number, body: unknown): boolean {
  return (
    statusCode === 409 &&
    typeof body === "object" &&
    body !== null &&
    (body as IDataObject).name === "resource_locked"
  );
}

/**
 * Send Despite Failed Checks: `acknowledge_checks: true` on a campaign send, which goes ahead even
 * though a pre-send content check fails (the refusal lists them). Off sends nothing extra.
 */
export const ACKNOWLEDGE_CHECKS_OPTION: INodeProperties = {
  displayName: ACKNOWLEDGE_CHECKS_LABEL,
  name: "acknowledgeChecks",
  type: "boolean",
  default: false,
  description:
    "Whether to send even when a pre-send check fails, such as a broken link or a missing unsubscribe link. Turn it on only after reading the failing checks.",
};

/** `{ acknowledge_checks: true }` when the option is on, nothing otherwise. */
export function acknowledgeChecks(options: IDataObject): IDataObject {
  return booleanValue(options.acknowledgeChecks) === true ? { acknowledge_checks: true } : {};
}

const DAY_MS = 86_400_000;

/** A date, or a date and a time, with no offset: what n8n's date picker gives. */
const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

/** The zone's offset from UTC at `instant`, in milliseconds (New York in winter: -5 h). */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time (as UTC milliseconds) names in `timeZone`. Of the offsets either
 * side of it, the ones that read back as that wall clock are valid: an ambiguous time (the hour a
 * clock goes back) takes the earlier instant, and a time that does not exist (the hour a clock
 * skips) moves on by the jump, as a clock set before the change would show it.
 */
function wallClockToInstant(wall: number, timeZone: string): number {
  const before = zoneOffset(wall - DAY_MS, timeZone);
  const after = zoneOffset(wall + DAY_MS, timeZone);
  const valid = [before, after]
    .map((offset) => wall - offset)
    .filter((instant) => zoneOffset(instant, timeZone) === wall - instant);
  return valid.length > 0 ? Math.min(...valid) : wall - before;
}

/**
 * A date parameter as the ISO instant the API takes. n8n's date picker gives a time with no offset
 * (`2026-10-03T09:00:00`), which means the workflow's time zone (its settings, or the instance's
 * `GENERIC_TIMEZONE`), never the server's: `new Date` alone would read it as UTC on n8n Cloud and
 * in Docker. A value with an offset or `Z`, a Luxon `DateTime` or a `Date` from an expression keep
 * their instant. Anything else (a phrase the API reads, such as `in 2 hours`) goes as given.
 * `undefined` for a blank value.
 */
export function zonedInstant(context: IExecuteFunctions, raw: unknown): string | undefined {
  if (typeof raw === "object" && raw !== null) {
    const value = raw as { toISO?: unknown; toISOString?: unknown };
    const method = typeof value.toISO === "function" ? value.toISO : value.toISOString;
    const iso: unknown = typeof method === "function" ? method.call(raw) : undefined;
    return typeof iso === "string" ? zonedInstant(context, iso) : undefined;
  }
  const text = optionalText(raw);
  if (text === undefined) return undefined;
  const wall = WALL_CLOCK.exec(text);
  if (wall !== null) {
    const [, year, month, day, hour, minute, second, fraction] = wall;
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
      Number((fraction ?? "0").padEnd(3, "0")),
    );
    try {
      if (!Number.isNaN(utc)) {
        return new Date(wallClockToInstant(utc, context.getTimezone())).toISOString();
      }
    } catch {
      // An unknown zone name: read it as before, below.
    }
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}
