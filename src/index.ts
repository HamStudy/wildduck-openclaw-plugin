import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, resolveUserId } from "./config.js";
import { hasPermission, requirePermission } from "./permissions.js";
import { buildCorrespondenceQuery } from "./query.js";
import type { Permission, PluginConfig, ResolvedConfig } from "./types.js";
import { WildDuckClient } from "./wildduck-client.js";
import { WildDuckUpdateWatcher } from "./watcher.js";

type Runtime = {
  config: ResolvedConfig;
  client: WildDuckClient;
};

type ToolSpec = Omit<AnyAgentTool, "label" | "execute"> & {
  label?: string;
  optional?: boolean;
  execute: AnyAgentTool["execute"];
};

const AddressSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    address: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const AttachmentSchema = Type.Object(
  {
    filename: Type.String({ minLength: 1 }),
    contentType: Type.Optional(Type.String()),
    content: Type.String({ minLength: 1, description: "Base64 attachment content." }),
    encoding: Type.Optional(Type.Literal("base64")),
  },
  { additionalProperties: false },
);

const UserParam = {
  userId: Type.Optional(Type.String({ description: "WildDuck user id. Uses configured defaultUserId when omitted." })),
};

const SearchParams = Type.Object(
  {
    ...UserParam,
    q: Type.Optional(
      Type.String({
        description:
          'WildDuck advanced search query, for example `subject:"invoice" in:INBOX`, `(from:a@example.com OR to:a@example.com)`, `has:attachment`, or `thread:<id>`.',
      }),
    ),
    query: Type.Optional(Type.String({ description: "Full-text content/header search. Prefer from/to/subject for fielded email search." })),
    mailbox: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    thread: Type.Optional(Type.String()),
    from: Type.Optional(Type.String({ description: "Partial match against From." })),
    to: Type.Optional(Type.String({ description: "Partial match against To and Cc." })),
    subject: Type.Optional(Type.String()),
    datestart: Type.Optional(Type.String({ description: "Earliest storage date." })),
    dateend: Type.Optional(Type.String({ description: "Latest storage date." })),
    minSize: Type.Optional(Type.Number()),
    maxSize: Type.Optional(Type.Number()),
    attachments: Type.Optional(Type.Boolean()),
    flagged: Type.Optional(Type.Boolean()),
    unseen: Type.Optional(Type.Boolean()),
    seen: Type.Optional(Type.Boolean()),
    searchable: Type.Optional(Type.Boolean({ description: "Exclude Junk and Trash when supported." })),
    includeHeaders: Type.Optional(Type.String({ description: "Comma-separated headers to include." })),
    metaData: Type.Optional(Type.Boolean()),
    threadCounters: Type.Optional(Type.Boolean({ default: true })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })),
    order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
    next: Type.Optional(Type.String()),
    previous: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const SubmitParams = Type.Object(
  {
    ...UserParam,
    to: Type.Optional(Type.Array(AddressSchema)),
    cc: Type.Optional(Type.Array(AddressSchema)),
    bcc: Type.Optional(Type.Array(AddressSchema)),
    subject: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(AttachmentSchema)),
    reference: Type.Optional(
      Type.Object(
        {
          mailbox: Type.String(),
          id: Type.Union([Type.String(), Type.Number()]),
          action: Type.Union([Type.Literal("reply"), Type.Literal("replyAll"), Type.Literal("forward")]),
        },
        { additionalProperties: false },
      ),
    ),
    draft: Type.Optional(
      Type.Object(
        {
          mailbox: Type.String(),
          id: Type.Union([Type.String(), Type.Number()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "wildduck",
  name: "WildDuck",
  description: "Adds permissioned WildDuck REST email tools to OpenClaw.",
  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const logger = api.logger;
    const declaredPermissions = new Set(rawConfig.permissions?.length ? rawConfig.permissions : (["read"] as Permission[]));
    let watcher: WildDuckUpdateWatcher | undefined;
    let startupError: string | undefined;

    try {
      const runtime = createRuntime(rawConfig);
      if (hasPermission(runtime.config, "watch") && runtime.config.watch.enabled) {
        watcher = new WildDuckUpdateWatcher(runtime.client, runtime.config, logger ?? console);
        watcher.start();
      }
    } catch (err) {
      startupError = formatError(err);
    }

    api.registerTool({
      name: "wildduck_status",
      label: "wildduck_status",
      description: "Show WildDuck plugin configuration status, enabled permissions, and watcher state without revealing secrets.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        try {
          const runtime = createRuntime(rawConfig);
          return textResult({
            configured: true,
            apiUrl: runtime.config.apiUrl,
            defaultUserId: runtime.config.defaultUserId ?? null,
            permissions: Array.from(runtime.config.permissions).sort(),
            watch: {
              enabled: runtime.config.watch.enabled,
              mode: runtime.config.watch.mode,
              users: runtime.config.watch.users.length,
              bufferedEvents: watcher?.getEvents(10).length ?? 0,
            },
          });
        } catch (err) {
          return textResult({ configured: false, error: startupError ?? formatError(err) });
        }
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_list_mailboxes",
      description: "List WildDuck mailboxes for a user. Read-only.",
      parameters: Type.Object(
        {
          ...UserParam,
          includeCounters: Type.Optional(Type.Boolean({ default: true })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(await runtime.client.listMailboxes(resolveUserId(runtime.config, params.userId), params.includeCounters ?? true));
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_list_messages",
      description: "List messages in one mailbox. Use search tools for cross-mailbox search. Read-only.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String({ description: "Mailbox id or resolvable mailbox path." }),
          unseen: Type.Optional(Type.Boolean()),
          metaData: Type.Optional(Type.Boolean()),
          threadCounters: Type.Optional(Type.Boolean()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })),
          order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
          next: Type.Optional(Type.String()),
          previous: Type.Optional(Type.String()),
          includeHeaders: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(
          await runtime.client.listMessages({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_search_messages",
      description:
        "Search WildDuck messages with fielded filters and advanced q syntax. Use from/to/subject for address/header searches; use q for OR groups, has:attachment, in:<mailbox>, or thread:<id>. Read-only.",
      parameters: SearchParams,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(
          await runtime.client.searchMessages({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
            threadCounters: params.threadCounters ?? true,
            searchable: params.searchable ?? true,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_search_correspondence",
      description: "Find correspondence with an email address by searching messages from OR to that address. Read-only.",
      parameters: Type.Object(
        {
          ...UserParam,
          address: Type.String({ minLength: 1 }),
          mailbox: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(
          await runtime.client.searchMessages({
            userId: resolveUserId(runtime.config, params.userId),
            q: buildCorrespondenceQuery(params.address, params.mailbox),
            limit: params.limit ?? 50,
            searchable: true,
            threadCounters: true,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_get_message",
      description: "Get one WildDuck message by mailbox and message id/uid. Defaults to not marking as seen. Read-only unless markAsSeen is true.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          replaceCidLinks: Type.Optional(Type.Boolean()),
          markAsSeen: Type.Optional(Type.Boolean({ default: false })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, params.markAsSeen ? "mutate" : "read");
        return textResult(
          await runtime.client.getMessage({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
            markAsSeen: params.markAsSeen ?? false,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_get_attachment",
      description: "Fetch one attachment as base64, with a maxBytes guard. Read-only.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          attachment: Type.String(),
          maxBytes: Type.Optional(Type.Number({ minimum: 1, default: 5242880 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(
          await runtime.client.getAttachment({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_list_addresses",
      description: "List sending addresses/identities for a user. Use before drafting or sending when From identity matters. Read-only.",
      parameters: Type.Object(UserParam, { additionalProperties: false }),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(await runtime.client.listAddresses(resolveUserId(runtime.config, params.userId)));
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_get_autoreply",
      description: "Get autoreply/vacation-response settings for a user. Read-only.",
      parameters: Type.Object(UserParam, { additionalProperties: false }),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        return textResult(await runtime.client.getAutoreply(resolveUserId(runtime.config, params.userId)));
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_get_thread",
      description:
        "Fetch full conversation context by thread id, or by first fetching a message to discover its thread. Read-only and should be used before drafting replies.",
      parameters: Type.Object(
        {
          ...UserParam,
          thread: Type.Optional(Type.String()),
          mailbox: Type.Optional(Type.String()),
          message: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          includeBodies: Type.Optional(Type.Boolean({ default: true })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "read");
        const userId = resolveUserId(runtime.config, params.userId);
        if (params.thread) {
          return textResult(await runtime.client.getThread({ userId, thread: params.thread, includeBodies: params.includeBodies ?? true, limit: params.limit }));
        }
        if (!params.mailbox || params.message === undefined) {
          throw new Error("Pass either thread, or both mailbox and message.");
        }
        return textResult(
          await runtime.client.getThreadForMessage({
            userId,
            mailbox: params.mailbox,
            message: params.message,
            includeBodies: params.includeBodies ?? true,
            limit: params.limit,
            markAsSeen: false,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_update_autoreply",
      description: "Update autoreply/vacation-response settings. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          status: Type.Optional(Type.Boolean()),
          name: Type.Optional(Type.String()),
          subject: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          start: Type.Optional(Type.String()),
          end: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "mutate");
        const { userId: explicitUserId, ...body } = params;
        return textResult(await runtime.client.updateAutoreply(resolveUserId(runtime.config, explicitUserId), body));
      },
    });

    registerIf(api, declaredPermissions, "draft", {
      name: "wildduck_create_draft",
      description:
        "Compose or update a draft on the WildDuck server without sending it. Requires draft permission and never sends mail.",
      parameters: SubmitParams,
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "draft");
        return textResult(
          await runtime.client.createDraft({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "send", {
      name: "wildduck_send_message",
      description: "Send an email through WildDuck. Requires send permission. Use wildduck_create_draft when approval is needed.",
      parameters: SubmitParams,
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "send");
        return textResult(
          await runtime.client.sendMessage({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_update_message",
      description: "Update message flags or metadata. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          seen: Type.Optional(Type.Boolean()),
          flagged: Type.Optional(Type.Boolean()),
          deleted: Type.Optional(Type.Boolean()),
          metaData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "mutate");
        return textResult(
          await runtime.client.updateMessage({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_move_message",
      description: "Move a message to another mailbox. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          target: Type.String({ description: "Target mailbox id." }),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "mutate");
        return textResult(
          await runtime.client.moveMessage({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_delete_message",
      description: "Delete a message. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "mutate");
        return textResult(
          await runtime.client.deleteMessage({
            ...params,
            userId: resolveUserId(runtime.config, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "filters", {
      name: "wildduck_list_filters",
      description: "List WildDuck filters for a user. Requires filters permission.",
      parameters: Type.Object(UserParam, { additionalProperties: false }),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "filters");
        return textResult(await runtime.client.listFilters(resolveUserId(runtime.config, params.userId)));
      },
    });

    registerIf(api, declaredPermissions, "filters", {
      name: "wildduck_create_filter",
      description: "Create a WildDuck mail filter. Requires filters permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          query: Type.Record(Type.String(), Type.Unknown()),
          action: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "filters");
        return textResult(
          await runtime.client.createFilter({
            userId: resolveUserId(runtime.config, params.userId),
            query: params.query,
            action: params.action,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "filters", {
      name: "wildduck_update_filter",
      description: "Update a WildDuck mail filter. Requires filters permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          filter: Type.String(),
          query: Type.Record(Type.String(), Type.Unknown()),
          action: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "filters");
        return textResult(
          await runtime.client.updateFilter({
            userId: resolveUserId(runtime.config, params.userId),
            filter: params.filter,
            query: params.query,
            action: params.action,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "filters", {
      name: "wildduck_delete_filter",
      description: "Delete a WildDuck mail filter. Requires filters permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          filter: Type.String(),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "filters");
        return textResult(await runtime.client.deleteFilter(resolveUserId(runtime.config, params.userId), params.filter));
      },
    });

    registerIf(api, declaredPermissions, "watch", {
      name: "wildduck_get_events",
      description: "Read debounced WildDuck update events buffered by the plugin watcher. Requires watch permission.",
      parameters: Type.Object(
        {
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "watch");
        return textResult({ events: watcher?.getEvents(params.limit ?? 50) ?? [] });
      },
    });

    registerIf(api, declaredPermissions, "watch", {
      name: "wildduck_clear_events",
      description: "Clear debounced WildDuck update events buffered by the plugin watcher. Requires watch permission.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute() {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "watch");
        return textResult(watcher?.clearEvents() ?? { cleared: 0 });
      },
    });
  },
});

function createRuntime(rawConfig: PluginConfig): Runtime {
  const config = resolveConfig(rawConfig);
  return {
    config,
    client: new WildDuckClient({
      apiUrl: config.apiUrl,
      accessToken: config.accessToken,
    }),
  };
}

function registerIf(api: OpenClawPluginApi, permissions: Set<Permission>, permission: Permission, tool: ToolSpec): void {
  if (permissions.has(permission) || permissions.has("admin")) {
    const { optional, ...agentTool } = tool;
    api.registerTool(
      {
        label: tool.label ?? tool.name,
        ...agentTool,
      },
      optional ? { optional: true } : undefined,
    );
  }
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(redactSecrets(value), null, 2),
      },
    ],
    details: value,
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (typeof value !== "object" || !value) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|password|secret/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactSecrets(entry);
    }
  }
  return result;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
