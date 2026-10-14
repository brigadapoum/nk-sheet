/**
 * Общие константы и утилиты nk-sheet.
 */

export const MOD = "nk-sheet"
export const SYS = "intotheodd"
export const SOCKET = `module.${MOD}`

export const LEVELS = ["novice", "professional", "expert", "veteran", "master", "beyond"]

export const PLACES = {
  pack: { label: "в мешке", icon: "fa-solid fa-sack" },
  worn: { label: "надета", icon: "fa-solid fa-shirt" },
  hands: { label: "в лапках", icon: "fa-solid fa-hand" },
  pocket: { label: "в карманце", icon: "fa-solid fa-bag-shopping" },
  neck: { label: "на шее", icon: "fa-solid fa-gem" },
}

export const POCKETS = 2
export const BULKY_LIMIT = 2
export const AMBER_PER_SLOT = 100

/* -------------------------------------------- */
/*  Мелочи                                      */
/* -------------------------------------------- */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

export function flag(doc, key, fallback) {
  return foundry.utils.getProperty(doc, `flags.${MOD}.${key}`) ?? fallback
}

/** Число из флага: пустое поле и мусор → null */
export function numFlag(doc, key) {
  const v = foundry.utils.getProperty(doc, `flags.${MOD}.${key}`)
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const normName = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")

/* -------------------------------------------- */
/*  Предметы                                    */
/* -------------------------------------------- */

export const isEquipment = (item) => item?.type === "equipment"
export const isAmulet = (item) => !!flag(item, "amulet", false)
export const isSeal = (item) => !!flag(item, "seal", false)
export const isArtifact = (item) => !!flag(item, "artifact", false)
export const isReusable = (item) => !!flag(item, "reusable", false)

export const qtyOf = (item) => Math.max(Number(item.system?.quantity) || 0, 1)
export const slotsOf = (item) => Math.max(Number(flag(item, "slots", 1)) || 0, 0)
export const subTypeOf = (item) => item.system?.subType ?? "equipment"

/** Заряды амулета: null — у предмета нет зарядов */
export function chargesOf(item) {
  if (!isAmulet(item)) return null
  const max = numFlag(item, "chargesMax")
  if (!max || max < 1) return null
  const value = Math.clamp(numFlag(item, "charges") ?? max, 0, max)
  return { value, max }
}

/** Можно ли «использовать» предмет кнопкой-молнией */
export const isUsable = (item) => isEquipment(item) && (isSeal(item) || !!chargesOf(item))

/** Сколько ячеек занимает вещь, если лежит в мешке (или надета) */
export function packSlotsOf(item) {
  const slots = slotsOf(item)
  return (isAmulet(item) ? Math.min(slots, 1) : slots) * qtyOf(item)
}

/** Какие места доступны предмету — в порядке переключения кнопкой */
export function placesFor(subType, amulet) {
  if (subType === "armour") return ["pack", "worn"]
  if (amulet) return ["pack", "hands", "pocket", "neck"]
  return ["pack", "hands", "pocket"]
}

export function equippedFor(subType, place) {
  if (subType === "armour") return place === "worn"
  if (subType === "weapon") return place === "hands" || place === "pocket"
  return false
}

/** Место по старой экипировке — для вещей, которым место ещё не задавали */
export function placeFromEquipped(subType, equipped, current = "pack") {
  if (subType === "armour") return equipped ? "worn" : current === "worn" ? "pack" : current
  if (subType === "weapon") {
    if (equipped) return current === "hands" || current === "pocket" ? current : "hands"
    return current === "hands" || current === "pocket" ? "pack" : current
  }
  return current
}

export function placeOf(item) {
  const allowed = placesFor(subTypeOf(item), isAmulet(item))
  const stored = flag(item, "place", undefined)
  const p = stored ?? placeFromEquipped(subTypeOf(item), !!item.system?.equipped)
  return allowed.includes(p) ? p : "pack"
}

export function placeCycle(item) {
  const order = placesFor(subTypeOf(item), isAmulet(item))
  const i = order.indexOf(placeOf(item))
  return order[(i + 1) % order.length]
}

/** Одно обновление: место + экипировка вместе */
export function setPlace(item, place) {
  return item.update({ [`flags.${MOD}.place`]: place, "system.equipped": equippedFor(subTypeOf(item), place) })
}

/* -------------------------------------------- */
/*  Актёры                                      */
/* -------------------------------------------- */

export function isOurCharacter(actor) {
  return game.system.id === SYS && actor?.documentName === "Actor" && actor.type === "character"
}

export const isMerchant = (actor) => isOurCharacter(actor) && !!flag(actor, "merchant.enabled", false)

export const amberOf = (actor) => Math.max(Number(actor.system?.wealth?.pennies) || 0, 0)
export const amberSlots = (amber) => Math.floor(Math.max(amber, 0) / AMBER_PER_SLOT)

/** Ячейки, которые займёт вещь, если положить её в мешок в количестве n */
export function slotsForNew(item, n) {
  const slots = slotsOf(item)
  return (isAmulet(item) ? Math.min(slots, 1) : slots) * n
}

/* -------------------------------------------- */
/*  Подсчёт нагрузки                            */
/* -------------------------------------------- */

export function computeLoad(actor) {
  const sys = actor.system
  const capacity = Number(sys.abilities?.str?.max) || 0
  const amber = amberOf(actor)
  const aSlots = amberSlots(amber)

  let packSlots = aSlots
  let bulky = 0
  let pockets = 0
  let amuletUsed = 0
  const problems = []

  for (const item of actor.items) {
    if (!isEquipment(item)) continue
    const qty = qtyOf(item)
    const slots = slotsOf(item)
    const place = placeOf(item)

    if (item.system.bulky) bulky += qty

    switch (place) {
      case "neck":
        amuletUsed += Math.max(Number(flag(item, "amuletSlots", 1)) || 1, 1)
        break
      case "hands":
        break
      case "pocket":
        pockets += qty
        if (item.system.bulky) problems.push(`«${item.name}» громоздкий — в карманец нельзя`)
        if (slots > 1) problems.push(`«${item.name}» занимает ${slots} яч. — в карманец влезает только вещь на 1 ячейку`)
        break
      default:
        packSlots += packSlotsOf(item)
    }
  }

  const levelIdx = Math.max(LEVELS.indexOf(sys.level), 0)
  const amuletCap = levelIdx + 1

  if (pockets > POCKETS) problems.push(`В карманцах ${pockets} вещей, а карманцев всего ${POCKETS}`)
  if (amuletUsed > amuletCap) problems.push(`Надето амулетов на ${amuletUsed} яч., а ячеек амулетов ${amuletCap}`)

  return {
    capacity,
    packSlots,
    amber,
    amberSlots: aSlots,
    bulky,
    pockets,
    amuletUsed,
    amuletCap,
    overloaded: packSlots > capacity,
    tooBulky: bulky > BULKY_LIMIT,
    problems,
  }
}

/* -------------------------------------------- */
/*  Стопки                                      */
/* -------------------------------------------- */

/**
 * Положить n штук вещи в мешок актёра: подлить к такой же стопке или создать новую.
 * @returns {{id: string, created: boolean}}
 */
export async function addToActor(actor, data, n, sameAs) {
  const same = actor.items.find((i) => isEquipment(i) && sameAs(i))
  if (same) {
    await same.update({ "system.quantity": qtyOf(same) + n })
    return { id: same.id, created: false }
  }
  const copy = foundry.utils.deepClone(data)
  delete copy._id
  copy.system ??= {}
  copy.system.quantity = n
  copy.system.equipped = false
  foundry.utils.setProperty(copy, `flags.${MOD}.place`, "pack")
  const [created] = await actor.createEmbeddedDocuments("Item", [copy], { renderSheet: false })
  return { id: created.id, created: true }
}

/** Убрать n штук предмета (вся стопка — удалить) */
export async function removeFromItem(item, n) {
  const have = qtyOf(item)
  if (n >= have) await item.delete()
  else await item.update({ "system.quantity": have - n })
}

/** Та же вещь: по id каталога, иначе по названию и типу */
export function sameThing(a, b) {
  const ca = flag(a, "catalogId", null)
  const cb = flag(b, "catalogId", null)
  if (ca && cb) return ca === cb
  return normName(a.name) === normName(b.name) && subTypeOf(a) === subTypeOf(b)
}
