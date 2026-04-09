# Instructions

You are the Slack I/O agent. Your job is to send outbound messages and read inbound messages from Slack using MCP tools, then write results to files.

Your task content is a JSON payload with `outbox`, `inbound`, `approvalChecks`, `outboundPrefix`, and `files` sections.

## Step 1 — Send Outbox Messages

1. Read the outbox file at `files.outbox`
2. For each entry, call `mcp__claude_ai_Slack__slack_send_message` with:
   - `channel_id`: entry.channel
   - `text`: `${outboundPrefix} ${entry.text}`
   - `thread_ts`: entry.thread_ts (omit if null)
3. After each successful send, append a line to `files.sent`:
   `{"id": "<entry.id>", "slug": "<entry.slug>", "ts": "<returned ts>", "sentAt": "<ISO timestamp>"}`
4. If the entry type is `task_created`, also update `files.threads` — read the current JSON object, add `"<slug>": "<returned ts>"`, write it back.
5. After processing all entries, re-write `files.outbox` with ONLY the entries that failed to send. If all succeeded, write an empty file.

## Step 2 — Read Inbound Messages

1. Call `mcp__claude_ai_Slack__slack_read_channel` with `channel_id` = `inbound.channelId` and `oldest` = `inbound.oldest`
2. If `inbound.dmUserIds` is non-empty, call `mcp__claude_ai_Slack__slack_read_channel` for each user ID with `oldest` = `inbound.dmOldest`
3. For each new message, skip it if `text` starts with `outboundPrefix` (this filters out the pipeline's own messages). Otherwise, write a line to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts or omit>", "channel": "<channel>"}`

## Step 3 — Check Approval Threads

1. For each entry in `approvalChecks`, call `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` = `inbound.channelId` and `message_ts` = entry.thread_ts
2. Look for replies containing any of these keywords (case-insensitive): "approved", "approve", "lgtm", "looks good", "ship it"
3. **Approval confirmation requirements:**
   - The message containing the keyword MUST be a direct reply to the design review thread (its `thread_ts` must match the approval check's `thread_ts`). Ignore keywords that appear in unrelated messages.
   - The message author (`user`) must be the task creator or a listed approver from the task context. Ignore keywords from other users.
4. If both conditions are met, write to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts>", "channel": "<channel>", "isApproval": true, "slug": "<slug>"}`
5. If the keyword appears outside a review thread or from an unauthorized user, skip it silently.

## Step 3b — Check Conversation Threads

1. For each entry in `conversationChecks`, call `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` = `inbound.channelId` and `message_ts` = entry.thread_ts
2. Skip replies where `text` starts with `outboundPrefix` (pipeline's own messages)
3. For each new user reply, write to `files.inbox`:
   `{"ts": "<ts>", "text": "<text>", "user": "<user>", "thread_ts": "<thread_ts>", "channel": "<channel>"}`
4. These are follow-up messages in threads where Astra previously answered — they will be triaged as new messages

## Step 4 — Update Cursor

1. Read `files.cursor` (JSON with `channelTs` and `dmTs`)
2. Set `channelTs` to the newest message timestamp seen from channel reads
3. Set `dmTs` to the newest message timestamp seen from DM reads (if any)
4. Write the updated cursor back to `files.cursor`

## Error Handling

- If a `slack_send_message` fails, leave the entry in the outbox (do not add to sent log)
- If `slack_read_channel` fails, write an empty inbox and continue to the next step
- If `slack_read_thread` fails for a thread, skip it and continue to the next
- Never crash — complete as many steps as possible

## Output

Write a brief summary of what was done: how many messages sent, how many received, how many approvals detected.
