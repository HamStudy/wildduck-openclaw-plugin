type QueryValue = string | number | boolean | Date | undefined | null | unknown;
type QueryInput = Record<string, QueryValue>;

export function buildQueryString(query: QueryInput): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (value instanceof Date) {
      params.set(key, value.toISOString());
    } else if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
    } else if (typeof value === "string" || typeof value === "number") {
      params.set(key, String(value));
    } else {
      params.set(key, JSON.stringify(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function escapeSearchToken(value: string): string {
  if (/^[A-Za-z0-9_@.+:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function buildCorrespondenceQuery(address: string, mailbox?: string): string {
  const token = escapeSearchToken(address);
  const parts = [`(from:${token} OR to:${token})`];
  if (mailbox) {
    parts.push(`in:${escapeSearchToken(mailbox)}`);
  }
  return parts.join(" ");
}
