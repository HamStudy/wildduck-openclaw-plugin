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

## Configuration

Prefer environment variables or OpenClaw SecretRefs for credentials.

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

Permission groups:

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
