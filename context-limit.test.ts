import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "./context-limit.ts"

const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash"
const catalog = {
  "opencode-go": {
    models: {
      "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", limit: { context: 1_000_000, output: 32_000 } },
      other: { id: "other", limit: { context: 200_000, output: 2000 } },
    },
  },
  deepseek: {
    models: {
      y: { id: "y", limit: { context: 1_000_000, output: 32_000 } },
    },
  },
}

let temp: string

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "context-limit-"))
  const cache = path.join(temp, "cache", "opencode")
  await fs.mkdir(cache, { recursive: true })
  await fs.writeFile(path.join(cache, "models.json"), JSON.stringify(catalog))
  process.env.XDG_CACHE_HOME = path.join(temp, "cache")
  process.env.XDG_DATA_HOME = path.join(temp, "data")
})

afterEach(async () => {
  delete process.env.XDG_CACHE_HOME
  delete process.env.XDG_DATA_HOME
  await fs.rm(temp, { recursive: true, force: true })
})

function makeClient(model?: string) {
  const toasts: any[] = []
  const logs: any[] = []
  const messages = model
    ? [
        {
          info: {
            role: "user",
            model: {
              providerID: model.split("/")[0],
              modelID: model.split("/").slice(1).join("/"),
            },
          },
        },
      ]
    : []
  const client: any = {
    session: { messages: async () => ({ data: messages }) },
    config: { get: async () => ({ data: { model } }) },
    tui: {
      showToast: async (options: any) => {
        toasts.push(options.body)
      },
    },
    app: {
      log: async (options: any) => {
        logs.push(options.body)
      },
    },
  }
  return { client, toasts, logs }
}

async function setup(model: string | null = DEFAULT_MODEL) {
  const fake = makeClient(model ?? undefined)
  const hooks: any = await (plugin as any)({ client: fake.client, directory: temp, project: {} })
  return { ...fake, hooks }
}

async function execute(
  hooks: any,
  name: string,
  args: string,
): Promise<any> {
  await expect(
    hooks["command.execute.before"]({ command: name, sessionID: "ses_1", arguments: args }, { parts: [] }),
  ).rejects.toThrow(`${name} handled`)
}

describe("parseBudget through the command", () => {
  test("accepts scaled, plain, and percent values", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "128K")
    expect(toasts.at(-1).message).toContain("128K")
    await execute(hooks, "context-limit", "50%")
    expect(toasts.at(-1).message).toContain("50%")
    await execute(hooks, "context-limit", "123456")
    expect(toasts.at(-1).message).toContain("123456")
  })

  test("rejects bad values", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "101%")
    expect(toasts.at(-1).variant).toBe("error")
    expect(toasts.at(-1).message).toContain("Bad value")
    await execute(hooks, "context-limit", "abc")
    expect(toasts.at(-1).variant).toBe("error")
  })
})

describe("rule storage", () => {
  test("sets a budget for the current model and persists it", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "128K")
    expect(toasts.at(-1).message).toContain("opencode-go/deepseek-v4.1-flash")
    expect(toasts.at(-1).message).toContain("Restart OpenCode")

    const stored = JSON.parse(await fs.readFile(path.join(temp, "data", "opencode", "context-limit", "rules.json"), "utf8"))
    expect(stored.context).toEqual([
      { pattern: DEFAULT_MODEL, value: 128_000, unit: "tokens" },
    ])
    expect(stored.output).toEqual([])
  })

  test("sets a pattern and percent, then clears it with 0", async () => {
    const { hooks } = await setup()
    await execute(hooks, "context-limit", "opencode-go/* 50%")
    const file = path.join(temp, "data", "opencode", "context-limit", "rules.json")
    expect(JSON.parse(await fs.readFile(file, "utf8")).context).toEqual([
      { pattern: "opencode-go/*", value: 50, unit: "percent" },
    ])
    await execute(hooks, "context-limit", "opencode-go/* 0")
    expect(JSON.parse(await fs.readFile(file, "utf8")).context).toEqual([])
  })

  test("clears with 0K and keeps context and output rules separate", async () => {
    const { hooks } = await setup()
    await execute(hooks, "output-limit", "16K")
    await execute(hooks, "context-limit", "128K")
    await execute(hooks, "context-limit", `${DEFAULT_MODEL} 0K`)
    const file = path.join(temp, "data", "opencode", "context-limit", "rules.json")
    const stored = JSON.parse(await fs.readFile(file, "utf8"))
    expect(stored.context).toEqual([])
    expect(stored.output).toEqual([{ pattern: DEFAULT_MODEL, value: 16_000, unit: "tokens" }])
  })

  test("restores rules saved by an earlier instance", async () => {
    const first = await setup()
    await execute(first.hooks, "context-limit", "128K")
    const second = await setup()
    await execute(second.hooks, "context-limit", "")
    expect(second.toasts.at(-1).message).toContain("Budget: 128000")
  })
})

