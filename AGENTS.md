# AGENTS.md

Guidance for agents working in this repository.

## What this is

An OpenCode V1 plugin (`context-limit.ts`) that sets a per-model working context
budget and a max output-token budget. No build step, no runtime dependencies,
AGPL-3.0-only. Verified against OpenCode 1.19.6.

## Local development

```sh
bun test
cp context-limit.ts ~/.config/opencode/plugins/context-limit.ts
```

Restart OpenCode after copying or changing the plugin file. Check the server log
when something is off:

```sh
grep context-limit ~/.local/share/opencode/log/opencode.log | tail
```

## Hard constraints

- Use the V1 plugin API: default-export a single function typed as
  `Plugin` from `@opencode-ai/plugin`, and return hooks. `import type` is erased,
  so the plugin stays dependency-free.
- Export nothing else from `context-limit.ts`. OpenCode V1's legacy loader calls
  every module export as a plugin and throws on non-function exports.
- A budget can only lower a limit, never raise it.
- Clamp every budget to the catalog ceiling from
  `~/.cache/opencode/models.json` (`OPENCODE_MODELS_PATH` overrides the path).
- Do not call `client.provider.list()` or `client.config.providers()` from the
  plugin factory or the `config` hook: they re-enter provider initialization,
  which waits on plugin initialization and deadlocks.
- Plugin `console` output is not visible to users. Use `client.tui.showToast`
  (with `client.app.log` as a fallback) and throw from `command.execute.before`
  to stop the command from starting a model turn.

## API notes

- `config(cfg)` mutates the live config object. Add
  `cfg.provider[id].models[modelID].limit = { context, output }` for matched
  models and register the two slash commands under `cfg.command`.
- V1 config `limit` requires both `context` and `output`; always write both.
- Commands arrive via `command.execute.before` with
  `{ command, sessionID, arguments }`. The current model comes from the last
  user message in `client.session.messages`, falling back to config `model`.
- `chat.params` can set `output.maxOutputTokens` per request, so output budgets
  apply without a restart. Context budgets only take effect after a restart
  because V1 has no runtime model reload API.
- Rules persist as JSON in
  `~/.local/share/opencode/context-limit/rules.json` (`XDG_DATA_HOME` honored).

## Layout

- `parseBudget` - parses tokens, `128K`, `1M`, and `50%`.
- `matchPattern`, `longestMatch`, `budgetFor`, `resolveBudget` - rule matching.
- `applyBudgetToConfig` - writes computed limits into the live config.
- `currentModelKey`, `notify`, `runCommand` - command handling and display.
- `plugin` - registers `config`, `command.execute.before`, and `chat.params`.
- `context-limit.test.ts` - tests with a fake client, catalog, and temp dirs.

## Releasing

- Semantic commit messages. Changes through a feature branch and a PR.
- `version-pr.yml` opens a `release`-labelled PR on every push to `main`.
  `publish.yml` publishes when that PR is merged, using npm trusted publishing
  (OIDC) rather than a token secret.
- Keep `VERSION` and `package.json` version in sync with
  `node scripts/sync-version.mjs`, and keep `NOTICE` accurate.
- Test with the oldest V1 release you intend to support and with the installed
  release.
