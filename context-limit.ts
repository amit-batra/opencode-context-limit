import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const VERSION = "2026.11.4"

type Unit = "tokens" | "percent"
type LimitKind = "context" | "output"

interface Rule {
  pattern: string
  value: number
  unit: Unit
}

interface RuleSets {
  context: Rule[]
  output: Rule[]
}

interface CatalogModel {
  id?: string
  limit?: { context?: number; input?: number; output?: number }
}

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>
type ModelLimit = NonNullable<CatalogModel["limit"]>

function splitKey(key: string): [string, string] {
  const slash = key.indexOf("/")
  return slash < 0 ? [key, ""] : [key.slice(0, slash), key.slice(slash + 1)]
}

interface CommandOptions {
  kind: LimitKind
  name: string
  fieldLabel: "window" | "output"
  description: string
}

const COMMANDS: Record<string, CommandOptions> = {
  "context-limit": {
    kind: "context",
    name: "context-limit",
    fieldLabel: "window",
    description: "Show or set a working context budget per model",
  },
  "output-limit": {
    kind: "output",
    name: "output-limit",
    fieldLabel: "output",
    description: "Show or set a max output token budget per model",
  },
}

function parseBudget(text: string): { value: number; unit: Unit } | undefined {
  const trimmed = text.trim()
  const percent = /^(\d+)%$/.exec(trimmed)
  if (percent) {
    const value = Number(percent[1])
    return value > 0 && value <= 100 ? { value, unit: "percent" } : undefined
  }
  const scaled = /^(\d+)([kKmM])$/.exec(trimmed)
  if (scaled) {
    const unit = scaled[2].toLowerCase() === "k" ? 1000 : 1_000_000
    return { value: Number(scaled[1]) * unit, unit: "tokens" }
  }
  const plain = /^(\d+)$/.exec(trimmed)
  if (plain) return { value: Number(plain[1]), unit: "tokens" }
  return undefined
}

function matchPattern(pattern: string, key: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("/*")) return key.startsWith(pattern.slice(0, -1))
  return pattern === key
}

function longestMatch(rules: Rule[], key: string): Rule | undefined {
  let best: Rule | undefined
  for (const rule of rules) {
    if (!matchPattern(rule.pattern, key)) continue
    if (!best || rule.pattern.length > best.pattern.length) best = rule
  }
  return best
}

function budgetFor(rule: Rule, catalogCeiling: number): number {
  const raw = rule.unit === "percent" ? Math.floor((catalogCeiling * rule.value) / 100) : rule.value
  return Math.max(1, Math.min(raw, catalogCeiling))
}

function resolveBudget(rules: Rule[], key: string, catalogCeiling: number | undefined): number | undefined {
  if (typeof catalogCeiling !== "number") return undefined
  const rule = longestMatch(rules, key)
  return rule ? budgetFor(rule, catalogCeiling) : undefined
}

function catalogPath(): string {
  if (process.env.OPENCODE_MODELS_PATH) return process.env.OPENCODE_MODELS_PATH
  const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheHome, "opencode", "models.json")
}

function rulesPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(dataHome, "opencode", "context-limit", "rules.json")
}

