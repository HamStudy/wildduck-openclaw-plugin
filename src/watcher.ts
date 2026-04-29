import type { ResolvedConfig, WildDuckEvent } from "./types.js";
import { isSearchResponse, WildDuckClient } from "./wildduck-client.js";

type Logger = {
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
};

type PendingEvent = Omit<WildDuckEvent, "id">;

export class WildDuckUpdateWatcher {
  private readonly events: WildDuckEvent[] = [];
  private readonly pending = new Map<string, PendingEvent>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers: AbortController[] = [];
  private readonly lastEventIds = new Map<string, string>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(
    private readonly client: WildDuckClient,
    private readonly watch: ResolvedConfig["watch"],
    private readonly logger: Logger = {},
  ) {}

  start(): void {
    if (this.started || !this.watch.enabled || !this.watch.users.length) {
      return;
    }

    this.started = true;
    if (this.watch.mode === "poll") {
      this.startPolling();
      return;
    }

    for (const userId of this.watch.users) {
      this.startSseLoop(userId);
    }
  }

  stop(): void {
    this.started = false;
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.length = 0;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getEvents(limit = 50): WildDuckEvent[] {
    return this.events.slice(-limit);
  }

  clearEvents(): { cleared: number } {
    const cleared = this.events.length;
    this.events.length = 0;
    return { cleared };
  }

  enqueue(userId: string, event: unknown): void {
    const record = eventToRecord(event);
    if (record.command && !["EXISTS", "FETCH", "COUNTERS", "POLL"].includes(record.command)) {
      return;
    }

    const key = [userId, record.mailbox ?? "all", record.thread ?? "unknown"].join(":");
    const now = new Date().toISOString();
    const existing = this.pending.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.events.push(event);
    } else {
      this.pending.set(key, {
        userId,
        command: record.command,
        mailbox: record.mailbox,
        message: record.message,
        thread: record.thread,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        events: [event],
      });
    }

    const oldTimer = this.timers.get(key);
    if (oldTimer) {
      clearTimeout(oldTimer);
    }
    this.timers.set(
      key,
      setTimeout(() => this.flush(key), this.watch.debounceMs),
    );
  }

  private flush(key: string): void {
    const event = this.pending.get(key);
    this.pending.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    if (!event) {
      return;
    }

    this.events.push({
      id: `${event.userId}:${Date.now()}:${this.events.length}`,
      ...event,
    });

    const overflow = this.events.length - this.watch.maxBufferedEvents;
    if (overflow > 0) {
      this.events.splice(0, overflow);
    }
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.started) {
        return;
      }
      for (const userId of this.watch.users) {
        try {
          const result = await this.client.searchMessages({
            userId,
            unseen: true,
            searchable: true,
            threadCounters: true,
            limit: 20,
            order: "desc",
          });
          if (isSearchResponse(result) && result.results.length) {
            this.enqueue(userId, { command: "POLL", count: result.results.length, results: result.results });
          }
        } catch (err) {
          this.logger.warn?.("WildDuck poll watcher failed", err);
        }
      }
      this.pollTimer = setTimeout(poll, this.watch.pollIntervalMs);
    };

    this.pollTimer = setTimeout(poll, this.watch.pollIntervalMs);
  }

  private async startSseLoop(userId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.push(controller);

    while (this.started && !controller.signal.aborted) {
      try {
        const response = await this.client.openUpdatesStream(userId, this.lastEventIds.get(userId), controller.signal);
        await this.consumeSse(userId, response, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        this.logger.warn?.("WildDuck SSE watcher disconnected", err);
        await delay(5_000, controller.signal).catch(() => undefined);
      }
    }
  }

  private async consumeSse(userId: string, response: Response, signal: AbortSignal): Promise<void> {
    if (!response.body) {
      throw new Error("WildDuck updates response did not include a body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        this.consumeSseBlock(userId, part);
      }
    }
  }

  private consumeSseBlock(userId: string, block: string): void {
    const data: string[] = [];
    for (const line of block.split(/\n/)) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("id:")) {
        this.lastEventIds.set(userId, line.slice(3).trim());
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }

    if (!data.length) {
      return;
    }

    try {
      this.enqueue(userId, JSON.parse(data.join("\n")));
    } catch (err) {
      this.logger.warn?.("Failed to parse WildDuck updates event", err);
    }
  }
}

function eventToRecord(event: unknown): {
  command?: string;
  mailbox?: string;
  message?: string | number;
  thread?: string;
} {
  if (typeof event !== "object" || !event) {
    return {};
  }
  const record = event as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? record.command : undefined,
    mailbox: typeof record.mailbox === "string" ? record.mailbox : undefined,
    message: typeof record.message === "string" || typeof record.message === "number" ? record.message : undefined,
    thread: typeof record.thread === "string" ? record.thread : undefined,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
