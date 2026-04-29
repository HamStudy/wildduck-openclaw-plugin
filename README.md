# WildDuck OpenClaw Plugin

OpenClaw native plugin for WildDuck email through the WildDuck REST API.

## Capabilities

- Read-only mail tools by default
- Fielded and advanced WildDuck search
- Thread-aware context retrieval
- Attachment retrieval with size guardrails
- Sending address and autoreply inspection
- Draft creation separate from sending
- Explicit permission groups for send, mutate, filters, admin, and watch
- Debounced update-event buffer using WildDuck `/users/:user/updates` SSE, with polling fallback
- **Multi-account support** — configure multiple WildDuck users on the same server with per-account permissions and credentials

## Configuration

### Single-account (legacy)

```jsonc
{
  "plugins": {
    "entries": {
      "wildduck": {
        "enabled": true,
        "config": {
          "apiUrl": "https://mail.example.com",
          "accessTokenEnv": "WILDDUCK_ACCESS_TOKEN",
          "defaultUserId": "507f1f77bcf86cd799439011",
          "permissions": ["read", "draft"]
        }
      }
    }
  }
}
```

### Multi-account

Configure multiple WildDuck users with per-account permissions. Global settings are inherited as defaults.

```jsonc
{
  "plugins": {
    "entries": {
      "wildduck": {
        "enabled": true,
        "config": {
          "apiUrl": "https://mail.example.com",
          "accessTokenEnv": "WILDDUCK_ACCESS_TOKEN",
          "defaultAccount": "richard",
          "permissions": ["read"],
          "accounts": {
            "richard": {
              "userId": "richard@hamstudy.org",
              "permissions": ["read", "send", "mutate"]
            },
            "taxbot": {
              "userId": "taxbot@hamstudy.org",
              "permissions": ["read"]
            }
          }
        }
      }
    }
  }
}
```

Each account can also override `apiUrl`, `accessToken`, and `watch` settings if needed.

### Tool usage with accounts

All tools accept an optional `account` parameter. When omitted, the plugin uses `defaultAccount` if configured, otherwise falls back to legacy global `defaultUserId`.

```
wildduck_search_messages({ account: "richard", q: "from:invoice@example.com" })
wildduck_send_message({ account: "richard", to: [...], subject: "Hello" })
```

Permission checks are enforced per-account. An account with only `["read"]` cannot call send or mutate tools even if the global config allows them.

### Permission groups

- `read`: list, search, read, and inspect thread context
- `draft`: save composed drafts on the server
- `send`: send mail
- `mutate`: mark, move, or delete messages
- `filters`: manage WildDuck filters
- `watch`: run update watchers and read the debounced event buffer
- `admin`: enables all capability groups

## Local Development

```bash
npm install
npm run check
npm test
```

Install locally into OpenClaw:

```bash
openclaw plugins install -l .
```
