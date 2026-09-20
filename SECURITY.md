# Security and privacy

Relay is a local tool for a trusted single-user computer, not a multi-tenant service.

- The HTTP listener binds to 127.0.0.1 only. A per-start random bearer token protects every API endpoint. Strict Host and Origin checks reject requests from unrelated websites. The static UI contains no embedded token.
- Prompts are piped to allowlisted provider executables without a shell. On Windows, recognized npm shims resolve to a JS entry point; arbitrary cmd/PowerShell wrappers are not executed.
- Provider settings and hooks remain the user's responsibility. Relay does not turn a provider into a stronger sandbox. Allow edits gives the provider authority to change files using its edit mode. It never selects bypass-permissions or danger-full-access flags.
- The dashboard renders agent text as text, not HTML. HTTP requests, stored event sizes, execution time, and total run output are bounded.
- All local task records are plaintext SQLite. They can include sensitive prompts, file paths, tool output, and responses. They are not encrypted or automatically deleted. Protect and back up your user profile appropriately.
- The bridge is stdio-only and runs with the permissions of the invoking client. It is intentionally available to that client without the dashboard's bearer token. It cannot start a provider run.
- A bridge message does not start the other agent. A handoff requires an explicit run request. Provider output is labeled as prior-agent evidence in handoff text; agents still need to verify it against the workspace.
- Folder serialization covers this server's own runs. It does not lock out editors, other Relay data directories, or external agents. Unrelated tool subprocesses started outside the provider process group may outlive a cancellation. Review the workspace after any interruption.

Do not expose the server through a public tunnel or reverse proxy. Do not share the private startup URL. Never commit runtime databases, login files, API keys, or private transcripts. Repository ignore rules and the npm package allowlist exclude runtime data, but review any assets you add yourself.

For a security report, avoid publishing private logs or credentials in an issue. Use the repository's private vulnerability reporting option if available, or contact the maintainer through their GitHub profile to arrange a private report.
