/**
 * Собирает исходники компендиумов из таблиц цен кампании.
 *
 *   node tools/tables-to-packs.mjs "<папка 04_Таблицы>"
 *
 * Пишет JSON в packs-src/catalog и packs-src/merchants. Потом:
 *   node tools/compile-packs.mjs   (нужен npm i @foundryvtt/foundryvtt-cli@1)
 *
 * id документов детерминированные (хэш таблицы и названия), поэтому пересборка
 * не плодит дубликатов, а catalogId связывает купленное с товаром у любого торговца.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const SRC = process.argv[2]
if (!SRC) throw new Error("Укажи папку с таблицами (04_Таблицы)")
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../packs-src")
const MOD = "nk-sheet"
const STATS = { coreVersion: "13.351", systemId: "intotheodd", systemVersion: "3.1.0" }

const id16 = (s) => {
  const h = crypto.createHash("sha1").update(s).digest()
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  return [...h.subarray(0, 16)].map((b) => abc[b % abc.length]).join("")
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/* Таблица → раздел лавки и что с ней делать */
const TABLES = {
  "prices-light": { section: "Свет" },
  "prices-tools": { section: "Инструменты" },
  "prices-alchemy": { section: "Алхимия" },
  "prices-luxury": { section: "Одежда и роскошь" },
  "weapons-common": { section: "Оружие", subType: "weapon" },
  "armor-common": { section: "Броня", subType: "armour" },
  "prices-seals": { section: "Печати", seal: true },
  "prices-amulets": { section: "Амулеты", amulet: true },
  "prices-artifacts": { section: "Артефакты", artifact: true },
  "prices-food": { section: "Еда", only: ["Рацион"] },
}

function parseEntry(table, r, opts) {
  let text = r.text.trim()
  if (opts.artifact) text = text.replace(/^[АБ]\s*·\s*/, "")
  const [head, priceText = ""] = text.split(/\s+·\s+(?=[\d×]|найм)/)
  const m = head.match(/^(.*?)\s*\((.*)\)\s*$/)
  const name = (m ? m[1] : head).trim()
  let extra = m ? m[2].trim() : ""
  let desc = r.desc ?? ""
  // У артефактов и оружия-печатей свойства — в начале описания: «(d8, Громоздкое). …»
  const lead = desc.match(/^\(([^)]*)\)\.?\s*/)
  if (lead && (opts.artifact || /\bd\d/.test(lead[1]))) {
    extra = [extra, lead[1]].filter(Boolean).join(", ")
    desc = desc.slice(lead[0].length)
  }

  const pm = priceText.match(/^(\d+)(?:\s+продажа\s+(\d+))?\s+я/)
  const exchange = priceText.match(/^(\d+)\s+при обмене/)
  const price = pm ? Number(pm[1]) : null
  const resale = pm && pm[2] ? Number(pm[2]) : null

  const parts = extra ? extra.split(/\s*[,;]\s*/) : []
  const bulky = /Громоздк/i.test(extra)
  // Печать-оружие (Серп Хлада): «(оружие, многоразовое). Раненный этим серпом (d6)…»
  const dmg = extra.match(/\b(\d*d\d+)\b/) ?? (opts.seal && /оружие/.test(desc) ? desc.match(/\((\d*d\d+)\)/) : null)
  const arm = extra.match(/\+(\d+)\s*A\b/)
  const slotsM = extra.match(/(\d+)\s+ячейк/)
  const uses = extra.match(/(\d+)\s+(?:применени|атак)/)
  const subType = opts.subType ?? (arm ? "armour" : dmg ? (opts.artifact || opts.seal ? "weapon" : "equipment") : "equipment")

  const section = table === "prices-light" && /Пули|Стрел|Камни/.test(name) ? "Боеприпасы" : opts.section
  const flags = { catalogId: `${table}/${name}`, section }
  if (price !== null) flags.price = price
  if (resale !== null) flags.resale = resale
  if (opts.seal) {
    flags.seal = true
    if (/многоразов/i.test(extra) || /многоразов/i.test(desc)) flags.reusable = true
  }
  if (opts.amulet) {
    flags.amulet = true
    const am = desc.match(/(\d+)\s+ячейк\S*\.?\s*$/) ?? slotsM
    if (am && Number(am[1]) > 1) flags.amuletSlots = Number(am[1])
    if (uses) {
      flags.chargesMax = Number(uses[1])
      flags.charges = Number(uses[1])
    }
    // Находки (строки 13–22) не продаются — только скупка
    if (r.range[0] >= 13) flags.noSale = true
  } else if (slotsM) flags.slots = Number(slotsM[1])
  if (opts.artifact) {
    flags.artifact = true
    flags.gmOnly = true
    delete flags.price // Вещи Прежних не продаются и не покупаются
  }

  const notes = []
  if (extra) notes.push(extra)
  if (exchange) notes.push(`Ценность при обмене: ${exchange[1]} я. Вещи Прежних не продаются и не покупаются.`)
  const description =
    (notes.length ? `<p><em>${esc(notes.join(" · "))}</em></p>` : "") + (desc ? `<p>${esc(desc)}</p>` : "")

  return {
    name,
    type: "equipment",
    system: {
      subType,
      description,
      armour: arm ? Number(arm[1]) : 0,
      quantity: 1,
      damageFormula: dmg && subType === "weapon" ? dmg[1] : null,
      equipped: false,
      bulky,
      blast: /по площади/i.test(extra),
      arcana: false,
    },
    flags: { [MOD]: flags },
  }
}

