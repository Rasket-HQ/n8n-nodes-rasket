import type {
  FieldType,
  IDataObject,
  ILoadOptionsFunctions,
  INodeListSearchItems,
  INodeListSearchResult,
  INodePropertyOptions,
  ResourceMapperField,
  ResourceMapperFields,
} from "n8n-workflow";

import { rasketRawRequest, rasketRequest, segment } from "./transport";

/**
 * What fills the pickers: searchable lists for the resource locators, plain lists for the
 * multi-selects, and the fields of the three resource mappers (a template's variables, the team's
 * contact properties, a custom event's declared fields).
 *
 * A list reads one page of 100, newest first, per scroll; the cursor is the last row's `id`.
 */

interface Page {
  readonly data?: IDataObject[];
  readonly has_more?: boolean;
}

function text(row: IDataObject, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Case-insensitive "contains", for endpoints with no `search` of their own. */
function matches(name: string, filter?: string): boolean {
  return (
    filter === undefined ||
    filter.trim() === "" ||
    name.toLowerCase().includes(filter.trim().toLowerCase())
  );
}

async function searchList(
  context: ILoadOptionsFunctions,
  options: {
    readonly path: string;
    readonly qs?: IDataObject;
    readonly filter?: string | undefined;
    /** Whether the endpoint takes `search`; otherwise the page is filtered here. */
    readonly serverSearch: boolean;
    readonly paginationToken?: string | undefined;
    readonly name: (row: IDataObject) => string;
  },
): Promise<INodeListSearchResult> {
  const filter = options.filter?.trim();
  const page = await rasketRequest<Page>(context, {
    path: options.path,
    qs: {
      ...(options.qs ?? {}),
      limit: 100,
      ...(options.serverSearch && filter ? { search: filter } : {}),
      ...(options.paginationToken ? { after: options.paginationToken } : {}),
    },
  });
  const rows = page.data ?? [];
  const results: INodeListSearchItems[] = rows.flatMap((row) => {
    const id = text(row, "id");
    if (id === undefined) return [];
    const name = options.name(row);
    if (!options.serverSearch && !matches(name, filter)) return [];
    return [{ name, value: id }];
  });
  const last = rows[rows.length - 1];
  const next = page.has_more === true && last !== undefined ? text(last, "id") : undefined;
  return next === undefined ? { results } : { results, paginationToken: next };
}

function templateName(row: IDataObject): string {
  const name = text(row, "name") ?? text(row, "id") ?? "";
  const alias = text(row, "alias");
  return alias === undefined ? name : `${name} (${alias})`;
}

function campaignName(row: IDataObject): string {
  return text(row, "name") ?? text(row, "id") ?? "";
}

async function campaigns(
  context: ILoadOptionsFunctions,
  statuses: readonly string[],
  filter?: string,
): Promise<INodeListSearchResult> {
  const lists = await Promise.all(
    statuses.map((status) =>
      searchList(context, {
        path: "/broadcasts",
        qs: { status },
        filter,
        serverSearch: true,
        name: (row) =>
          statuses.length > 1 ? `${campaignName(row)} (${status})` : campaignName(row),
      }),
    ),
  );
  return { results: lists.flatMap((list) => list.results) };
}

interface DomainRow extends IDataObject {
  readonly name?: string;
  readonly status?: string;
  readonly managed?: boolean;
  readonly capabilities?: { readonly sending?: string };
}

export const listSearch = {
  async searchPublishedTemplates(
    this: ILoadOptionsFunctions,
    filter?: string,
    paginationToken?: string,
  ): Promise<INodeListSearchResult> {
    return searchList(this, {
      path: "/templates",
      qs: { status: "published" },
      filter,
      serverSearch: true,
      paginationToken,
      name: templateName,
    });
  },

  async searchTemplates(
    this: ILoadOptionsFunctions,
    filter?: string,
    paginationToken?: string,
  ): Promise<INodeListSearchResult> {
    return searchList(this, {
      path: "/templates",
      filter,
      serverSearch: true,
      paginationToken,
      name: templateName,
    });
  },

  async searchSegments(
    this: ILoadOptionsFunctions,
    filter?: string,
    paginationToken?: string,
  ): Promise<INodeListSearchResult> {
    return searchList(this, {
      path: "/segments",
      filter,
      serverSearch: false,
      paginationToken,
      name: (row) => text(row, "name") ?? text(row, "id") ?? "",
    });
  },

  async searchCampaigns(
    this: ILoadOptionsFunctions,
    filter?: string,
    paginationToken?: string,
  ): Promise<INodeListSearchResult> {
    return searchList(this, {
      path: "/broadcasts",
      filter,
      serverSearch: true,
      paginationToken,
      name: (row) => `${campaignName(row)} (${text(row, "status") ?? "unknown"})`,
    });
  },

  /** Drafts: the only campaigns Send and Send Test can act on. */
  async searchDraftCampaigns(
    this: ILoadOptionsFunctions,
    filter?: string,
  ): Promise<INodeListSearchResult> {
    return campaigns(this, ["draft"], filter);
  },

  /** Sending, queued and scheduled campaigns: every status Cancel can still stop. */
  async searchPendingCampaigns(
    this: ILoadOptionsFunctions,
    filter?: string,
  ): Promise<INodeListSearchResult> {
    return campaigns(this, ["sending", "queued", "scheduled"], filter);
  },

  /** Emails still waiting to go, by subject, recipients and time (UTC, as stored). */
  async searchScheduledEmails(
    this: ILoadOptionsFunctions,
    filter?: string,
    paginationToken?: string,
  ): Promise<INodeListSearchResult> {
    return searchList(this, {
      path: "/emails",
      qs: { status: "scheduled" },
      filter,
      serverSearch: true,
      paginationToken,
      name: (row) => {
        const to = Array.isArray(row.to)
          ? row.to.filter((address) => typeof address === "string").join(", ")
          : "";
        const at = text(row, "scheduled_at");
        return `${text(row, "subject") ?? "(no subject)"} → ${to}${at === undefined ? "" : ` — ${at}`}`;
      },
    });
  },

  /**
   * `hello@<domain>` for each verified domain that can send. A choice is a whole address because the
   * value is what gets sent; the Address mode takes any other address. The managed domain only
   * reaches the team's own members, which its label says.
   */
  async searchFromAddresses(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
    const page = await rasketRequest<Page>(this, {
      path: "/domains",
      qs: { limit: 100, status: "verified" },
    });
    const results = ((page.data ?? []) as DomainRow[])
      .filter(
        (domain) =>
          typeof domain.name === "string" &&
          domain.status === "verified" &&
          domain.capabilities?.sending !== "disabled",
      )
      .map((domain) => ({
        name:
          domain.managed === true
            ? `hello@${String(domain.name)} (team members only)`
            : `hello@${String(domain.name)}`,
        value: `hello@${String(domain.name)}`,
      }));
    return { results };
  },
};

async function options(
  context: ILoadOptionsFunctions,
  path: string,
  value: (row: IDataObject) => string | undefined = (row) => text(row, "id"),
  keep: (row: IDataObject) => boolean = () => true,
): Promise<INodePropertyOptions[]> {
  const page = await rasketRequest<Page>(context, {
    path,
    qs: { limit: 100 },
  });
  return (page.data ?? []).filter(keep).flatMap((row) => {
    const id = value(row);
    if (id === undefined) return [];
    const description = text(row, "description");
    return [
      {
        name: text(row, "name") ?? id,
        value: id,
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
}

export const loadOptions = {
  async getTopics(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return options(this, "/topics");
  },

  /**
   * Topics an email campaign can target: those whose `channels` include `email`. Rasket refuses an
   * email campaign with an SMS-only topic. A row without `channels` is kept rather than hidden.
   */
  async getEmailTopics(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return options(this, "/topics", undefined, (row) =>
      Array.isArray(row.channels) ? (row.channels as unknown[]).includes("email") : true,
    );
  },

  async getSegments(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return options(this, "/segments");
  },

  /** The value is the event's name, which is what `POST /events/send` takes. */
  async getEvents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return options(this, "/events", (row) => text(row, "name"));
  },
};

/** How many pages of 100 to read before giving up on a template's published version. */
const MAX_PAGES = 5;

interface TemplateVariable {
  readonly key: string;
  readonly type?: string;
  readonly fallback_value?: unknown;
}

interface VersionRow extends IDataObject {
  readonly id: string;
  readonly published?: boolean;
  readonly variables?: TemplateVariable[];
}

const VARIABLE_TYPES: Record<string, FieldType> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  list: "array",
};

function field(
  id: string,
  type: FieldType,
  required: boolean,
  displayName: string = id,
): ResourceMapperField {
  return {
    id,
    displayName,
    type,
    required,
    defaultMatch: false,
    canBeUsedToMatch: false,
    display: true,
  };
}

function notice(text: string): ResourceMapperFields {
  return { fields: [], emptyFieldsNotice: text };
}

/** The current value of a parameter in the editor; a resource locator gives its value. */
function current(context: ILoadOptionsFunctions, name: string): string | undefined {
  const value = context.getCurrentNodeParameter(name, { extractValue: true });
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The published version, reading newest first until one says `published: true`. The variables come
 * from it rather than `GET /templates/{id}`, which shows an open draft.
 */
async function publishedVersion(
  context: ILoadOptionsFunctions,
  template: string,
): Promise<VersionRow | null> {
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await rasketRawRequest<Page>(context, {
      path: `/templates/${segment(template)}/versions`,
      qs: { limit: 100, ...(after === undefined ? {} : { after }) },
    });
    if (response.statusCode >= 400) return null;
    const rows = (response.body.data ?? []) as VersionRow[];
    const published = rows.find((version) => version.published === true);
    if (published !== undefined) return published;
    const last = rows[rows.length - 1];
    if (response.body.has_more !== true || last === undefined) return null;
    after = last.id;
  }
  return null;
}

export const resourceMapping = {
  /** One field per variable of the template's published version; required when it has no fallback. */
  async getTemplateVariables(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    const template = current(this, "template");
    if (template === undefined) return notice("Pick a template first.");
    if (template.includes("{{")) {
      return notice(
        "The template comes from an expression, so its variables can't be listed here.",
      );
    }
    const version = await publishedVersion(this, template);
    if (version === null) {
      return notice(
        "This template has no published version, or it was deleted. Publish it in Rasket → Templates.",
      );
    }
    return {
      fields: (version.variables ?? []).map((variable) =>
        field(
          variable.key,
          VARIABLE_TYPES[variable.type ?? "string"] ?? "string",
          variable.fallback_value === undefined,
        ),
      ),
    };
  },

  /** The team's contact properties, typed. Five pages of 100 at most. */
  async getContactProperties(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    const fields: ResourceMapperField[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await rasketRequest<Page>(this, {
        path: "/contact-properties",
        qs: { limit: 100, ...(after === undefined ? {} : { after }) },
      });
      const rows = response.data ?? [];
      for (const row of rows) {
        const key = text(row, "key");
        const type = text(row, "type");
        if (key === undefined) continue;
        fields.push(
          field(
            key,
            type === "number" ? "number" : type === "boolean" ? "boolean" : "string",
            false,
          ),
        );
      }
      const last = rows[rows.length - 1];
      if (response.has_more !== true || last === undefined || text(last, "id") === undefined) break;
      after = text(last, "id");
    }
    return fields.length === 0
      ? notice(
          "Your team has no contact properties yet. One appears here once a contact has a value for it.",
        )
      : { fields };
  },

  /** The custom event's declared fields; a `date` field is a date and time. */
  async getEventFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    const event = current(this, "event");
    if (event === undefined) return notice("Pick an event first.");
    if (event.includes("{{")) {
      return notice("The event comes from an expression, so its fields can't be listed here.");
    }
    const response = await rasketRawRequest<IDataObject>(this, {
      path: `/events/${segment(event)}`,
    });
    if (response.statusCode >= 400) {
      return notice(`Rasket has no event '${event}'. Create it in Rasket first, or pick another.`);
    }
    const schema = response.body.schema;
    const fields = Object.entries(
      typeof schema === "object" && schema !== null ? schema : {},
    ).flatMap(([key, type]) => {
      if (type === "number") return [field(key, "number", false)];
      if (type === "boolean") return [field(key, "boolean", false)];
      if (type === "date") return [field(key, "dateTime", false)];
      if (type === "string") return [field(key, "string", false)];
      return [];
    });
    return fields.length === 0
      ? notice("This event declares no fields. Add values under 'More Data'.")
      : { fields };
  },
};
