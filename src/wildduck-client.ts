import { buildQueryString } from "./query.js";
import type { Address, AttachmentInput, SubmitMessageInput } from "./types.js";

export type SearchMessagesInput = {
  userId: string;
  q?: string;
  query?: string;
  mailbox?: string;
  id?: string;
  thread?: string;
  from?: string;
  to?: string;
  subject?: string;
  datestart?: string;
  dateend?: string;
  minSize?: number;
  maxSize?: number;
  attachments?: boolean;
  flagged?: boolean;
  unseen?: boolean;
  seen?: boolean;
  searchable?: boolean;
  includeHeaders?: string;
  metaData?: boolean;
  threadCounters?: boolean;
  limit?: number;
  order?: "asc" | "desc";
  next?: string;
  previous?: string;
};

export type ListMessagesInput = {
  userId: string;
  mailbox: string;
  unseen?: boolean;
  metaData?: boolean;
  threadCounters?: boolean;
  limit?: number;
  order?: "asc" | "desc";
  next?: string;
  previous?: string;
  includeHeaders?: string | boolean;
};

export type GetMessageInput = {
  userId: string;
  mailbox: string;
  message: string | number;
  replaceCidLinks?: boolean;
  markAsSeen?: boolean;
};

export type UpdateMessageInput = {
  userId: string;
  mailbox: string;
  message: string | number;
  seen?: boolean;
  flagged?: boolean;
  deleted?: boolean;
  metaData?: Record<string, unknown>;
};

export type MoveMessageInput = {
  userId: string;
  mailbox: string;
  message: string | number;
  target: string;
};

export type DeleteMessageInput = {
  userId: string;
  mailbox: string;
  message: string | number;
};

export type GetAttachmentInput = {
  userId: string;
  mailbox: string;
  message: string | number;
  attachment: string;
  maxBytes?: number;
};

export type CreateFilterInput = {
  userId: string;
  query: Record<string, unknown>;
  action: Record<string, unknown>;
};

type ClientOptions = {
  apiUrl: string;
  accessToken: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
};

export class WildDuckClient {
  private readonly apiUrl: string;
  private accessToken: string;
  private readonly initialAccessToken: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;
  private authPromise?: Promise<string>;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl;
    this.accessToken = options.accessToken;
    this.initialAccessToken = options.accessToken;
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listMailboxes(userId: string, includeCounters = true): Promise<unknown> {
    return this.request("GET", `/users/${encodeURIComponent(userId)}/mailboxes`, {
      query: { counters: includeCounters },
    });
  }

  async listMessages(input: ListMessagesInput): Promise<unknown> {
    const { userId, mailbox, includeHeaders, ...query } = input;
    return this.request("GET", `/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(mailbox)}/messages`, {
      query: {
        ...query,
        includeHeaders: includeHeaders === true ? "true" : includeHeaders,
      },
    });
  }

  async searchMessages(input: SearchMessagesInput): Promise<unknown> {
    const { userId, ...query } = input;
    return this.request("GET", `/users/${encodeURIComponent(userId)}/search`, { query });
  }

  async getMessage(input: GetMessageInput): Promise<unknown> {
    const { userId, mailbox, message, ...query } = input;
    return this.request(
      "GET",
      `/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(String(message))}`,
      { query },
    );
  }

  async getThread(input: { userId: string; thread: string; includeBodies?: boolean; limit?: number }): Promise<unknown> {
    const listing = await this.searchMessages({
      userId: input.userId,
      q: `thread:${input.thread}`,
      limit: input.limit ?? 100,
      order: "asc",
      threadCounters: true,
      includeHeaders: "Message-ID,References,In-Reply-To",
    });

    if (!input.includeBodies || !isSearchResponse(listing)) {
      return listing;
    }

    const messages = [];
    for (const entry of listing.results) {
      if (!entry.mailbox || entry.id === undefined) {
        continue;
      }
      messages.push(
        await this.getMessage({
          userId: input.userId,
          mailbox: String(entry.mailbox),
          message: entry.id,
          markAsSeen: false,
        }),
      );
    }

    return {
      ...listing,
      results: messages,
    };
  }

  async getThreadForMessage(input: GetMessageInput & { includeBodies?: boolean; limit?: number }): Promise<unknown> {
    const message = await this.getMessage({ ...input, markAsSeen: input.markAsSeen ?? false });
    const thread = extractThread(message);
    if (!thread) {
      return {
        success: true,
        total: 1,
        results: [message],
      };
    }
    return this.getThread({
      userId: input.userId,
      thread,
      includeBodies: input.includeBodies,
      limit: input.limit,
    });
  }

  async createDraft(input: SubmitMessageInput & { userId: string }): Promise<unknown> {
    return this.submitMessage(input.userId, {
      ...buildSubmitBody(input),
      isDraft: true,
      uploadOnly: true,
    });
  }

  async sendMessage(input: SubmitMessageInput & { userId: string }): Promise<unknown> {
    return this.submitMessage(input.userId, buildSubmitBody(input));
  }

  async updateMessage(input: UpdateMessageInput): Promise<unknown> {
    const { userId, mailbox, message, ...body } = input;
    return this.request(
      "PUT",
      `/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(String(message))}`,
      { body },
    );
  }

  async moveMessage(input: MoveMessageInput): Promise<unknown> {
    return this.request(
      "PUT",
      `/users/${encodeURIComponent(input.userId)}/mailboxes/${encodeURIComponent(input.mailbox)}/messages/${encodeURIComponent(
        String(input.message),
      )}/move`,
      { body: { mailbox: input.target } },
    );
  }

