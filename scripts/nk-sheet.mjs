/**
 * Новое королевство — лист Жука (nk-sheet)
 * Модуль для системы Into the Odd 3.1.x на Foundry VTT 13.
 *
 * 1. Передача предметов между листами персонажей перетаскиванием.
 * 2. Ячейки инвентаря по Кодексу, перегруз, громоздкость, карманцы, ячейки амулетов.
 * 3. Вид предмета: амулет / печать / артефакт; заряды амулетов; кнопка «Использовать».
 * 4. Инвентарь: «При себе» наверху, «В мешке» ниже, янтарь отдельной строкой.
 * 5. Торговцы и лавки — в shop.mjs.
 */

import {
  MOD, SYS, SOCKET, PLACES, POCKETS, BULKY_LIMIT, AMBER_PER_SLOT,
  esc, flag, numFlag, isEquipment, isAmulet, isSeal, isArtifact, isReusable, chargesOf, isUsable,
  qtyOf, slotsOf, packSlotsOf, subTypeOf, placesFor, equippedFor, placeFromEquipped, placeOf, placeCycle, setPlace,
  isOurCharacter, isMerchant, computeLoad, removeFromItem,
} from "./common.mjs"

import {
  initShop, handleShopSocket, merchantBlockHTML, bindMerchantBlock, merchantRowTags, shopItemFieldsHTML,
} from "./shop.mjs"

/* -------------------------------------------- */
/*  Плашка нагрузки                             */
/* -------------------------------------------- */

