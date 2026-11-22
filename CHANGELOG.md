# Changelog

Notable changes to opencode-context-limit. Versions use CalVer (YYYY.MM.MICRO).

## 2026.11.0

- Port the plugin to OpenCode 1.x (verified against 1.19.6). The V2 entrypoint,
  model transform, command transform, and plugin storage are replaced by the V1
  `config`, `command.execute.before`, and `chat.params` hooks.
- Model limits are applied from the local catalog at startup; context changes
  require a restart, while output changes apply immediately via
  `maxOutputTokens`.
- Rules persist in `~/.local/share/opencode/context-limit/rules.json`.
- Command feedback is shown as a toast instead of a thrown error.
- Install URL and repository metadata now point to `amit-batra`.

## 2026.10.2

- Add `/output-limit` for a per-model max output-token budget. The rule engine
  now targets `limit.context` or `limit.output`, with separate rule sets.
- Credit to Elijah Shaw-Rutschman (@elijahwander) for the original patch.

## 2026.10.1

- Verified against OpenCode 2.1.4. No behavior change.

## 2026.10.0

- Use `Plugin.define` from the host `@opencode/plugin` module.
- Test against OpenCode 2.1.3.

## 2026.9.0

- Adopted CalVer. Supersedes the 0.1.3 release.

