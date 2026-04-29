export type Permission = "read" | "draft" | "send" | "mutate" | "filters" | "admin" | "watch";

export type SecretInput =
  | string
  | {
      source: "env" | "file" | "exec";
      provider?: string;
      id: string;
    };

export type WatchConfig = {
  enabled?: boolean;
  mode?: "sse" | "poll";
  users?: string[];
  debounceMs?: number;
  pollIntervalMs?: number;
  maxBufferedEvents?: number;
};

export type AccountConfig = {
  userId: string;
  permissions?: Permission[];
  apiUrl?: string;
  accessToken?: SecretInput;
  accessTokenEnv?: string;
  username?: string;
  password?: SecretInput;
  passwordEnv?: string;
  watch?: WatchConfig;
};

export type PluginConfig = {
  apiUrl?: string;
  accessToken?: SecretInput;
  accessTokenEnv?: string;
  defaultUserId?: string;
  permissions?: Permission[];
  watch?: WatchConfig;
  // Multi-account support
  defaultAccount?: string;
  accounts?: Record<string, AccountConfig>;
};

export type ResolvedAccount = {
  userId: string;
  permissions: Set<Permission>;
  apiUrl: string;
  accessToken: string;
  username?: string;
  password?: string;
  watch: Required<Omit<WatchConfig, "users">> & { users: string[] };
};

export type ResolvedConfig = {
  apiUrl: string;
  accessToken: string;
  defaultUserId?: string;
  permissions: Set<Permission>;
  watch: Required<Omit<WatchConfig, "users">> & { users: string[] };
  defaultAccount?: string;
  accounts: Map<string, ResolvedAccount>;
};

export type Address = {
  name?: string;
  address: string;
};

export type AttachmentInput = {
  filename: string;
  contentType?: string;
  content: string;
  encoding?: "base64";
};

export type SubmitMessageInput = {
  userId?: string;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: AttachmentInput[];
  reference?: {
    mailbox: string;
    id: string | number;
    action: "reply" | "replyAll" | "forward";
  };
  draft?: {
    mailbox: string;
    id: string | number;
  };
};

export type WildDuckEvent = {
  id?: string;
  userId: string;
  command?: string;
  mailbox?: string;
  message?: string | number;
  thread?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  events: unknown[];
};