  async deleteMessage(input: DeleteMessageInput): Promise<unknown> {
    return this.request(
      "DELETE",
      `/users/${encodeURIComponent(input.userId)}/mailboxes/${encodeURIComponent(input.mailbox)}/messages/${encodeURIComponent(
        String(input.message),
      )}`,
    );
  }

  async getAttachment(input: GetAttachmentInput): Promise<unknown> {
    const response = await this.rawRequest(
      "GET",
      `/users/${encodeURIComponent(input.userId)}/mailboxes/${encodeURIComponent(input.mailbox)}/messages/${encodeURIComponent(
        String(input.message),
      )}/attachments/${encodeURIComponent(input.attachment)}`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Attachment is ${bytes.byteLength} bytes, which exceeds maxBytes=${maxBytes}.`);
    }
    return {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      size: bytes.byteLength,
      contentBase64: bytesToBase64(bytes),
    };
  }

  async listAddresses(userId: string): Promise<unknown> {
    return this.request("GET", `/users/${encodeURIComponent(userId)}/addresses`);
  }

  async getAutoreply(userId: string): Promise<unknown> {
    return this.request("GET", `/users/${encodeURIComponent(userId)}/autoreply`);
  }

  async updateAutoreply(userId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/users/${encodeURIComponent(userId)}/autoreply`, { body });
  }

  async listFilters(userId: string): Promise<unknown> {
    return this.request("GET", `/users/${encodeURIComponent(userId)}/filters`);
  }

  async createFilter(input: CreateFilterInput): Promise<unknown> {
    return this.request("POST", `/users/${encodeURIComponent(input.userId)}/filters`, {
      body: {
        query: input.query,
        action: input.action,
      },
    });
  }

  async updateFilter(input: CreateFilterInput & { filter: string }): Promise<unknown> {
    return this.request("PUT", `/users/${encodeURIComponent(input.userId)}/filters/${encodeURIComponent(input.filter)}`, {
      body: {
        query: input.query,
        action: input.action,
      },
    });
  }

  async deleteFilter(userId: string, filter: string): Promise<unknown> {
    return this.request("DELETE", `/users/${encodeURIComponent(userId)}/filters/${encodeURIComponent(filter)}`);
  }

  async authenticate(username: string, password: string, sess?: string, ip?: string): Promise<unknown> {
    return this.request("POST", "/authenticate", {
      body: { username, password, sess, ip },
    });
  }

  async openUpdatesStream(userId: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    await this.ensureAuth();
    const response = await this.fetchImpl(this.createUpdatesUrl(userId, lastEventId), {
      method: "GET",
      headers: {
        "x-access-token": this.accessToken,
      },
      signal,
    });
    if (!response.ok) {
      throw new WildDuckApiError(response.status, await response.text());
    }
    return response;
  }

  createUpdatesUrl(userId: string, lastEventId?: string): string {
    return `${this.apiUrl}/users/${encodeURIComponent(userId)}/updates${buildQueryString({ "Last-Event-ID": lastEventId })}`;
  }

  private async submitMessage(userId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/users/${encodeURIComponent(userId)}/submit`, { body });
  }

  private async ensureAuth(): Promise<void> {
    if (!this.username || !this.password) return;
    if (this.accessToken !== this.initialAccessToken) return; // already have user token
    if (this.authPromise) {
      await this.authPromise;
      return;
    }
    this.authPromise = this.doAuth();
    await this.authPromise;
  }

  private async doAuth(): Promise<string> {
    const response = await this.fetchImpl(`${this.apiUrl}/authenticate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-token": this.initialAccessToken,
      },
      body: JSON.stringify({ username: this.username, password: this.password, token: true }),
    });

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }
      throw new WildDuckApiError(response.status, details);
    }

    const data = (await response.json()) as { token?: string };
    if (!data.token) {
      throw new Error("WildDuck authenticate response did not include a token.");
    }
    this.accessToken = data.token;
    return data.token;
  }

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    await this.ensureAuth();
    const response = await this.rawRequest(method, path, options);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  private async rawRequest(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}${buildQueryString(options.query ?? {})}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-access-token": this.accessToken,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text();
      }
      throw new WildDuckApiError(response.status, details);
    }

    return response;
  }
}

export class WildDuckApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(`WildDuck API request failed with HTTP ${status}`);
  }
}

function buildSubmitBody(input: SubmitMessageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    to: normalizeAddresses(input.to),
    cc: normalizeAddresses(input.cc),
    bcc: normalizeAddresses(input.bcc),
    subject: input.subject ?? "",
    text: input.text,
    html: input.html,
    attachments: normalizeAttachments(input.attachments),
    reference: input.reference,
    draft: input.draft,
  };

  for (const key of Object.keys(body)) {
    if (body[key] === undefined) {
      delete body[key];
    }
  }

  if (input.reference) {
    body.meta = { reference: input.reference };
  }

  return body;
}

function normalizeAddresses(addresses: Address[] | undefined): Address[] | undefined {
  if (!addresses) {
    return undefined;
  }
  return addresses.filter((address) => address.address).map((address) => ({ name: address.name ?? "", address: address.address }));
}

function normalizeAttachments(attachments: AttachmentInput[] | undefined): AttachmentInput[] | undefined {
  if (!attachments) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    ...attachment,
    encoding: attachment.encoding ?? "base64",
  }));
}

function extractThread(message: unknown): string | undefined {
  if (typeof message !== "object" || !message) {
    return undefined;
  }
  const record = message as { thread?: unknown };
  return typeof record.thread === "string" ? record.thread : undefined;
}

export function isSearchResponse(value: unknown): value is { results: Array<{ id?: string | number; mailbox?: string }> } {
  return typeof value === "object" && !!value && Array.isArray((value as { results?: unknown }).results);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
