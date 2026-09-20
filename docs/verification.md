# Verification record

Release candidate 0.1.0 · 2026-09-20

## Automated checks

- Node.js 24.13.0 on Windows: **18 tests passed**.
- JavaScript syntax checks: passed.
- Real fixture subprocesses verified both adapter streams, UTF-8 chunk boundaries, session IDs, same-provider resume, cross-provider handoff, preserved follow-up instructions, and process cancellation.
- Scheduler checks covered simultaneous tasks in separate projects, serialization within a project, and rejection of duplicate concurrent submissions.
- Failure fixtures covered permission denial, usage limits, missing completion, and an incompatible CLI/model.
- Two separate MCP processes exchanged a message and reply with correct identity, channel, and unread behavior.
- HTTP checks covered authentication, foreign Origin and Host rejection, static-file confinement, request validation, and preview without execution.
- A second server was refused access to an already-owned data directory.
- The GitHub Actions matrix runs these checks on Windows, macOS, and Linux. The public [Checks workflow](https://github.com/CyberArchitecta/claude-codex-relay/actions/workflows/ci.yml) is the source of truth for hosted results.

## Live provider checks

| Provider | Observed result |
| --- | --- |
| Claude Code 2.1.70 | Installed, but standalone CLI authentication was absent. A real run returned “Not logged in” and Relay showed Needs attention. Successful Claude execution/resume remains unverified live in this environment; both are covered by subprocess fixtures. |
| Codex CLI 0.146.0 | Its configured model required a newer CLI. Relay captured the failure. No model substitution was made. |
| Codex CLI 0.155.0-alpha.9.2, already bundled with the desktop app | A real run received the expected shared-context marker; a subsequent run resumed the saved provider session and returned the expected response. Both completed successfully. |

The newer Codex executable was selected with a process-local RELAY_CODEX_BIN override. Global CLI installations, provider logins, and client configuration were not changed.

These were short read-only integration prompts in a new temporary Git repository. They validate launch, streaming, state, context delivery, and resume. They are not a benchmark or proof that arbitrary coding work succeeds.

## Browser checks

Python Playwright with Chromium verified task creation without launch, task selection, cross-provider context preview, and absence of browser runtime errors. The interface was rendered at 1440×1100 and 390×844; neither layout overflowed horizontally. Screenshots were visually inspected. The README screenshot contains clearly labeled sample data, not real client work.

## Boundaries

There was no live macOS or Linux provider login available here. Hosted OS tests use fixture providers and do not call paid models. Claude live verification requires the user to log in to the standalone CLI and rerun scripts/smoke-live.mjs. Existing external conversations are not imported.
