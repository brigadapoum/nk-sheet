/**
 * Новое королевство — лист Жука (nk-sheet)
 * Модуль для системы Into the Odd 3.1.x на Foundry VTT 13.
 *
 * 1. Передача предметов между листами персонажей перетаскиванием
 *    (перенос, а не копия; чужой лист — через клиент мастера).
 * 2. Ячейки инвентаря по Кодексу: ёмкость = максимальная Сила,
 *    янтарь (поле «пенни») — 1 ячейка за каждые 100,
 *    в лапках и в карманцах ячеек не занимают, надетые амулеты — тоже.
 * 3. Перегруз, громоздкость (>2 → HP 0), карманцы (2 шт., не громоздкие,
 *    не больше 1 ячейки), ячейки амулетов (1 + по одной за уровень).
 */

const MOD = "nk-sheet"
const SYS = "intotheodd"
const SOCKET = `module.${MOD}`

const LEVELS = ["novice", "professional", "expert", "veteran", "master", "beyond"]

const PLACES = {
  pack: { label: "в мешке", icon: "fa-solid fa-sack" },
  hands: { label: "в лапках", icon: "fa-solid fa-hand" },
  pocket: { label: "в карманце", icon: "fa-solid fa-bag-shopping" },
  neck: { label: "на шее", icon: "fa-solid fa-gem" },
}

const POCKETS = 2
const BULKY_LIMIT = 2

/* -------------------------------------------- */
/*  Утилиты                                     */
/* -------------------------------------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

function flag(item, key, fallback) {
  return foundry.utils.getProperty(item, `flags.${MOD}.${key}`) ?? fallback
}

const isAmulet = (item) => !!flag(item, "amulet", false)
const qtyOf = (item) => Math.max(Number(item.system?.quantity) || 0, 1)
const slotsOf = (item) => Math.max(Number(flag(item, "slots", 1)) || 0, 0)

function placeOf(item) {
  const p = flag(item, "place", "pack")
  if (p === "neck" && !isAmulet(item)) return "pack"
  return PLACES[p] ? p : "pack"
}

function placeCycle(item) {
  const order = isAmulet(item) ? ["pack", "hands", "pocket", "neck"] : ["pack", "hands", "pocket"]
  const i = order.indexOf(placeOf(item))
  return order[(i + 1) % order.length]
}

function isOurCharacter(actor) {
  return game.system.id === SYS && actor?.documentName === "Actor" && actor.type === "character"
}

/* -------------------------------------------- */
/*  Подсчёт нагрузки                            */
/* -------------------------------------------- */