function renderLoadBar(actor) {
  const L = computeLoad(actor)
  const chip = (cls, icon, label, value, tip, extra = "") =>
    `<span class="nk-chip ${cls}" data-tooltip="${esc(tip)}"><i class="${icon}"></i> ${label} <b>${value}</b>${extra}</span>`

  const chips = [
    chip(L.overloaded ? "nk-bad" : "", "fa-solid fa-sack", "Ячейки", `${L.packSlots}/${L.capacity}`,
      `Ёмкость = максимальная Сила. Занято вещами в мешке${L.amberSlots ? ` и янтарём (${L.amberSlots})` : ""}.`),
    chip("", "fa-solid fa-coins", "Янтарь", `${L.amber}`,
      `Каждые полные ${AMBER_PER_SLOT} янтаря — 1 ячейка. Сейчас: ${L.amberSlots} яч.`,
      L.amberSlots ? ` <span class="nk-slot">${L.amberSlots} яч.</span>` : ""),
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

/* -------------------------------------------- */
/*  Строки инвентаря                            */
/* -------------------------------------------- */

const KINDS = [
  { test: isAmulet, cls: "amulet", label: "амулет" },
  { test: isSeal, cls: "seal", label: "печать" },
  { test: isArtifact, cls: "artifact", label: "артефакт" },
]

function rowTags(item, merchant) {
  const place = placeOf(item)
  const tags = []
  for (const k of KINDS) {
    if (k.test(item)) tags.push(`<span class="item-info nk-tag nk-kind nk-kind-${k.cls}">${k.label}</span>`)
  }
  if (isSeal(item) && isReusable(item)) tags.push(`<span class="item-info nk-tag nk-muted">многоразовая</span>`)
  const ch = chargesOf(item)
  if (ch) tags.push(`<span class="item-info nk-tag nk-muted ${ch.value ? "" : "nk-empty"}">заряды ${ch.value}/${ch.max}</span>`)

  if (merchant) {
    tags.push(...merchantRowTags(item))
    return tags.join("")
  }

  if (place !== "pack") {
    tags.push(`<span class="item-info nk-tag nk-tag-place">${PLACES[place].label}</span>`)
  }
  if (place === "pack" || place === "worn") {
    tags.push(`<span class="item-info nk-tag nk-slot" data-tooltip="Занимает ячеек инвентаря">${packSlotsOf(item)} яч.</span>`)
  }
  return tags.join("")
}

function groupHead(label, right) {
  return `<div class="nk-group-head"><span>${label}</span><span>${right}</span></div>`
}

/** «При себе» наверху, «В мешке» ниже, янтарь — первой строкой мешка */
function groupRows(actor, list) {
  list.querySelectorAll(":scope > .nk-group-head, :scope > .nk-amber-row").forEach((el) => el.remove())
  const rows = [...list.querySelectorAll(":scope > .item[data-item-id]")]
  const carried = []
  const bag = []
  const other = []
  for (const row of rows) {
    const item = actor.items.get(row.dataset.itemId)
    if (!item || !isEquipment(item)) other.push(row)
    else if (placeOf(item) === "pack") bag.push(row)
    else carried.push(row)
  }

  const L = computeLoad(actor)
  const wornSlots = actor.items
    .filter((i) => isEquipment(i) && placeOf(i) === "worn")
    .reduce((s, i) => s + packSlotsOf(i), 0)
  const bagSlots = L.packSlots - wornSlots

  const frag = document.createDocumentFragment()
  if (carried.length) {
    frag.append(htmlToEl(groupHead("При себе", wornSlots ? `${wornSlots} яч. — надетая броня` : "0 яч.")))
    carried.forEach((r) => frag.append(r))
  }
  frag.append(htmlToEl(groupHead("В мешке", `${bagSlots} яч.`)))
  if (L.amber > 0) {
    frag.append(htmlToEl(`<div class="nk-amber-row" data-tooltip="Каждые полные ${AMBER_PER_SLOT} янтаря — 1 ячейка">
      <span>Янтарь ${L.amber}</span><span class="nk-slot ${L.amberSlots ? "" : "nk-zero"}">${L.amberSlots} яч.</span></div>`))
  }
  bag.forEach((r) => frag.append(r))
  other.forEach((r) => frag.append(r))
  list.append(frag)
}

function htmlToEl(html) {
  const t = document.createElement("template")
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

/* -------------------------------------------- */
/*  Лист персонажа                              */
/* -------------------------------------------- */

function decorateCharacterSheet(app, element) {
  const actor = app.document
  const editable = app.isEditable
  const merchant = isMerchant(actor)
  const equippedLabel = game.i18n.localize("INTOTHEODD.Equipment.FIELDS.equipped.label")

  relabelWealth(element)

  const tab = element.querySelector(".tab.character-inventory")
  if (tab) {
    tab.querySelectorAll(":scope > .nk-load, :scope > .nk-merchant, :scope > .nk-merchant-toggle").forEach((el) => el.remove())
    if (merchant) {
      if (game.user.isGM) {
        tab.insertAdjacentHTML("afterbegin", merchantBlockHTML(actor))
        bindMerchantBlock(tab.querySelector(":scope > .nk-merchant"), actor)
      }
    } else {
      tab.insertAdjacentHTML("afterbegin", renderLoadBar(actor))
      if (game.user.isGM && editable) {
        tab.insertAdjacentHTML("beforeend", `<label class="nk-merchant-toggle" data-tooltip="Видит только мастер">
          <input type="checkbox" name="flags.${MOD}.merchant.enabled"> Сделать торговцем: инвентарь станет ассортиментом лавки</label>`)
      }
    }
  }

  for (const row of element.querySelectorAll(".character-items-list .item[data-item-id]")) {
    const item = actor.items.get(row.dataset.itemId)
    if (!item || !isEquipment(item)) continue

    row.querySelectorAll(".nk-tag, .nk-place-btn, .nk-use-btn").forEach((el) => el.remove())

    // Системная экипировка заменена местом: прячем щит и бирку «Equipped»
    row.querySelectorAll('[data-action="equip"], [data-action="unequip"]').forEach((el) => el.classList.add("nk-hidden"))
    for (const info of row.querySelectorAll("summary .item-info:not(.nk-tag)")) {
      if (info.textContent.trim() === equippedLabel) info.classList.add("nk-hidden")
      // Системную «Arcana» заменяют наши метки вида
      if (info.textContent.trim() === game.i18n.localize("INTOTHEODD.Equipment.FIELDS.arcana.label")) info.classList.add("nk-hidden")
    }

    row.querySelector("summary > span")?.insertAdjacentHTML("beforeend", rowTags(item, merchant))

    if (editable && !merchant) {
      const controls = row.querySelector(".item-controls")
      const place = placeOf(item)
      const next = placeCycle(item)
      controls?.insertAdjacentHTML(
        "afterbegin",
        `<a class="nk-place-btn" data-tooltip="Переложить: ${esc(PLACES[next].label)}"><i class="${PLACES[place].icon}"></i></a>`
      )
      controls?.querySelector(".nk-place-btn")?.addEventListener("click", (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        setPlace(item, next)
      })

      if (isUsable(item)) {
        const ch = chargesOf(item)
        const tip = isSeal(item) ? (isReusable(item) ? "Использовать печать" : "Использовать печать (сгорит)") : `Использовать заряд (${ch.value}/${ch.max})`
        controls?.insertAdjacentHTML("afterbegin", `<a class="nk-use-btn" data-tooltip="${tip}"><i class="fa-solid fa-bolt"></i></a>`)
        controls?.querySelector(".nk-use-btn")?.addEventListener("click", (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          useItem(item)
        })
      }
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

  const list = element.querySelector(".character-items-list")
  if (list && !merchant) groupRows(actor, list)

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

  // Иначе это перенос между листами: забираем событие у системы, чтобы она не сделала копию
  event.preventDefault()
  event.stopImmediatePropagation()

  const target = app.document
  if (src.parent.uuid === target.uuid) return // свой же лист — ничего не делаем
  transferItem(src, target)
}

/* -------------------------------------------- */
/*  Использовать печать / заряд амулета         */
/* -------------------------------------------- */

async function useItem(item) {
  const actor = item.parent
  if (!actor?.isOwner) return
  const desc = await foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description ?? "", {
    relativeTo: item,
  })

  let title
  let footer
  let kind
  if (isSeal(item)) {
    kind = "seal"
    title = `Использует ${esc(item.name)}`
    if (isReusable(item)) footer = "Печать многоразовая — остаётся у владельца"
    else {
      footer = qtyOf(item) > 1 ? `Печать сгорела, осталось ${qtyOf(item) - 1}` : "Печать сгорела"
      await removeFromItem(item, 1)
    }
  } else {
    const ch = chargesOf(item)
    if (!ch) return
    if (ch.value < 1) {
      ui.notifications.warn(`У «${item.name}» не осталось зарядов.`)
      return
    }
    kind = "amulet"
    await item.update({ [`flags.${MOD}.charges`]: ch.value - 1 })
    title = `Использует ${esc(item.name)}`
    footer = `Заряды ${ch.value}/${ch.max} → ${ch.value - 1}/${ch.max}`
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="nk-card nk-use nk-use-${kind}">
      <div class="nk-card-title">${title}</div>
      ${desc ? `<div class="nk-card-desc">${desc}</div>` : ""}
      <div class="nk-card-foot">${footer}</div>
    </div>`,
  })
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
  if (!isEquipment(src)) return

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
  if (!isOurCharacter(target) || !isEquipment(src)) return

  const have = qtyOf(src)
  const n = Math.clamp(Math.floor(Number(qty)) || 1, 1, have)
  const stacked = have > 1

  // Стопку подливаем к такой же стопке получателя
  const same = target.items.find(
    (i) => isEquipment(i) && i.name === src.name && i.system.subType === src.system.subType
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
  if (game.system.id !== SYS || !isEquipment(item)) return

  element.querySelector(".nk-item")?.remove()
  const dis = app.isEditable ? "" : "disabled"
  const place = placeOf(item)
  const amulet = isAmulet(item)
  const seal = isSeal(item)
  const options = placesFor(subTypeOf(item), amulet)
    .map((k) => `<option value="${k}" ${k === place ? "selected" : ""}>${PLACES[k].label}</option>`)
    .join("")

  // Галочку «экипировано» заменяет «Где лежит», системную «Arcana» — наш «Вид»
  element.querySelector('[name="system.equipped"]')?.closest(".form-group")?.remove()
  element.querySelector('[name="system.arcana"]')?.closest(".form-group")?.classList.add("nk-hidden")

  const check = (key, on, label, cls) =>
    `<label class="nk-check nk-kind-${cls}"><input type="checkbox" name="flags.${MOD}.${key}" ${on ? "checked" : ""} ${dis}> ${label}</label>`
  const num = (key, value, attrs = "") =>
    `<input type="number" name="flags.${MOD}.${key}" value="${value ?? ""}" ${attrs} ${dis}>`

  const charges = amulet
    ? `<div class="form-group">
        <label>Ячеек амулета</label>
        <div class="form-fields">${num("amuletSlots", flag(item, "amuletSlots", 1), 'min="1" step="1"')}</div>
        <p class="hint">Надетый амулет не занимает ячеек инвентаря, в мешке — не больше 1.</p>
      </div>
      <div class="form-group">
        <label>Заряды</label>
        <div class="form-fields nk-pair">
          ${num("charges", numFlag(item, "charges") ?? numFlag(item, "chargesMax") ?? "", 'min="0" step="1"')}
          <span>из</span>
          ${num("chargesMax", numFlag(item, "chargesMax"), 'min="0" step="1" placeholder="нет"')}
        </div>
        <p class="hint">Пусто — амулет без зарядов. С зарядами в инвентаре появляется кнопка «Использовать».</p>
      </div>`
    : ""

  const reusable = seal
    ? `<div class="form-group">
        <label>Многоразовая</label>
        <div class="form-fields"><input type="checkbox" name="flags.${MOD}.reusable" ${isReusable(item) ? "checked" : ""} ${dis}></div>
        <p class="hint">Без галочки печать после использования исчезает.</p>
      </div>`
    : ""

  const html = `<section class="nk-item">
    <fieldset>
      <legend>Новое королевство</legend>
      <div class="form-group">
        <label>Ячейки</label>
        <div class="form-fields">${num("slots", slotsOf(item), 'min="0" step="1"')}</div>
        <p class="hint">Сколько ячеек инвентаря занимает одна штука.</p>
      </div>
      <div class="form-group">
        <label>Где лежит</label>
        <div class="form-fields"><select name="flags.${MOD}.place" ${dis}>${options}</select></div>
      </div>
      <div class="form-group">
        <label>Вид</label>
        <div class="form-fields nk-checks">
          ${check("amulet", amulet, "амулет", "amulet")}
          ${check("seal", seal, "печать", "seal")}
          ${check("artifact", isArtifact(item), "артефакт", "artifact")}
        </div>
      </div>
      ${reusable}
      ${charges}
    </fieldset>
    ${shopItemFieldsHTML(item, dis)}
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
    if (msg?.action === "transfer") {
      if (game.user !== game.users.activeGM) return
      performTransfer(msg.payload).catch((err) => console.error(`${MOD} | transfer failed`, err))
      return
    }
    handleShopSocket(msg)
  })
  initShop()
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

// Держим место и экипировку согласованными, кто бы их ни менял
Hooks.on("preUpdateItem", (item, changes) => {
  if (game.system.id !== SYS || !isEquipment(item)) return
  const get = (path) => foundry.utils.getProperty(changes, path)
  const subType = get("system.subType") ?? subTypeOf(item)
  const amulet = get(`flags.${MOD}.amulet`) ?? isAmulet(item)
  const newPlace = get(`flags.${MOD}.place`)
  const newEquipped = get("system.equipped")

  if (newPlace !== undefined) {
    const place = placesFor(subType, amulet).includes(newPlace) ? newPlace : "pack"
    foundry.utils.setProperty(changes, `flags.${MOD}.place`, place)
    foundry.utils.setProperty(changes, "system.equipped", equippedFor(subType, place))
  } else if (newEquipped !== undefined || get("system.subType") !== undefined) {
    const equipped = newEquipped ?? !!item.system.equipped
    const place = placeFromEquipped(subType, equipped, placeOf(item))
    foundry.utils.setProperty(changes, `flags.${MOD}.place`, place)
    foundry.utils.setProperty(changes, "system.equipped", equippedFor(subType, place))
  }

  // Заряды не больше максимума
  const max = get(`flags.${MOD}.chargesMax`) !== undefined ? Number(get(`flags.${MOD}.chargesMax`)) || 0 : numFlag(item, "chargesMax")
  const cur = get(`flags.${MOD}.charges`)
  if (cur !== undefined && cur !== null && max) {
    foundry.utils.setProperty(changes, `flags.${MOD}.charges`, Math.clamp(Number(cur) || 0, 0, max))
  }
})

Hooks.on("renderItemSheetV2", (app, element) => {
  try {
    decorateItemSheet(app, element)
  } catch (err) {
    console.error(`${MOD} | item sheet`, err)
  }
})

/** Для проверок вне Foundry */
export const _internals = { decorateCharacterSheet, decorateItemSheet }
