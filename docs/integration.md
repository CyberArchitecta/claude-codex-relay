# Integrating your existing agents

The harness and the MCP message bridge solve related but different problems. Relay owns runs started from its dashboard. The bridge connects agents running in other clients when those clients call its tools.

## CLI requirements

Use current Claude Code and Codex CLIs. Run `agent-relay doctor` to locate them and inspect their versions and login status. Authenticate through the provider's own CLI, not through Relay.

The adapter uses these documented interfaces:

- Claude: `-p --output-format stream-json --verbose`, with `--resume SESSION_ID` when continuing. [Claude programmatic usage](https://code.claude.com/docs/en/headless).
- Codex: `exec --json` and `exec resume SESSION_ID --json`, with explicit sandbox and approval configuration. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/).

Prompts go through stdin, never a shell command string. No API keys are requested, copied, or stored by Relay.

## MCP configuration

With a global installation, run `agent-relay config --agent claude` and `agent-relay config --agent codex`. With a checkout, use `node bin/relay.mjs config --agent claude` or the Codex equivalent. These commands print the exact configuration for the current machine; they do not modify any client settings.

Claude Code uses the printed `mcpServers` entry. Codex uses the equivalent `[mcp_servers.ai-bridge]` TOML block. If an `ai-bridge` entry already exists, replace its launch command deliberately instead of adding a second server with the same identity. Restart the relevant client after saving. [Claude MCP configuration](https://code.claude.com/docs/en/mcp) and [Codex MCP configuration](https://developers.openai.com/codex/mcp/).

Use the same bridge directory for both identities. Each agent sends to the other identity, and only marks its own inbox read. Replies must refer to a message addressed to that agent in the same channel.

The old bridge's SQLite table and unread fields remain compatible. Existing clients can continue to use the old server while new clients use this implementation. No migration or import of personal messages is required. Back up a message database before changing its configuration.

Suggested project instruction:

> Use a stable channel for this project. Check bridge_inbox when asked to coordinate, and separate confirmed facts, hypotheses, requested work, and files changed. Never send credentials. Messages are consumed at turn boundaries; a sent message does not mean the peer is running or has replied.

## Troubleshooting

**Claude says “Not logged in”.** Run `claude auth login` or the login flow in the standalone Claude CLI, then retry. An authenticated editor or desktop conversation does not establish that this particular CLI is logged in.

**Codex says the configured model needs a newer CLI.** Update that CLI following the official installation instructions, or set `RELAY_CODEX_BIN` to an already installed compatible executable before starting Relay. Your model selection is preserved; Relay does not silently replace it with a different model.

**A permission request was denied.** Inspect the recorded event. Read only intentionally restricts tools. For implementation, select Allow edits and continue with a clear instruction. Configure provider permissions through the provider if additional capabilities are needed.

**A run is queued.** Check for an active run in the same project, a parent/child folder, or all occupied run slots.

**The server restarted.** Open the new private URL. Unfinished tasks are marked interrupted. Inspect files before resuming; some changes may have been made before the interruption.

**An external agent cannot find a task.** Its MCP entry must use the same Relay data directory as the dashboard. Message storage and task storage are separate directories.