export function computeLoad(actor) {
  const sys = actor.system
  const capacity = Number(sys.abilities?.str?.max) || 0
  const amber = Number(sys.wealth?.pennies) || 0
  const amberSlots = Math.floor(amber / 100)

  let packSlots = amberSlots
  let bulky = 0
  let pockets = 0
  let amuletUsed = 0
  const problems = []

  for (const item of actor.items) {
    if (item.type !== "equipment") continue
    const qty = qtyOf(item)
    const slots = slotsOf(item)
    const place = placeOf(item)
    const amulet = isAmulet(item)

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
        packSlots += (amulet ? Math.min(slots, 1) : slots) * qty
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
    amberSlots,
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
/*  Лист персонажа                              */
/* -------------------------------------------- */

function renderLoadBar(actor) {
  const L = computeLoad(actor)
  const chip = (cls, icon, label, value, tip) =>
    `<span class="nk-chip ${cls}" data-tooltip="${esc(tip)}"><i class="${icon}"></i> ${label} <b>${value}</b></span>`

  const chips = [
    chip(L.overloaded ? "nk-bad" : "", "fa-solid fa-sack", "Ячейки", `${L.packSlots}/${L.capacity}`,
      `Ёмкость = максимальная Сила. Занято вещами в мешке${L.amberSlots ? ` и янтарём (${L.amberSlots})` : ""}.`),
    chip("", "fa-solid fa-coins", "Янтарь", `${L.amber}`, `Каждые 100 янтаря — 1 ячейка. Сейчас: ${L.amberSlots} яч.`),
    chip(L.tooBulky ? "nk-bad" : "", "fa-solid fa-weight-hanging", "Громоздкие", `${L.bulky}/${BULKY_LIMIT}`,
      "Больше 2 громоздких — HP падает до 0 до Длительного отдыха."),
    chip(L.pockets > POCKETS ? "nk-bad" : "", "fa-solid fa-bag-shopping", "Карманцы", `${L.pockets}/${POCKETS}`,
      "По 1 вещи на 1 ячейку, не громоздкой. Пользоваться в бою можно без траты действия."),
    chip(L.amuletUsed > L.amuletCap ? "nk-bad" : "", "fa-solid fa-gem", "Амулеты", `${L.amuletUsed}/${L.amuletCap}`,
      "Ячейки амулетов: 1 на первом уровне и +1 за каждый следующий. Надетые амулеты не занимают ячеек инвентаря."),
  ]

  const warns = []
  if (L.overloaded) warns.push("Перегружен: отряд движется вдвое медленнее.")
  if (L.tooBulky) warns.push("Больше 2 громоздких предметов: HP = 0 до Длительного отдыха.")
  for (const p of L.problems) warns.push(p)

  return `<div class="nk-load">
    <div class="nk-chips">${chips.join("")}</div>
    ${warns.map((w) => `<div class="nk-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w)}</div>`).join("")}
  </div>`
}

/** Деньги: пенни → Янтарь, гульдены → Опыт, шиллинги скрыты */
function relabelWealth(element) {
  const group = (field) => element.querySelector(`[name="system.wealth.${field}"]`)?.closest(".form-group")
  const rename = (field, text) => {
    const label = group(field)?.querySelector("label")
    if (label) label.textContent = text
  }
  rename("pennies", "Янтарь")
  rename("guilders", "Опыт")
  group("shillings")?.classList.add("nk-hidden")
  const legend = element.querySelector(".character-wealth legend")
  if (legend) legend.textContent = "Янтарь и опыт"
}

function decorateCharacterSheet(app, element) {
  const actor = app.document
  const editable = app.isEditable

  relabelWealth(element)

  // Плашка нагрузки над инвентарём
  const tab = element.querySelector(".tab.character-inventory")
  if (tab) {
    tab.querySelector(":scope > .nk-load")?.remove()
    tab.insertAdjacentHTML("afterbegin", renderLoadBar(actor))
  }

  // Строки предметов
  for (const row of element.querySelectorAll(".character-items-list .item[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId)
    if (!item || item.type !== "equipment") continue

    row.querySelectorAll(".nk-tag, .nk-place-btn").forEach((el) => el.remove())

    const place = placeOf(item)
    const slots = slotsOf(item)
    const tags = []
    if (place === "pack") {
      const shown = (isAmulet(item) ? Math.min(slots, 1) : slots) * qtyOf(item)
      tags.push(`<span class="item-info nk-tag" data-tooltip="Занимает ячеек инвентаря">${shown} яч.</span>`)
    } else {
      tags.push(`<span class="item-info nk-tag nk-tag-place"><i class="${PLACES[place].icon}"></i> ${PLACES[place].label}</span>`)
    }
    if (isAmulet(item)) tags.push(`<span class="item-info nk-tag">амулет</span>`)
    row.querySelector("summary > span")?.insertAdjacentHTML("beforeend", tags.join(""))

    if (editable) {
      const next = placeCycle(item)
      const controls = row.querySelector(".item-controls")
      controls?.insertAdjacentHTML(
        "afterbegin",
        `<a class="nk-place-btn" data-tooltip="Переложить: ${esc(PLACES[next].label)}"><i class="${PLACES[place].icon}"></i></a>`
      )
      controls?.querySelector(".nk-place-btn")?.addEventListener("click", (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        item.setFlag(MOD, "place", next)
      })
    }

    // Перетаскивание строки
    if (actor.isOwner && !row.dataset.nkDrag) {
      row.dataset.nkDrag = "1"
      row.setAttribute("draggable", "true")
      row.addEventListener("dragstart", (ev) => {
        const it = actor.items.get(row.dataset.itemId)
        if (!it) return
        ev.dataTransfer.setData("text/plain", JSON.stringify(it.toDragData()))
        ev.dataTransfer.effectAllowed = "copyMove"
        row.classList.add("nk-dragging")
      })
      row.addEventListener("dragend", () => row.classList.remove("nk-dragging"))
    }
  }

  // Приём брошенного предмета — один раз на окно
  if (!element.dataset.nkDrop) {
    element.dataset.nkDrop = "1"
    element.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer?.types?.includes("text/plain")) ev.preventDefault()
    })
    element.addEventListener("drop", (ev) => onDropCapture(app, ev), { capture: true })
  }
}

function onDropCapture(app, event) {
  let data
  try {
    data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event)
  } catch {
    return
  }
  if (data?.type !== "Item" || !data.uuid) return

  const src = fromUuidSync(data.uuid)
  // Из папки предметов или компендиума — пусть работает система (копия)
  if (!src || src.parent?.documentName !== "Actor") return

  // Иначе это перенос между Жуками: забираем событие у системы, чтобы она не сделала копию
  event.preventDefault()
  event.stopImmediatePropagation()

  const target = app.document
  if (src.parent.uuid === target.uuid) return // свой же лист — ничего не делаем
  transferItem(src, target)
}

/* -------------------------------------------- */
/*  Передача предметов                          */
/* -------------------------------------------- */

async function askQuantity(src, have, target) {
  const { DialogV2 } = foundry.applications.api
  return DialogV2.prompt({
    window: { title: `Передать: ${src.name}` },
    content: `<p>Сколько отдать (${esc(target.name)})? Всего: ${have}.</p>
      <input type="number" name="qty" value="1" min="1" max="${have}" step="1" autofocus>`,
    ok: {
      label: "Отдать",
      icon: "fa-solid fa-right-left",
      callback: (event, button) => button.form.elements.qty.valueAsNumber,
    },
    rejectClose: false,
  })
}

async function transferItem(src, target) {
  const srcActor = src.parent
  if (!srcActor.isOwner) {
    ui.notifications.warn("Отдавать можно только вещи своего персонажа.")
    return
  }
  if (src.type !== "equipment") return

  const have = qtyOf(src)
  let qty = 1
  if (have > 1) {
    qty = await askQuantity(src, have, target)
    if (!qty || qty < 1) return
  }

  const payload = { srcUuid: src.uuid, targetUuid: target.uuid, qty, userId: game.user.id }

  if (target.isOwner) return performTransfer(payload)

  if (!game.users.activeGM) {
    ui.notifications.warn("Чтобы передать вещь чужому Жуку, в игре должен быть мастер.")
    return
  }
  game.socket.emit(SOCKET, { action: "transfer", payload })
}

async function performTransfer({ srcUuid, targetUuid, qty, userId }) {
  const src = await fromUuid(srcUuid)
  const target = await fromUuid(targetUuid)
  const user = game.users.get(userId)
  if (!src || !target || !user) return
  const srcActor = src.parent
  if (!srcActor || !srcActor.testUserPermission(user, "OWNER")) return
  if (!isOurCharacter(target) || src.type !== "equipment") return

  const have = qtyOf(src)
  const n = Math.clamp(Math.floor(Number(qty)) || 1, 1, have)
  const stacked = have > 1

  // Стопку подливаем к такой же стопке получателя
  const same = target.items.find(
    (i) => i.type === "equipment" && i.name === src.name && i.system.subType === src.system.subType
  )
  if (stacked && same) {
    await same.update({ "system.quantity": qtyOf(same) + n })
  } else {
    const data = src.toObject()
    delete data._id
    if (stacked) data.system.quantity = n
    data.system.equipped = false
    foundry.utils.setProperty(data, `flags.${MOD}.place`, "pack")
    await target.createEmbeddedDocuments("Item", [data], { renderSheet: false })
  }

  if (n >= have) await src.delete()
  else await src.update({ "system.quantity": have - n })

  const L = computeLoad(target)
  const over = L.overloaded ? ` <span class="nk-chat-warn">перегружен (${L.packSlots}/${L.capacity})</span>` : ""
  const bulky = L.tooBulky ? ` <span class="nk-chat-warn">громоздких ${L.bulky} — HP 0!</span>` : ""

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: srcActor }),
    content: `<div class="nk-transfer"><i class="fa-solid fa-right-left"></i>
      <b>${esc(srcActor.name)}</b> отдаёт <b>${esc(src.name)}${n > 1 ? ` ×${n}` : ""}</b> → <b>${esc(target.name)}</b>${over}${bulky}</div>`,
  })
}

/* -------------------------------------------- */
/*  Лист предмета                               */
/* -------------------------------------------- */

function decorateItemSheet(app, element) {
  const item = app.document
  if (game.system.id !== SYS || item?.type !== "equipment") return

  element.querySelector(".nk-item")?.remove()
  const dis = app.isEditable ? "" : "disabled"
  const place = placeOf(item)
  const amulet = isAmulet(item)
  const options = Object.entries(PLACES)
    .filter(([k]) => k !== "neck" || amulet)
    .map(([k, v]) => `<option value="${k}" ${k === place ? "selected" : ""}>${v.label}</option>`)
    .join("")

  const html = `<section class="nk-item">
    <fieldset>
      <legend>Новое королевство</legend>
      <div class="form-group">
        <label>Ячейки</label>
        <div class="form-fields"><input type="number" name="flags.${MOD}.slots" value="${slotsOf(item)}" min="0" step="1" ${dis}></div>
        <p class="hint">Сколько ячеек инвентаря занимает одна штука.</p>
      </div>
      <div class="form-group">
        <label>Где лежит</label>
        <div class="form-fields"><select name="flags.${MOD}.place" ${dis}>${options}</select></div>
      </div>
      <div class="form-group">
        <label>Амулет</label>
        <div class="form-fields"><input type="checkbox" name="flags.${MOD}.amulet" ${amulet ? "checked" : ""} ${dis}></div>
      </div>
      ${amulet ? `<div class="form-group">
        <label>Ячеек амулета</label>
        <div class="form-fields"><input type="number" name="flags.${MOD}.amuletSlots" value="${flag(item, "amuletSlots", 1)}" min="1" step="1" ${dis}></div>
        <p class="hint">Надетый амулет не занимает ячеек инвентаря, в мешке — не больше 1.</p>
      </div>` : ""}
    </fieldset>
  </section>`

  const anchor = element.querySelector(".item-main") ?? element.querySelector(".window-content > *")
  anchor?.insertAdjacentHTML("afterend", html)
}

/* -------------------------------------------- */
/*  Хуки                                        */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  if (game.system.id !== SYS) return
  game.socket.on(SOCKET, (msg) => {
    if (msg?.action !== "transfer") return
    if (game.user !== game.users.activeGM) return
    performTransfer(msg.payload).catch((err) => console.error(`${MOD} | transfer failed`, err))
  })
  console.log(`${MOD} | готов`)
})

Hooks.on("renderActorSheetV2", (app, element) => {
  if (!isOurCharacter(app.document)) return
  try {
    decorateCharacterSheet(app, element)
  } catch (err) {
    console.error(`${MOD} | character sheet`, err)
  }
})

Hooks.on("renderItemSheetV2", (app, element) => {
  try {
    decorateItemSheet(app, element)
  } catch (err) {
    console.error(`${MOD} | item sheet`, err)
  }
})