const catalog = []
for (const [table, opts] of Object.entries(TABLES)) {
  const file = path.join(SRC, `${table}.json`)
  if (!fs.existsSync(file)) {
    console.warn(`нет таблицы ${table}`)
    continue
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  for (const r of data.results ?? []) {
    const item = parseEntry(table, r, opts)
    if (opts.only && !opts.only.includes(item.name)) continue
    if (item.flags[MOD].price === undefined && !opts.artifact) {
      console.warn(`  без цены, пропущено: ${table}: ${r.text}`)
      continue
    }
    item._id = id16(`catalog/${table}/${item.name}`)
    item._table = table
    catalog.push(item)
  }
}

/* Торговцы: какие разделы кто держит */
const MERCHANTS = [
  {
    name: "Мэтр Лампаньон",
    tables: ["prices-light", "prices-tools", "prices-alchemy", "prices-luxury", "prices-food"],
    bio: "<p>Эксцентричный торговец из Алотэ. Торговал здесь ещё до прихода новых правителей. Хранит свои секреты.</p>",
  },
  { name: "Торговец Печатями", tables: ["prices-seals"], bio: "" },
  { name: "Торговец Амулетами", tables: ["prices-amulets"], bio: "" },
]

const write = (dir, doc) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${doc._id}.json`), JSON.stringify(doc, null, 2) + "\n")
}
fs.rmSync(OUT, { recursive: true, force: true })

const folderId = (name) => id16(`folder/${name}`)
const folders = new Map()
for (const item of catalog) {
  const sec = item.flags[MOD].section
  if (!folders.has(sec)) {
    const f = { _id: folderId(sec), name: sec, type: "Item", sorting: "a", color: null, folder: null, sort: folders.size * 1000, _key: `!folders!${folderId(sec)}` }
    folders.set(sec, f)
    write(path.join(OUT, "catalog"), f)
  }
}
for (const item of catalog) {
  const { _table, ...doc } = item
  write(path.join(OUT, "catalog"), {
    ...doc,
    folder: folderId(doc.flags[MOD].section),
    img: "icons/svg/item-bag.svg",
    effects: [],
    ownership: { default: 0 },
    _stats: STATS,
    _key: `!items!${doc._id}`,
  })
}

for (const m of MERCHANTS) {
  const actorId = id16(`merchant/${m.name}`)
  const items = catalog
    .filter((i) => m.tables.includes(i._table))
    .map(({ _table, ...i }) => ({
      ...i,
      _id: id16(`merchant/${m.name}/${i.name}`),
      img: "icons/svg/item-bag.svg",
      folder: null,
      effects: [],
      ownership: { default: 0 },
      _stats: STATS,
      _key: `!actors.items!${actorId}.${id16(`merchant/${m.name}/${i.name}`)}`,
    }))
  write(path.join(OUT, "merchants"), {
    _id: actorId,
    name: m.name,
    type: "character",
    img: "icons/svg/mystery-man.svg",
    system: { biography: m.bio, wealth: { guilders: 0, shillings: 0, pennies: 0 } },
    prototypeToken: { name: m.name, actorLink: true, displayName: 20, disposition: 0 },
    items,
    effects: [],
    folder: null,
    ownership: { default: 0 },
    flags: { [MOD]: { merchant: { enabled: true, wallet: 1000, minSell: 5 } } },
    _stats: STATS,
    _key: `!actors!${actorId}`,
  })
  console.log(`${m.name}: ${items.length} товаров`)
}
console.log(`каталог: ${catalog.length} предметов в ${folders.size} разделах`)