describe("show command", () => {
  test("shows the current model, effective window, and rules", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "128K")
    await execute(hooks, "context-limit", "")
    const message = toasts.at(-1).message
    expect(message).toContain(`Model: ${DEFAULT_MODEL}`)
    expect(message).toContain("Effective window: 128000")
    expect(message).toContain("Budget: 128000")
    expect(message).toContain(`${DEFAULT_MODEL} -> 128000`)
  })

  test("reports a percent rule without reapplying it", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "50%")
    await execute(hooks, "context-limit", "")
    const message = toasts.at(-1).message
    expect(message).toContain("Effective window: 500000")
    expect(message).toContain("Budget: 50%")
  })

  test("clamps a rule above the catalog window in the display", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "2M")
    await execute(hooks, "context-limit", "")
    expect(toasts.at(-1).message).toContain("Effective window: 1000000")
    expect(toasts.at(-1).message).toContain("Budget: 1000000")
  })

  test("shows the output budget separately", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "output-limit", "512")
    await execute(hooks, "output-limit", "")
    expect(toasts.at(-1).message).toContain("Effective output: 512")
  })

  test("prints the version", async () => {
    const { hooks, toasts } = await setup()
    await execute(hooks, "context-limit", "")
    const pkg = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as { version: string }
    expect(toasts.at(-1).message).toContain(`context-limit ${pkg.version}`)
  })

  test("reports an unresolvable model", async () => {
    const { hooks, toasts } = await setup(null)
    await execute(hooks, "context-limit", "")
    expect(toasts.at(-1).message).toContain("Could not resolve the current model")
  })
})

describe("config hook", () => {
  test("registers both commands", async () => {
    const { hooks } = await setup()
    const cfg: any = {}
    await hooks.config(cfg)
    expect(Object.keys(cfg.command)).toEqual(["context-limit", "output-limit"])
    expect(cfg.command["context-limit"].description).toContain("context budget")
    expect(cfg.command["output-limit"].description).toContain("output")
  })

  test("applies stored budgets to matched models only", async () => {
    const first = await setup()
    await execute(first.hooks, "context-limit", "opencode-go/* 128K")
    await execute(first.hooks, "output-limit", "* 16K")

    const second = await setup()
    const cfg: any = {}
    await second.hooks.config(cfg)
    const models = cfg.provider["opencode-go"].models
    expect(models["deepseek-v4.1-flash"].limit).toEqual({ context: 128_000, output: 16_000 })
    expect(models.other.limit).toEqual({ context: 128_000, output: 2000 })
    expect(cfg.provider.deepseek.models.y.limit).toEqual({ context: 1_000_000, output: 16_000 })
  })

  test("never raises a catalog limit", async () => {
    const first = await setup()
    await execute(first.hooks, "context-limit", "2M")
    await execute(first.hooks, "output-limit", "16K")

    const second = await setup()
    const cfg: any = {}
    await second.hooks.config(cfg)
    expect(cfg.provider["opencode-go"].models["deepseek-v4.1-flash"].limit).toEqual({
      context: 1_000_000,
      output: 16_000,
    })
  })

  test("does not add provider config without rules", async () => {
    const { hooks } = await setup()
    const cfg: any = {}
    await hooks.config(cfg)
    expect(cfg.provider).toBeUndefined()
  })
})

describe("chat.params hook", () => {
  test("lowers maxOutputTokens for the current model", async () => {
    const { hooks } = await setup()
    await execute(hooks, "output-limit", "16K")
    const output: any = { maxOutputTokens: 32_000 }
    await hooks["chat.params"]({ model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } }, output)
    expect(output.maxOutputTokens).toBe(16_000)
  })

  test("leaves unmatched models alone", async () => {
    const { hooks } = await setup()
    await execute(hooks, "output-limit", DEFAULT_MODEL + " 16K")
    const output: any = { maxOutputTokens: 32_000 }
    await hooks["chat.params"]({ model: { providerID: "deepseek", id: "y" } }, output)
    expect(output.maxOutputTokens).toBe(32_000)
  })

  test("never raises maxOutputTokens", async () => {
    const { hooks } = await setup()
    await execute(hooks, "output-limit", "16K")
    const output: any = { maxOutputTokens: 100 }
    await hooks["chat.params"]({ model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } }, output)
    expect(output.maxOutputTokens).toBe(100)
  })
})

describe("hooks", () => {
  test("ignores other commands", async () => {
    const { hooks, toasts } = await setup()
    await hooks["command.execute.before"]({ command: "other", sessionID: "ses_1", arguments: "" }, { parts: [] })
    expect(toasts).toHaveLength(0)
  })

  test("falls back to app.log when there is no TUI", async () => {
    const fake = makeClient(DEFAULT_MODEL)
    delete fake.client.tui
    const hooks: any = await (plugin as any)({ client: fake.client, directory: temp, project: {} })
    await expect(
      hooks["command.execute.before"]({ command: "context-limit", sessionID: "ses_1", arguments: "" }, { parts: [] }),
    ).rejects.toThrow("context-limit handled")
    expect(fake.logs).toHaveLength(1)
    expect(fake.logs[0].service).toBe("context-limit")
  })
})

describe("package manifest", () => {
  test("exposes a V1 server entrypoint", async () => {
    const pkg = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./server"]).toBe("./context-limit.ts")
  })
})
