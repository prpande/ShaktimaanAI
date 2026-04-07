# Slack Outbound Prefix

**Date:** 2026-04-07
**Status:** Approved

## Problem

Two related issues:

1. **Self-ingestion loop.** When the pipeline sends a "task created" (or any other) notification to Slack, the next poll cycle reads it back as a new inbound message. Astra then triages the pipeline's own message and creates a spurious task. Root cause: the slack-io agent sends outbox messages *before* reading inbound in the same run, so sent messages land in the inbound read window. There is no filtering to exclude messages the pipeline itself sent.

2. **No visual identification.** There is no way to distinguish pipeline-sent messages from human messages in the Slack channel.

## Solution

Prepend a configurable identifier to every outgoing Slack message. The same prefix is used by the slack-io agent to filter out those messages when reading inbound, preventing self-ingestion.

## Design

### Config

Add one field to the `slack` object in `src/config/schema.ts`:

```ts
outboundPrefix: z.string().optional().default("🤖 [ShaktimaanAI]")
```

Default value: `🤖 [ShaktimaanAI]`.

### Narada Payload

`buildNaradaPayload` in `src/core/slack-queue.ts` passes `outboundPrefix` to the agent:

```ts
outboundPrefix: config.slack.outboundPrefix ?? "🤖 [ShaktimaanAI]"
```

The `NaradaPayload` type gains a top-level `outboundPrefix: string` field.

### slack-io Agent (`agents/slack-io.md`)

**Step 1 — Send:** Before calling `slack_send_message`, prepend `${outboundPrefix} ` to `entry.text`.

**Step 2 — Read:** After reading each inbound message, skip it (do not write to `files.inbox`) if `text.startsWith(outboundPrefix)`.

### What Does Not Change

- No changes to `watcher.ts` or pipeline stage code.
- No changes to any other notifier or outbox writer — the agent is the single send/filter point.
- No new config required beyond the optional `outboundPrefix` field (default covers the common case).

## Change Surface

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add `outboundPrefix` field to `slack` schema |
| `src/core/slack-queue.ts` | Add `outboundPrefix` to `NaradaPayload` type and `buildNaradaPayload` |
| `agents/slack-io.md` | Prepend prefix on send; skip inbound messages starting with prefix |

## Example

User message in Slack:
```
implement spec 5c
```

Pipeline response:
```
🤖 [ShaktimaanAI] 🚀 Task created: implement-spec-5c-20260407213000
```

On the next poll, the pipeline reads the channel and sees its own response — but skips it because it starts with `🤖 [ShaktimaanAI]`.
