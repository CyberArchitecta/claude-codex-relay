# Contributing

Use Node.js 24.13+ and Git. Clone the repository, run `npm ci`, then `npm test` and `npm run check`. The core package deliberately has no external runtime dependencies.

Tests use isolated temporary directories and deterministic fixture CLIs. They must not consume model allowance or use the contributor's real conversation history. Live provider tests are opt-in: `node scripts/smoke-live.mjs` invokes installed CLIs with tiny read-only prompts, preserves the configured models, and keeps its test record in a temporary directory.

For browser QA, `node scripts/dev-preview.mjs` starts a labeled sample-data workspace on port 4318. With Python Playwright and Chromium installed, `python scripts/verify-ui.py` checks task creation, selection, handoff preview, and desktop/mobile layout. Preview data and screenshots under scratch/ are ignored by Git.

Keep provider adapters explicit. Add fixture cases for protocol changes, preserve useful failures, and never infer that tests passed just because an agent used reassuring words. Do not add autonomous retries or automatic failover without a clear user control.

Before a release, verify the npm file list, scan tracked files for credentials and machine-specific data, run the cross-platform CI matrix, and document live checks separately from simulated coverage. GitHub Releases distributes the source archive and an npm-installable .tgz. No npm registry token is needed.

Browser regression checks (no model usage): install Python Playwright and Chromium, then run python scripts/test-ui.py. CI runs this on Linux.
