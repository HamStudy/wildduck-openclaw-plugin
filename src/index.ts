import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, resolveUserId, resolveAccount, resolveEffectiveAccount } from "./config.js";
import { hasPermission, requirePermission } from "./permissions.js";
import { buildCorrespondenceQuery } from "./query.js";
import type { Permission, PluginConfig, ResolvedConfig } from "./types.js";
import { WildDuckClient } from "./wildduck-client.js";
import { WildDuckUpdateWatcher } from "./watcher.js";

type Runtime = {
  config: ResolvedConfig;
  getClient(accountId?: string): WildDuckClient;
};

type ToolSpec = Omit<AnyAgentTool, "label" | "execute"> & {
  label?: string;
  optional?: boolean;
  execute: (id: string, params: any) => ReturnType<AnyAgentTool["execute"]>;
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
  userId: Type.Optional(Type.String({ description: "WildDuck user id. Uses configured account default or defaultUserId when omitted." })),
  account: Type.Optional(Type.String({ description: "Configured account id. Uses defaultAccount when omitted." })),
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

const DraftParams = Type.Object(
  {
    ...UserParam,
    mailbox: Type.String({ description: "Mailbox id to store the draft in (typically Drafts folder id)." }),
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
    const watchers = new Map<string, WildDuckUpdateWatcher>();
    let startupError: string | undefined;

    try {
      const runtime = createRuntime(rawConfig);
      
      // Start watchers for each account with watch enabled
      for (const [accountId, account] of runtime.config.accounts) {
        if (hasPermission(runtime.config, "watch", accountId) && account.watch.enabled && account.watch.users.length) {
          const watcher = new WildDuckUpdateWatcher(
            runtime.getClient(accountId),
            account.watch,
            logger ?? console,
          );
          watcher.start();
          watchers.set(accountId, watcher);
        }
      }
      
      // Legacy: if no accounts, use global watch config
      if (runtime.config.accounts.size === 0 && hasPermission(runtime.config, "watch") && runtime.config.watch.enabled && runtime.config.watch.users.length) {
        const watcher = new WildDuckUpdateWatcher(
          runtime.getClient(),
          runtime.config.watch,
          logger ?? console,
        );
        watcher.start();
        watchers.set("__global__", watcher);
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
          const accountSummaries: Record<string, unknown> = {};
          for (const [accountId, account] of runtime.config.accounts) {
            accountSummaries[accountId] = {
              userId: account.userId,
              permissions: Array.from(account.permissions).sort(),
              apiUrl: account.apiUrl,
              watch: {
                enabled: account.watch.enabled,
                mode: account.watch.mode,
                users: account.watch.users.length,
              },
            };
          }
          return textResult({
            configured: true,
            apiUrl: runtime.config.apiUrl,
            defaultUserId: runtime.config.defaultUserId ?? null,
            defaultAccount: runtime.config.defaultAccount ?? null,
            permissions: Array.from(runtime.config.permissions).sort(),
            accounts: accountSummaries,
            watchers: {
              active: watchers.size,
              accounts: Array.from(watchers.keys()),
              bufferedEvents: Array.from(watchers.entries()).map(([id, w]) => ({ account: id, events: w.getEvents(10).length })),
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
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(await runtime.getClient(accountId).listMailboxes(resolveUserId(runtime.config, accountId, params.userId), params.includeCounters ?? true));
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
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(
          await runtime.getClient(accountId).listMessages({
            ...params,
            userId: resolveUserId(runtime.config, accountId, params.userId),
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
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(
          await runtime.getClient(accountId).searchMessages({
            ...params,
            userId: resolveUserId(runtime.config, accountId, params.userId),
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
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(
          await runtime.getClient(accountId).searchMessages({
            userId: resolveUserId(runtime.config, accountId, params.userId),
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
        const accountId = params.account;
        requirePermission(runtime.config, params.markAsSeen ? "mutate" : "read", accountId);
        return textResult(
          await runtime.getClient(accountId).getMessage({
            ...params,
            userId: resolveUserId(runtime.config, accountId, params.userId),
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
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(
          await runtime.getClient(accountId).getAttachment({
            ...params,
            userId: resolveUserId(runtime.config, accountId, params.userId),
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "read", {
      name: "wildduck_get_thread",
      description: "Get thread messages by thread id (returns message list). Read-only.",
      parameters: Type.Object(
        {
          ...UserParam,
          thread: Type.String(),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "read", accountId);
        return textResult(
          await runtime.getClient(accountId).searchMessages({
            userId: resolveUserId(runtime.config, accountId, params.userId),
            thread: params.thread,
            limit: params.limit ?? 50,
            searchable: true,
            threadCounters: true,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "send", {
      name: "wildduck_send_message",
      description: "Send a WildDuck message (create draft + submit). Requires send permission.",
      parameters: SubmitParams,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "send", accountId);
        const userId = resolveUserId(runtime.config, accountId, params.userId);
        return textResult(await runtime.getClient(accountId).sendMessage({ ...params, userId }));
      },
    });

    registerIf(api, declaredPermissions, "draft", {
      name: "wildduck_create_draft",
      description: "Create a WildDuck draft message. Requires draft permission.",
      parameters: DraftParams,
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "draft", accountId);
        const userId = resolveUserId(runtime.config, accountId, params.userId);
        return textResult(await runtime.getClient(accountId).createDraft({ ...params, userId }));
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_update_message",
      description: "Update flags on a WildDuck message. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          seen: Type.Optional(Type.Boolean()),
          flagged: Type.Optional(Type.Boolean()),
          deleted: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "mutate", accountId);
        const userId = resolveUserId(runtime.config, accountId, params.userId);
        return textResult(
          await runtime.getClient(accountId).updateMessage({
            userId,
            mailbox: params.mailbox,
            message: params.message,
            seen: params.seen,
            flagged: params.flagged,
            deleted: params.deleted,
          }),
        );
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_move_message",
      description: "Move a WildDuck message to another mailbox. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
          target: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "mutate", accountId);
        const userId = resolveUserId(runtime.config, accountId, params.userId);
        return textResult(await runtime.getClient(accountId).moveMessage({ userId, mailbox: params.mailbox, message: params.message, target: params.target }));
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_delete_message",
      description: "Delete a WildDuck message. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          mailbox: Type.String(),
          message: Type.Union([Type.String(), Type.Number()]),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "mutate", accountId);
        return textResult(await runtime.getClient(accountId).deleteMessage({ userId: resolveUserId(runtime.config, accountId, params.userId), mailbox: params.mailbox, message: params.message }));
      },
    });

    registerIf(api, declaredPermissions, "mutate", {
      name: "wildduck_move_messages",
      description: "Move multiple WildDuck messages to another mailbox. Requires mutate permission.",
      parameters: Type.Object(
        {
          ...UserParam,
          source: Type.String(),
          target: Type.String(),
          messages: Type.Array(Type.Union([Type.String(), Type.Number()])),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "mutate", accountId);
        const userId = resolveUserId(runtime.config, accountId, params.userId);
        const results = [];
        for (const message of params.messages) {
          results.push(await runtime.getClient(accountId).moveMessage({ userId, mailbox: params.source, message, target: params.target }));
        }
        return textResult({ moved: results.length, results });
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
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "filters", accountId);
        return textResult(await runtime.getClient(accountId).createFilter({ userId: resolveUserId(runtime.config, accountId, params.userId), query: params.query, action: params.action }));
      },
    });

    registerIf(api, declaredPermissions, "filters", {
      name: "wildduck_list_filters",
      description: "List WildDuck mail filters. Requires filters permission.",
      parameters: Type.Object(
        {
          ...UserParam,
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "filters", accountId);
        return textResult(await runtime.getClient(accountId).listFilters(resolveUserId(runtime.config, accountId, params.userId)));
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
        const accountId = params.account;
        requirePermission(runtime.config, "filters", accountId);
        return textResult(
          await runtime.getClient(accountId).updateFilter({
            userId: resolveUserId(runtime.config, accountId, params.userId),
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
        const accountId = params.account;
        requirePermission(runtime.config, "filters", accountId);
        return textResult(await runtime.getClient(accountId).deleteFilter(resolveUserId(runtime.config, accountId, params.userId), params.filter));
      },
    });

    registerIf(api, declaredPermissions, "watch", {
      name: "wildduck_get_events",
      description: "Read debounced WildDuck update events buffered by the plugin watcher. Requires watch permission. Optionally scoped to an account.",
      parameters: Type.Object(
        {
          account: Type.Optional(Type.String({ description: "Account id. When omitted, returns events from all active watchers." })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = createRuntime(rawConfig);
        const accountId = params.account;
        requirePermission(runtime.config, "watch", accountId);
        
        if (accountId) {
          const watcher = watchers.get(accountId);
          return textResult({ events: watcher?.getEvents(params.limit ?? 50) ?? [] });
        }
        
        // Return events from all watchers
        const allEvents: unknown[] = [];
        for (const [id, watcher] of watchers) {
          allEvents.push(...watcher.getEvents(params.limit ?? 50).map(e => ({ ...e, account: id === "__global__" ? undefined : id })));
        }
        return textResult({ events: allEvents });
      },
    });

    registerIf(api, declaredPermissions, "watch", {
      name: "wildduck_clear_events",
      description: "Clear debounced WildDuck update events buffered by the plugin watcher. Requires watch permission. Optionally scoped to an account.",
      parameters: Type.Object(
        {
          account: Type.Optional(Type.String({ description: "Account id. When omitted, clears events from all active watchers." })),
        },
        { additionalProperties: false },
      ),
      optional: true,
      async execute() {
        const runtime = createRuntime(rawConfig);
        requirePermission(runtime.config, "watch");
        let cleared = 0;
        for (const watcher of watchers.values()) {
          cleared += watcher.clearEvents().cleared;
        }
        return textResult({ cleared });
      },
    });
  },
});

function createRuntime(rawConfig: PluginConfig): Runtime {
  const config = resolveConfig(rawConfig);
  const clients = new Map<string, WildDuckClient>();
  
  function getClient(accountId?: string): WildDuckClient {
    const { account } = resolveEffectiveAccount(config, accountId);
    const cacheKey = accountId ?? "__global__";
    
    if (!clients.has(cacheKey)) {
      clients.set(cacheKey, new WildDuckClient({
        apiUrl: account?.apiUrl ?? config.apiUrl,
        accessToken: account?.accessToken ?? config.accessToken,
        username: account?.username,
        password: account?.password,
      }));
    }
    return clients.get(cacheKey)!;
  }
  
  return { config, getClient };
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
    if (/token|password|secret|accessToken/i.test(key)) {
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
