# Contributing

Thanks for helping improve opencode-context-limit.

## Setup

```sh
git clone https://github.com/amit-batra/opencode-context-limit
cd opencode-context-limit
bun test
```

Bun is a deliberate exception to the global no-bun rule here: the plugin runs
inside OpenCode, which embeds Bun.

## Rules

- Use the V1 API: `import type { Plugin } from "@opencode-ai/plugin"` and
  default-export one plugin function that returns hooks. Do not add runtime
  dependencies, and do not add named exports to `context-limit.ts`.
- A budget can only lower a window, never raise it.
- Add a test for any behavior you change. Tests use a fake client and catalog
  in temporary XDG directories.

## Sending a change

1. Branch: `git checkout -b fix/short-description`.
2. Make the change and add tests.
3. Run `bun test`.
4. Use a semantic commit message.
5. Open a pull request against `main`.

## License

By contributing, you agree that your work is released under the AGPL-3.0-only License.
