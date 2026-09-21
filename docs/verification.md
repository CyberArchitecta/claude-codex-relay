# Verification record

Release 0.2.1 · 2026-09-21

## Automated checks

- Node.js 24.13 on Windows: **25 tests passed**; JavaScript syntax checks passed.
- Real fixture processes verify adapter streams, Unicode, sessions, resume, handoffs, cancellation, failure states, queue serialization, and duplicate submission prevention.
- Six concurrent processes appended 60 shared notes without losing any. Stale browser saves return HTTP 409 and preserve remote changes.
- Existing tests cover MCP round trips, eight-process SQLite initialization, localhost authentication, Origin/Host checks, preview without execution, and exclusive server ownership.
- Chat tests cover empty projectless conversations, read-only defaults, per-provider session resume after switching, and delivery of intervening messages.
- Usage tests cover missing data, Claude model totals and cache accounting, and cumulative Codex session totals without double-counting.
- Chromium tests cover chat creation, message sending, provider switches, token display, draft settings, shared-note refresh, conflict resolution, a real racing save, and desktop/mobile layout. These use fixture providers, not paid models.
- GitHub Actions runs the Node tests on Windows, macOS, and Linux, plus Chromium checks on Linux. See the [Checks workflow](https://github.com/CyberArchitecta/claude-codex-relay/actions/workflows/ci.yml) for hosted results.

## Live provider checks

Both authenticated CLIs were exercised through the actual dashboard in a disposable Git project on Windows:

1. Codex diagnosed a quantity bug, ran the original tests (2 passed, 1 failed), and left all files unchanged.
2. The same Codex session fixed only the implementation. All 3 original tests passed.
3. Claude received the handoff, read the changed files, retained the shared marker, and identified missing input validation.
4. The same Claude session added validation and five regression tests. Its shell commands were denied by the CLI; Relay correctly showed **Needs attention**, with the denial recorded.
5. Codex received the return handoff and independently ran all **8 tests: passed**. A separate local test invocation confirmed the result.
6. A queued task was cancelled before starting. A running Claude process was stopped. Another real Codex task automatically started after Claude released the same project folder.

Provider versions: Claude Code 2.1.70 and Codex 0.155.0-alpha.9.2. The installed older Codex 0.146.0 rejected the configured model; the newer executable was selected with a process-local RELAY_CODEX_BIN override. No model was substituted.

The updated live app was also checked with an empty projectless chat and a real read-only Codex account quota query. That query returned both 5-hour and weekly windows. Additional chat regression checks used fixtures to conserve subscription usage.

## Usage semantics and boundaries

- Codex exec reports cumulative session counters. Relay counts each session once in totals and shows a reply delta when an earlier counter is available.
- Claude result modelUsage includes model and subagent usage; Relay uses it when present and otherwise uses the top-level usage result. Cache reads/writes are included in input tokens exactly once.
- Missing usage remains unknown. Old runs are not retroactively priced or assigned invented token counts. Interrupted processes may never emit final usage.
- Claude cost figures are CLI estimates, not subscription charges. Codex dollar cost is not inferred from token counts.
- Subscription percentages and context-window fill are separate from token expenditure. Codex limits come from its supported app-server endpoint. Claude headless output does not reliably expose all plan percentages; the app links to its usage page.
- No live macOS or Linux account was available; hosted tests use fixtures. Existing outside conversations are not imported.
- Chat handoffs carry at most 80,000 characters of recent intervening messages plus shared context. Keep durable decisions in shared context.

Sources: [Codex app server](https://learn.chatgpt.com/docs/app-server), [Codex CLI usage implementation](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs), [Claude usage accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

## Additional UI walkthrough: 0.2.1

Using fixture-backed replies through the real Chromium interface, repeated provider switches, chat navigation, reloads, multiline entry, a delayed send, usage display, and mobile layout were exercised. Three reproduced bugs were fixed: forgotten per-provider model selections, lost unsent messages, and lost selected chats after reload. A delayed submission no longer clears a different conversation's draft.

Manual compaction is now available through **Compact chat** or **/compact**. The user supplies a concise summary; no model is called. The next reply from each provider starts a fresh session with that summary and shared context. Old messages and usage remain recorded. Concurrent changes and active replies prevent a stale compaction.

The added browser suite verifies compaction and a subsequent reply, including fresh sessions for both providers and retained usage totals. **25 Node tests** and both Chromium suites pass locally. This walkthrough made no paid inference requests.