async function loadCatalog(): Promise<Catalog> {
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function loadRules(): Promise<RuleSets> {
  try {
    const parsed = JSON.parse(await fs.readFile(rulesPath(), "utf8"))
    return {
      context: Array.isArray(parsed?.context) ? parsed.context : [],
      output: Array.isArray(parsed?.output) ? parsed.output : [],
    }
  } catch {
    return { context: [], output: [] }
  }
}

async function saveRules(rules: RuleSets): Promise<void> {
  const file = rulesPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(rules, null, 2)}\n`)
}

function applyBudgetToConfig(config: any, limits: Map<string, ModelLimit>, rules: RuleSets): void {
  for (const [key, ceiling] of limits) {
    if (typeof ceiling.context !== "number" || typeof ceiling.output !== "number") continue
    const context = resolveBudget(rules.context, key, ceiling.context) ?? ceiling.context
    const output = resolveBudget(rules.output, key, ceiling.output) ?? ceiling.output
    if (context === ceiling.context && output === ceiling.output) continue
    const [providerID, modelID] = splitKey(key)
    config.provider ??= {}
    config.provider[providerID] ??= {}
    config.provider[providerID].models ??= {}
    config.provider[providerID].models[modelID] ??= {}
    config.provider[providerID].models[modelID].limit = { context, output }
  }
}

function describeRules(rules: Rule[]): string {
  if (rules.length === 0) return "No rules."
  return rules.map((rule) => `${rule.pattern} -> ${rule.unit === "percent" ? `${rule.value}%` : rule.value}`).join("\n")
}

function sessionModelKey(result: any): string | undefined {
  const session = result?.data ?? result
  const model = session?.model
  const id = model?.id ?? model?.modelID
  return model?.providerID && id ? `${model.providerID}/${id}` : undefined
}

async function currentModelKey(client: any, sessionID: string, tracked?: string): Promise<string | undefined> {
  if (tracked) return tracked
  try {
    const key = sessionModelKey(await client.session.get({ path: { sessionID } }))
    if (key) return key
  } catch {}
  try {
    const result = await client.session.messages({ path: { id: sessionID } })
    const messages: any[] = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const model = messages[i]?.info?.model
      if (model?.providerID && model?.modelID) return `${model.providerID}/${model.modelID}`
    }
  } catch {}
  try {
    const result = await client.config.get()
    const model = result?.data?.model ?? result?.model
    if (typeof model === "string" && model.includes("/")) return model
  } catch {}
  return undefined
}

async function notify(client: any, title: string, message: string, variant: "info" | "success" | "error" = "info") {
  try {
    if (typeof client.tui?.showToast === "function") {
      await client.tui.showToast({ body: { title, message, variant, duration: 10000 } })
      return
    }
  } catch {}
  try {
    await client.app?.log?.({
      body: { service: "context-limit", level: variant === "error" ? "error" : "info", message },
    })
  } catch {}
}

async function runCommand(
  client: any,
  state: RuleSets,
  limits: Map<string, ModelLimit>,
  opts: CommandOptions,
  input: { sessionID: string; arguments: string },
  tracked?: string,
): Promise<void> {
  const text = (input.arguments ?? "").trim()
  const parts = text.split(/\s+/).filter(Boolean)
  let key: string | undefined
  let valueText = ""
  let showOnly = false

  if (parts.length === 0) {
    showOnly = true
    key = await currentModelKey(client, input.sessionID, tracked)
  } else if (parts.length === 1 && parts[0].includes("/") && !parseBudget(parts[0])) {
    showOnly = true
    key = parts[0]
  } else if (parts.length === 1) {
    key = await currentModelKey(client, input.sessionID, tracked)
    valueText = parts[0]
  } else {
    valueText = parts.slice(1).join(" ")
    key = parts[0] === "current" ? await currentModelKey(client, input.sessionID, tracked) : parts[0]
  }

  if (!key) {
    await notify(client, opts.name, "Could not resolve the current model.", "error")
    return
  }

  const parsed = parseBudget(valueText)
  const clears = valueText === "0" || (parsed?.unit === "tokens" && parsed.value === 0)

  if (showOnly) {
    const ceiling = limits.get(key)?.[opts.kind]
    const rule = longestMatch(state[opts.kind], key)
    const effective = resolveBudget(state[opts.kind], key, ceiling) ?? ceiling
    const budget = rule
      ? rule.unit === "percent"
        ? `${rule.value}%`
        : String(Math.min(rule.value, ceiling ?? rule.value))
      : "none"
    await notify(
      client,
      opts.name,
      [
        `Model: ${key}`,
        `Effective ${opts.fieldLabel}: ${effective ?? "unknown"}`,
        `Budget: ${budget}`,
        "",
        describeRules(state[opts.kind]),
        `${opts.name} ${VERSION}`,
      ].join("\n"),
    )
    return
  }

  if (clears) {
    state[opts.kind] = state[opts.kind].filter((rule) => rule.pattern !== key)
    await saveRules(state)
    await notify(
      client,
      opts.name,
      `Cleared ${opts.kind} budget for ${key}. Restart OpenCode to apply.`,
      "success",
    )
    return
  }

  if (!parsed || (parsed.unit === "tokens" && parsed.value <= 0)) {
    await notify(client, opts.name, `Bad value "${valueText}"; use 128000, 128K, 1M, or 50% (0 clears).`, "error")
    return
  }

  state[opts.kind] = state[opts.kind].filter((rule) => rule.pattern !== key)
  state[opts.kind].push({ pattern: key, value: parsed.value, unit: parsed.unit })
  await saveRules(state)
  const restart = opts.kind === "context" ? " Restart OpenCode to apply." : ""
  await notify(
    client,
    opts.name,
    `Set ${opts.kind} budget for ${key} to ${valueText}.${restart}`,
    "success",
  )
}

const plugin: Plugin = async ({ client }) => {
  const catalog = await loadCatalog()
  const state = await loadRules()
  const limits = new Map<string, ModelLimit>()

  for (const [providerID, provider] of Object.entries(catalog)) {
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      if (model.limit) limits.set(`${providerID}/${modelID}`, { ...model.limit })
    }
  }

  let limitsCaptured = false
  const trackedModels = new Map<string, string>()

  return {
    "chat.message": async (input: any, output: any) => {
      const model = output?.message?.model
      const id = model?.modelID ?? model?.id
      if (input?.sessionID && model?.providerID && id) {
        trackedModels.set(input.sessionID, `${model.providerID}/${id}`)
      }
    },
    config: async (cfg: any) => {
      if (!limitsCaptured) {
        for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const key = `${providerID}/${modelID}`
            limits.set(key, { ...(limits.get(key) ?? {}), ...(model.limit ?? {}) })
          }
        }
        limitsCaptured = true
      }
      applyBudgetToConfig(cfg, limits, state)
      cfg.command ??= {}
      for (const opts of Object.values(COMMANDS)) {
        cfg.command[opts.name] = { template: "$ARGUMENTS", description: opts.description }
      }
    },
    "command.execute.before": async (input: any) => {
      const opts = COMMANDS[input.command]
      if (!opts) return
      await runCommand(client, state, limits, opts, {
        sessionID: input.sessionID,
        arguments: input.arguments ?? "",
      }, trackedModels.get(input.sessionID))
      throw new Error(`${opts.name} handled`)
    },
    "chat.params": async (input: any, output: any) => {
      const key = `${input.model?.providerID}/${input.model?.id}`
      const budget = resolveBudget(state.output, key, limits.get(key)?.output)
      if (budget === undefined) return
      const current = typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : budget
      output.maxOutputTokens = Math.min(current, budget)
    },
  }
}

export default plugin
