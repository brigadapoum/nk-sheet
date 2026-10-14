/**
 * packs-src/<имя> → packs/<имя> (LevelDB для Foundry 13).
 * Нужен @foundryvtt/foundryvtt-cli@1 (путь можно передать через NK_CLI).
 */
import path from "node:path"
import fs from "node:fs"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const cli = await import(process.env.NK_CLI ?? "@foundryvtt/foundryvtt-cli")

for (const name of fs.readdirSync(path.join(root, "packs-src"))) {
  const dest = path.join(root, "packs", name)
  fs.rmSync(dest, { recursive: true, force: true })
  await cli.compilePack(path.join(root, "packs-src", name), dest, { recursive: true })
  console.log(`packs/${name}`)
}
