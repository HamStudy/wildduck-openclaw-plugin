---
name: wildduck-email
description: Use the WildDuck OpenClaw plugin for email search, reading, thread context, draft composition, sending, message mutation, filters, and debounced update events. Trigger when users ask OpenClaw to find, read, summarize, draft, send, organize, or monitor WildDuck email.
metadata: { "openclaw": { "requires": { "config": ["plugins.entries.wildduck.enabled"] } } }
---

# WildDuck Email

Use WildDuck tools conservatively and preserve email context.

## Search

- Prefer `wildduck_search_messages` with fielded `from`, `to`, and `subject` for address/header searches.
- Use `q` for WildDuck advanced syntax: `subject:"..."`, `from:...`, `to:...`, `has:attachment`, `in:<mailbox>`, `thread:<id>`, negation, and OR groups.
- Use `wildduck_search_correspondence` to find all mail to or from one address.
- Request `threadCounters` when triaging results so thread size is visible.
- Use `wildduck_list_addresses` before drafting or sending when the From identity matters.

## Thread Context

- Before answering, summarizing, or drafting a reply to one message, call `wildduck_get_thread`.
- If only a message is known, pass `mailbox` and `message`; the tool will discover the thread.
- Treat a single message as incomplete context unless the thread lookup returns only one message.

## Drafts And Sending

- Use `wildduck_create_draft` when a response should be saved for review. This requires `draft`, not `send`.
- Use `wildduck_send_message` only when the user clearly asked to send and the plugin has `send` permission.
- Include `reference` when replying or forwarding so WildDuck can set threading headers.
- Do not include secrets, API tokens, or passwords in email bodies, drafts, or event tests.

## Mutations

- `wildduck_get_message` defaults to `markAsSeen: false`; only set `markAsSeen: true` when the user wants the message marked read.
- `wildduck_get_attachment` returns base64 and has a size guard; fetch attachments only when the user needs the file contents.
- Moving, deleting, flagging, or marking messages requires `mutate` permission.
- Autoreply updates require `mutate` permission.
- Filter changes require `filters` permission.

## Update Events

- If watch mode is enabled, use `wildduck_get_events` to inspect debounced update groups.
- Event groups may represent mailbox changes rather than fully fetched messages; use search/thread tools to inspect actual mail before acting.
