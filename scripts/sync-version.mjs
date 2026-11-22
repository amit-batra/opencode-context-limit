import { readFile, writeFile } from "node:fs/promises"

const packageFile = new URL("../package.json", import.meta.url)
const pluginFile = new URL("../context-limit.ts", import.meta.url)

const pkg = JSON.parse(await readFile(packageFile, "utf8"))
const source = await readFile(pluginFile, "utf8")
const pattern = /^const VERSION = ".*"$/m

if (!pattern.test(source)) {
  throw new Error("Could not find the VERSION constant in context-limit.ts")
}

await writeFile(pluginFile, source.replace(pattern, `const VERSION = "${pkg.version}"`))
