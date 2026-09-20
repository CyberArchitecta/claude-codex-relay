# Research and implementation scope

Checked 2026-09-20 against public material and local source code.

## Dervo

[Dervo's current public website](https://trydervo.com/) describes a macOS private beta that launches Claude Code and Codex in project folders, records their runs, and shows work needing attention. Its illustrated handoff restarts a stopped Claude task in Codex with the original request. It also describes splitting work into queued threads and deriving status from recorded activity.

The site discloses important boundaries: it only sees sessions started inside Dervo; the Mac must remain awake; its Home task-splitting feature needs Claude; and its illustrated handoff requires a clean stop without changed files. These are published product claims, not independently tested behavior. I did not obtain a beta build or inspect its source.

The supplied [Daniel Smidstrup X post](https://x.com/DanielSmidstrup/status/2101348710181482973) returned HTTP 403 during research. The user supplied its relevant quotation. The current Dervo site credits Bryce Rambach, so this research does not attribute Dervo's implementation to the linked post's author.

## What already existed

The local Claude–Codex bridge was an approximately 300-line Node MCP server plus a small status/history CLI. It stored messages in SQLite and offered send, inbox, history, wait, and status tools. Its package configuration contained machine-specific paths; it had no distribution repository or automated tests. It could exchange messages at turn boundaries, but it did not launch agents, own tasks, or report run completion.

Relay retains compatibility with that message schema and tool vocabulary. The task database, subprocess runner, provider adapters, web interface, tests, package, and documentation are new. Personal messages, credentials, client records, and local configuration are excluded from distribution.

## Scope comparison

| Workflow | Existing bridge | Relay 0.1 |
| --- | --- | --- |
| Send messages across agents | Yes, at turn boundaries | Compatible MCP bridge |
| Own both providers' runs | No | CLI subprocess adapters |
| Track task state | No | Task board and persisted run history |
| Continue a provider session | No | Stored session ID resume |
| Switch providers with context | Manual message | Explicit preview and bounded handoff record |
| Work on multiple projects | Channels only | Queue with overlapping-folder serialization |
| Native macOS app | No | Portable localhost browser interface |
| Import arbitrary existing chats | No | No |
| Automatic task decomposition | No | No |

Implementation uses the vendors' documented [Claude streaming/resume interface](https://code.claude.com/docs/en/headless) and [Codex exec interface](https://developers.openai.com/codex/noninteractive/). It is an independent implementation; it does not use Dervo source, branding, screenshots, or assets.
