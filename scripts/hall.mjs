/**
 * Стол кампании (с 0.4.0)
 *
 * Сцена с галочкой «Стол кампании» получает поверх себя панели:
 *  - слева — карточки НИП по группам (по умолчанию «Правители Алотэ» и «Жители»):
 *    клик открывает связанный документ, кнопка под карточкой — лавку торговца или другой документ;
 *  - справа — галерея Жуков игроков с прокруткой: клик — лист, «В экспедицию» — жетон на площадь сцены;
 *  - сверху — бегущая строка «Вести».
 * Настройки стола хранятся во флаге сцены flags.nk-sheet.hall; правит их только мастер.
 * Жетоны отряда — обычные токены сцены с флагом flags.nk-sheet.expedition; ставит и убирает их клиент мастера.
 */

import { MOD, SOCKET, esc, isOurCharacter, isMerchant } from "./common.mjs"
import { openShopWindow } from "./shop.mjs"

const SLOTS_PER_ROW = 6
const ROWS = 2
const DEFAULT_AREA = { x: 31, y: 68, w: 40, h: 16 } // площадь сбора, % от сцены

/* -------------------------------------------- */
/*  Данные стола                                */
/* -------------------------------------------- */

const rid = () => foundry.utils.randomID(8)

function defaultHall() {
  const lamp = game.actors.getName("Мэтр Лампаньон")
  const card = (name, role, extra = {}) => ({ id: rid(), name, role, img: "", uuid: "", btnLabel: "", btnUuid: "", ...extra })
  return {
    enabled: true,
    subtitle: "Новое Королевство",
    groups: [
      {
        id: rid(),
        title: "Правители Алотэ",
        cards: [
          card("Делец", "Казна и сбор крессельских сокровищ"),
          card("Ученица Сю", "Ей адресуют доклады отрядов"),
          card("Глашатай", ""),
          card("Судья", "Ведёт записи о мире и истории"),
        ],
      },
      {
        id: rid(),
        title: "Жители",
        cards: [
          card("Мэтр Лампаньон", "", lamp ? { uuid: lamp.uuid, btnLabel: "Лавка", btnUuid: lamp.uuid } : { btnLabel: "Лавка" }),
          card("Донна Тетива", "«Золотая Тетива»"),
          card("Наёмники", "", { btnLabel: "Найм" }),
          card("Картограф", ""),
        ],
      },
    ],
    news: [
      "Старик у костра говорит: Сталь ушла из Алотэ на Запад во главе воинства",
      "Скала с пещерой на Алом Западе помечена мелом — место под лагерь",
      "На привалах в Алом Западе нападают кузнечики с маковым молочком",
      "Доклады отрядов принимает ученица Сю",
    ],
    area: { ...DEFAULT_AREA },
  }
}

export const hallOf = (scene) => {
  const h = scene?.getFlag?.(MOD, "hall")
  return h?.enabled ? h : null
}

async function saveHall(scene, hall) {
  // группы и карточки — массивы, они заменяются целиком, так что удалённое не «склеится» со старым
  await scene.update({ [`flags.${MOD}.hall`]: hall })
}

/** Жуки игроков: персонажи с владельцем-игроком, кроме торговцев */
function partyActors() {
  return game.actors
    .filter((a) => isOurCharacter(a) && !isMerchant(a) && a.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
}

function ownersOf(actor) {
  return game.users
    .filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER"))
    .map((u) => u.name)
    .join(", ")
}

const expeditionTokens = (scene) => scene?.tokens.filter((t) => t.getFlag(MOD, "expedition")) ?? []

/* -------------------------------------------- */
/*  Картинки и ссылки                           */
/* -------------------------------------------- */

const DEFAULT_IMGS = new Set(["icons/svg/mystery-man.svg", "icons/svg/item-bag.svg", ""])

function imgOfDoc(doc) {
  if (!doc) return ""
  if (doc.documentName === "JournalEntry") return doc.pages?.find((p) => p.type === "image")?.src ?? ""
  if (doc.documentName === "JournalEntryPage") return doc.type === "image" ? doc.src ?? "" : ""
  return doc.img ?? ""
}

function cardImg(card) {
  if (card.img) return card.img
  const doc = card.uuid ? fromUuidSync(card.uuid) : null
  const src = imgOfDoc(doc)
  return DEFAULT_IMGS.has(src) ? "" : src
}

async function openDoc(uuid, { tableDraw = false } = {}) {
  if (!uuid) return ui.notifications.info("Мастер ещё ничего сюда не привязал.")
  const doc = await fromUuid(uuid)
  if (!doc) return ui.notifications.warn("Связанный документ не найден.")
  if (doc.documentName === "Actor" && isMerchant(doc)) return openShopWindow(doc)
  if (doc.documentName === "RollTable" && tableDraw && game.user.isGM) return doc.draw()
  if (!game.user.isGM && !doc.testUserPermission(game.user, "LIMITED")) {
    return ui.notifications.info(`${doc.name}: мастер ещё не открыл эту запись.`)
  }
  if (doc.documentName === "JournalEntryPage") return doc.parent?.sheet.render(true, { pageId: doc.id })
  return doc.sheet?.render(true)
}

const SILHOUETTE = `<svg viewBox="0 0 54 62" aria-hidden="true"><path d="M27 2C12 2 4 16 4 32v28h46V32C50 16 42 2 27 2Z" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M15 34c3-8 21-8 24 0-2 10-22 10-24 0Z" fill="currentColor"/></svg>`

const pic = (src, cls) =>
  src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<span class="${cls} nk-hall-noimg">${SILHOUETTE}</span>`

/* -------------------------------------------- */
/*  Отрисовка                                   */
/* -------------------------------------------- */

let root = null
let hidden = false
let renderQueued = false

function queueRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    renderHall()
  })
}

function cardHTML(group, card) {
  const gm = game.user.isGM
  const btn = card.btnLabel
    ? `<button type="button" class="nk-hall-cardbtn" data-act="btn" data-group="${group.id}" data-card="${card.id}">${esc(card.btnLabel)}</button>`
    : `<span class="nk-hall-cardbtn nk-hall-cardbtn-empty"></span>`
  return `<div class="nk-hall-card" data-group="${group.id}" data-card="${card.id}">
    <button type="button" class="nk-hall-cardmain" data-act="card" data-group="${group.id}" data-card="${card.id}" aria-label="${esc(card.name)}">
      ${pic(cardImg(card), "nk-hall-portrait")}
      <span class="nk-hall-cardname">${esc(card.name)}</span>
      ${card.role ? `<span class="nk-hall-cardrole">${esc(card.role)}</span>` : ""}
    </button>
    ${btn}
    ${gm ? `<button type="button" class="nk-hall-edit" data-act="edit-card" data-group="${group.id}" data-card="${card.id}" data-tooltip="Изменить (можно перетащить сюда актёра, запись или таблицу)" aria-label="Изменить карточку"><i class="fa-solid fa-pen"></i></button>` : ""}
  </div>`
}

function groupHTML(group) {
  const gm = game.user.isGM
  return `<section class="nk-hall-panel">
    <h2 class="nk-hall-h">${esc(group.title)}</h2>
    <div class="nk-hall-cards">
      ${group.cards.map((c) => cardHTML(group, c)).join("")}
      ${gm ? `<button type="button" class="nk-hall-add" data-act="add-card" data-group="${group.id}"><i class="fa-solid fa-plus"></i> Карточка</button>` : ""}
    </div>
  </section>`
}

function bugHTML(actor, going) {
  const canToggle = game.user.isGM || actor.isOwner
  const owners = ownersOf(actor)
  const btn = canToggle
    ? `<button type="button" class="nk-hall-go ${going ? "is-going" : ""}" data-act="go" data-actor="${actor.id}" aria-pressed="${going}">${going ? "В отряде · отменить" : "В экспедицию"}</button>`
    : going
      ? `<span class="nk-hall-go is-going is-static">В отряде</span>`
      : ""
  return `<div class="nk-hall-bug ${going ? "is-going" : ""}">
    <button type="button" class="nk-hall-bugmain" data-act="sheet" data-actor="${actor.id}" aria-label="Лист персонажа: ${esc(actor.name)}">
      ${pic(DEFAULT_IMGS.has(actor.img) ? "" : actor.img, "nk-hall-bugimg")}
      <span class="nk-hall-bugtext">
        <span class="nk-hall-bugname">${esc(actor.name)}</span>
        ${owners ? `<span class="nk-hall-bugsub">${esc(owners)}</span>` : ""}
      </span>
    </button>
    ${btn}
  </div>`
}

function hallHTML(scene, hall) {
  const gm = game.user.isGM
  const tokens = expeditionTokens(scene)
  const going = new Set(tokens.map((t) => t.actorId))
  const bugs = partyActors()
  const news = (hall.news ?? []).filter((s) => s?.trim())
  const line = news.map((s) => `<span>${esc(s)}</span><span class="nk-hall-dot">◆</span>`).join("")
  return `
  <div class="nk-hall-top">
    <div class="nk-hall-title">
      <span class="nk-hall-sub">${esc(hall.subtitle ?? "")}</span>
      <span class="nk-hall-name">${esc(scene.navName || scene.name)}</span>
    </div>
    ${news.length ? `<div class="nk-hall-news"><span class="nk-hall-newslabel">Вести</span><div class="nk-hall-newsclip"><div class="nk-hall-newstrack">${line}${line}</div></div></div>` : ""}
    <div class="nk-hall-tools">
      ${gm ? `<button type="button" data-act="settings" data-tooltip="Настройки стола" aria-label="Настройки стола"><i class="fa-solid fa-gear"></i></button>` : ""}
      <button type="button" data-act="hide" data-tooltip="${hidden ? "Показать стол" : "Скрыть стол"}" aria-label="${hidden ? "Показать стол" : "Скрыть стол"}"><i class="fa-solid ${hidden ? "fa-eye" : "fa-eye-slash"}"></i></button>
    </div>
  </div>
  <aside class="nk-hall-left">${(hall.groups ?? []).map(groupHTML).join("")}</aside>
  <aside class="nk-hall-right nk-hall-panel">
    <div class="nk-hall-righthead">
      <h2 class="nk-hall-h">Жуки</h2>
      <span class="nk-hall-count">${tokens.length ? `в отряде: ${tokens.length}` : `${bugs.length} · клик — лист`}</span>
      ${gm && tokens.length ? `<button type="button" class="nk-hall-clear" data-act="clear">Распустить</button>` : ""}
    </div>
    <div class="nk-hall-gallery">
      ${bugs.length ? bugs.map((a) => bugHTML(a, going.has(a.id))).join("") : `<p class="nk-hall-empty">Нет Жуков с игроками-владельцами.</p>`}
    </div>
  </aside>`
}

function layout() {
  if (!root) return
  const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect()
  const W = window.innerWidth
  const H = window.innerHeight
  const controls = rect("#scene-controls")
  const nav = rect("#scene-navigation") ?? rect("#navigation")
  const sidebar = rect("#sidebar")
  const hotbar = rect("#hotbar")
  const players = rect("#players")
  const left = Math.round((controls?.right ?? 70) + 12)
  const top = Math.round(Math.max(nav?.bottom ?? 0, 8) + 10)
  const right = Math.round(W - (sidebar?.left ?? W) + 12)
  const bottomR = Math.round(H - Math.min(hotbar?.top ?? H, H) + 12)
  const bottomL = Math.round(H - Math.min(players?.top ?? H, hotbar?.top ?? H, H) + 12)
  const s = root.style
  s.setProperty("--nk-hall-left", `${left}px`)
  s.setProperty("--nk-hall-top", `${top}px`)
  s.setProperty("--nk-hall-right", `${right}px`)
  s.setProperty("--nk-hall-bottom-l", `${bottomL}px`)
  s.setProperty("--nk-hall-bottom-r", `${bottomR}px`)
}

export function renderHall() {
  const scene = canvas?.ready ? canvas.scene : null
  const hall = hallOf(scene)
  if (!hall) {
    root?.remove()
    root = null
    return
  }
  if (!root) {
    root = document.createElement("div")
    root.id = "nk-hall"
    const host = document.getElementById("interface") ?? document.body
    host.prepend(root)
    root.addEventListener("click", onClick)
    root.addEventListener("dragover", onDragOver)
    root.addEventListener("drop", onDrop)
  }
  // прокрутку галереи не сбрасываем при перерисовке
  const scroll = root.querySelector(".nk-hall-gallery")?.scrollTop ?? 0
  root.classList.toggle("is-hidden", hidden)
  root.innerHTML = hallHTML(scene, hall)
  const gal = root.querySelector(".nk-hall-gallery")
  if (gal) gal.scrollTop = scroll
  layout()
}

/* -------------------------------------------- */
/*  Клики                                       */
/* -------------------------------------------- */

function findCard(hall, groupId, cardId) {
  const group = hall.groups?.find((g) => g.id === groupId)
  return { group, card: group?.cards.find((c) => c.id === cardId) }
}

async function onClick(ev) {
  const el = ev.target.closest("[data-act]")
  if (!el || !root?.contains(el)) return
  ev.preventDefault()
  const scene = canvas.scene
  const hall = hallOf(scene)
  if (!hall) return
  const { act } = el.dataset
  const { group, card } = findCard(hall, el.dataset.group, el.dataset.card)
  switch (act) {
    case "card":
      return openDoc(card?.uuid)
    case "btn":
      return openDoc(card?.btnUuid || card?.uuid, { tableDraw: true })
    case "edit-card":
      return editCard(scene, group?.id, card?.id)
    case "add-card":
      return editCard(scene, group?.id, null)
    case "settings":
      return editSettings(scene)
    case "hide":
      hidden = !hidden
      return renderHall()
    case "sheet": {
      const actor = game.actors.get(el.dataset.actor)
      if (!actor) return
      if (!game.user.isGM && !actor.testUserPermission(game.user, "LIMITED")) {
        return ui.notifications.info(`${actor.name}: это чужой лист.`)
      }
      return actor.sheet.render(true)
    }
    case "go": {
      const actor = game.actors.get(el.dataset.actor)
      if (!actor) return
      const join = !expeditionTokens(scene).some((t) => t.actorId === actor.id)
      return hallRequest("party", { sceneId: scene.id, actorId: actor.id, join })
    }
    case "clear":
      return hallRequest("clear", { sceneId: scene.id })
  }
}

/* Мастер может бросить актёра, запись, страницу или таблицу прямо на карточку */
function dragData(ev) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor
  try {
    return TE.getDragEventData(ev)
  } catch {
    try {
      return JSON.parse(ev.dataTransfer.getData("text/plain"))
    } catch {
      return null
    }
  }
}

function onDragOver(ev) {
  if (game.user.isGM && ev.target.closest(".nk-hall-card")) ev.preventDefault()
}

async function onDrop(ev) {
  const cardEl = ev.target.closest(".nk-hall-card")
  if (!game.user.isGM || !cardEl) return
  ev.preventDefault()
  ev.stopPropagation()
  const data = dragData(ev)
  if (!data?.uuid) return ui.notifications.warn("Сюда можно перетащить актёра, запись журнала или таблицу.")
  const scene = canvas.scene
  const hall = foundry.utils.deepClone(hallOf(scene))
  const { card } = findCard(hall, cardEl.dataset.group, cardEl.dataset.card)
  if (!card) return
  const doc = await fromUuid(data.uuid)
  const onButton = !!ev.target.closest(".nk-hall-cardbtn")
  if (onButton) card.btnUuid = data.uuid
  else card.uuid = data.uuid
  if (doc?.documentName === "Actor" && isMerchant(doc)) {
    card.btnUuid ||= data.uuid
    card.btnLabel ||= "Лавка"
  }
  await saveHall(scene, hall)
  ui.notifications.info(`«${card.name}»: привязано — ${doc?.name ?? data.uuid}`)
}

/* -------------------------------------------- */
/*  Окна мастера                                */
/* -------------------------------------------- */

const field = (label, name, value, extra = "") =>
  `<div class="form-group"><label>${label}</label><div class="form-fields"><input type="text" name="${name}" value="${esc(value ?? "")}" ${extra}></div></div>`

async function editCard(scene, groupId, cardId) {
  const { DialogV2 } = foundry.applications.api
  const hall = foundry.utils.deepClone(hallOf(scene))
  const group = hall.groups.find((g) => g.id === groupId)
  if (!group) return
  const isNew = !cardId
  const card = isNew ? { id: rid(), name: "", role: "", img: "", uuid: "", btnLabel: "", btnUuid: "" } : group.cards.find((c) => c.id === cardId)
  if (!card) return

  const content = `<div class="nk-hall-form">
    ${field("Имя", "name", card.name, "autofocus")}
    ${field("Строка под именем", "role", card.role)}
    <div class="form-group"><label>Портрет</label><div class="form-fields">
      <input type="text" name="img" value="${esc(card.img)}" placeholder="пусто — картинка связанного документа">
      <button type="button" class="nk-hall-pick" data-tooltip="Выбрать файл"><i class="fa-solid fa-file-image"></i></button>
    </div></div>
    ${field("Клик по карточке открывает", "uuid", card.uuid, 'placeholder="UUID — или перетащите документ на карточку"')}
    ${field("Кнопка под карточкой", "btnLabel", card.btnLabel, 'placeholder="пусто — без кнопки"')}
    ${field("Кнопка открывает", "btnUuid", card.btnUuid, 'placeholder="UUID — пусто: то же, что карточка"')}
    <p class="hint">Торговец открывает окно лавки, таблицу мастер бросает, остальное открывается листом. UUID можно не вписывать: перетащите актёра, запись или таблицу из боковой панели прямо на карточку (на кнопку — чтобы привязать кнопку).</p>
  </div>`

  const buttons = [{ action: "save", label: "Сохранить", icon: "fa-solid fa-check", default: true }]
  if (!isNew) buttons.push({ action: "delete", label: "Удалить карточку", icon: "fa-solid fa-trash" })

  const result = await DialogV2.wait({
    window: { title: isNew ? `Новая карточка: ${group.title}` : `Карточка: ${card.name}` },
    position: { width: 520 },
    content,
    buttons: buttons.map((b) => ({
      ...b,
      callback: (event, button) => {
        if (b.action === "delete") return "delete"
        const f = button.form.elements
        return {
          name: f.name.value.trim(),
          role: f.role.value.trim(),
          img: f.img.value.trim(),
          uuid: f.uuid.value.trim(),
          btnLabel: f.btnLabel.value.trim(),
          btnUuid: f.btnUuid.value.trim(),
        }
      },
    })),
    render: (event, dialog) => {
      const el = dialog.element ?? dialog
      el.querySelector?.(".nk-hall-pick")?.addEventListener("click", () => {
        const input = el.querySelector('input[name="img"]')
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker
        new FP({ type: "image", current: input.value, callback: (path) => (input.value = path) }).render(true)
      })
    },
    rejectClose: false,
  })
  if (!result) return
  if (result === "delete") {
    group.cards = group.cards.filter((c) => c.id !== card.id)
  } else {
    Object.assign(card, result)
    if (!card.name) card.name = "Без имени"
    if (isNew) group.cards.push(card)
  }
  await saveHall(scene, hall)
}

async function editSettings(scene) {
  const { DialogV2 } = foundry.applications.api
  const hall = foundry.utils.deepClone(hallOf(scene))
  const area = { ...DEFAULT_AREA, ...(hall.area ?? {}) }
  const num = (name, label, v) =>
    `<label class="nk-hall-num">${label} <input type="number" name="${name}" value="${v}" min="0" max="100" step="1"></label>`
  const content = `<div class="nk-hall-form">
    ${field("Подзаголовок", "subtitle", hall.subtitle)}
    ${hall.groups.map((g, i) => field(`Группа ${i + 1}`, `group-${g.id}`, g.title)).join("")}
    ${field("Новая группа", "newGroup", "", 'placeholder="пусто — не добавлять"')}
    <div class="form-group stacked"><label>Вести — по строке на новость</label>
      <textarea name="news" rows="6">${esc((hall.news ?? []).join("\n"))}</textarea></div>
    <div class="form-group stacked"><label>Площадь сбора отряда, % от сцены</label>
      <div class="form-fields">${num("ax", "слева", area.x)}${num("ay", "сверху", area.y)}${num("aw", "ширина", area.w)}${num("ah", "высота", area.h)}</div>
      <p class="hint">Сюда встают жетоны «В экспедицию»: два ряда по шесть. Группу с пустым названием удаляет вместе с карточками.</p></div>
  </div>`
  const result = await DialogV2.prompt({
    window: { title: `Стол кампании: ${scene.name}` },
    position: { width: 560 },
    content,
    ok: {
      label: "Сохранить",
      icon: "fa-solid fa-check",
      callback: (event, button) => {
        const f = button.form.elements
        return {
          subtitle: f.subtitle.value.trim(),
          groups: hall.groups.map((g) => ({ id: g.id, title: f[`group-${g.id}`].value.trim() })),
          newGroup: f.newGroup.value.trim(),
          news: f.news.value.split("\n").map((s) => s.trim()).filter(Boolean),
          area: { x: +f.ax.value || 0, y: +f.ay.value || 0, w: +f.aw.value || DEFAULT_AREA.w, h: +f.ah.value || DEFAULT_AREA.h },
        }
      },
    },
    rejectClose: false,
  })
  if (!result) return
  hall.subtitle = result.subtitle
  hall.groups = hall.groups
    .map((g) => ({ ...g, title: result.groups.find((x) => x.id === g.id)?.title ?? g.title }))
    .filter((g) => g.title)
  if (result.newGroup) hall.groups.push({ id: rid(), title: result.newGroup, cards: [] })
  hall.news = result.news
  hall.area = result.area
  await saveHall(scene, hall)
}

/* -------------------------------------------- */
/*  Отряд: жетоны на площади (клиент мастера)   */
/* -------------------------------------------- */

function slotPosition(scene, hall, index, tokenDoc) {
  const area = { ...DEFAULT_AREA, ...(hall.area ?? {}) }
  const d = scene.dimensions
  const r = d.sceneRect ?? { x: d.sceneX, y: d.sceneY, width: d.sceneWidth, height: d.sceneHeight }
  const per = SLOTS_PER_ROW * ROWS
  const lap = Math.floor(index / per) // больше 12 — следующий круг чуть ниже
  const i = index % per
  const row = Math.floor(i / SLOTS_PER_ROW)
  const col = i % SLOTS_PER_ROW
  const fx = (area.x + area.w * ((col + 0.5 + row * 0.5) / (SLOTS_PER_ROW + 0.5))) / 100
  const fy = (area.y + area.h * (row ? 0.75 : 0.25)) / 100
  const w = (tokenDoc.width ?? 1) * d.size
  const h = (tokenDoc.height ?? 1) * d.size
  return {
    x: Math.round(r.x + fx * r.width - w / 2),
    y: Math.round(r.y + fy * r.height - h / 2 + lap * d.size * 0.35),
  }
}

const HANDLERS = {
  async party({ sceneId, actorId, join, userId }) {
    const scene = game.scenes.get(sceneId)
    const actor = game.actors.get(actorId)
    const user = game.users.get(userId)
    const hall = hallOf(scene)
    if (!scene || !actor || !user || !hall) return { error: "Не нашёл сцену или Жука." }
    if (!user.isGM && !actor.testUserPermission(user, "OWNER")) return { error: "Записать в отряд можно только своего Жука." }
    const mine = expeditionTokens(scene).filter((t) => t.actorId === actor.id)
    if (!join) {
      if (mine.length) await scene.deleteEmbeddedDocuments("Token", mine.map((t) => t.id))
      return { ok: true }
    }
    if (mine.length) return { ok: true }
    const taken = new Set(expeditionTokens(scene).map((t) => t.getFlag(MOD, "slot")))
    let slot = 0
    while (taken.has(slot)) slot++
    const td = await actor.getTokenDocument({}, { parent: scene })
    const pos = slotPosition(scene, hall, slot, td)
    const data = td.toObject()
    delete data._id
    Object.assign(data, pos, { hidden: false })
    data.flags ??= {}
    data.flags[MOD] = { ...(data.flags[MOD] ?? {}), expedition: true, slot }
    await scene.createEmbeddedDocuments("Token", [data])
    return { ok: true }
  },

  async clear({ sceneId, userId }) {
    const scene = game.scenes.get(sceneId)
    if (!scene || !game.users.get(userId)?.isGM) return { error: "Распустить отряд может только мастер." }
    const ids = expeditionTokens(scene).map((t) => t.id)
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids)
    return { ok: true }
  },
}

let queue = Promise.resolve()
const enqueue = (fn) => (queue = queue.then(fn, fn))
const fail = (err) => {
  console.error(`${MOD} | стол кампании`, err)
  return { error: "Не получилось — подробности в консоли мастера." }
}

async function hallRequest(kind, payload) {
  payload.userId = game.user.id
  if (game.user.isGM) {
    const res = await enqueue(() => HANDLERS[kind](payload).catch(fail))
    if (res?.error) ui.notifications.warn(res.error)
    return
  }
  if (!game.users.activeGM) return ui.notifications.warn("Отряд собирает мастер — его сейчас нет в игре.")
  game.socket.emit(SOCKET, { action: `hall:${kind}`, payload })
}

export function handleHallSocket(msg) {
  if (!msg?.action?.startsWith("hall:") || game.user !== game.users.activeGM) return false
  const handler = HANDLERS[msg.action.slice(5)]
  if (!handler) return true
  enqueue(async () => {
    const res = await handler(msg.payload).catch(fail)
    if (res?.error) game.socket.emit(SOCKET, { action: "nk-notify", userId: msg.payload?.userId, text: res.error })
  })
  return true
}

/* -------------------------------------------- */
/*  Включение на сцене                          */
/* -------------------------------------------- */

export async function toggleHall(scene) {
  if (!game.user.isGM || !scene) return
  const cur = scene.getFlag(MOD, "hall")
  if (cur?.enabled) return scene.update({ [`flags.${MOD}.hall.enabled`]: false })
  if (cur) return scene.update({ [`flags.${MOD}.hall.enabled`]: true })
  return scene.update({ [`flags.${MOD}.hall`]: defaultHall() })
}

function sceneFromLi(li) {
  const el = li instanceof HTMLElement ? li : li?.[0]
  const id = el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.dataset?.sceneId
  return id ? game.scenes.get(id) : null
}

function addSceneOptions(app, options) {
  if (!Array.isArray(options) || options.some((o) => o?.nkHall)) return
  options.push({
    nkHall: true,
    name: "Стол кампании: вкл / выкл",
    icon: '<i class="fa-solid fa-chess-rook"></i>',
    condition: () => game.user.isGM,
    callback: (li) => toggleHall(sceneFromLi(li)),
  })
}

/* -------------------------------------------- */
/*  Инициализация                               */
/* -------------------------------------------- */

export function initHall() {
  const mod = game.modules.get(MOD)
  if (mod) {
    mod.api ??= {}
    mod.api.hall = {
      toggle: (ref) => toggleHall(typeof ref === "string" ? game.scenes.get(ref) ?? game.scenes.getName(ref) : ref ?? canvas.scene),
      render: renderHall,
    }
  }

  Hooks.on("getSceneContextOptions", addSceneOptions)
  Hooks.on("getSceneDirectoryEntryContext", addSceneOptions)
  Hooks.on("getSceneNavigationContext", addSceneOptions)

  Hooks.on("canvasReady", () => renderHall())
  Hooks.on("updateScene", (scene) => scene.id === canvas.scene?.id && queueRender())
  for (const h of ["createToken", "deleteToken"]) Hooks.on(h, (t) => t.parent?.id === canvas.scene?.id && queueRender())
  for (const h of ["createActor", "updateActor", "deleteActor"]) Hooks.on(h, () => root && queueRender())
  for (const h of ["updateJournalEntry", "updateRollTable", "updateUser"]) Hooks.on(h, () => root && queueRender())

  const relayout = () => root && requestAnimationFrame(layout)
  window.addEventListener("resize", relayout)
  Hooks.on("collapseSidebar", relayout)
  Hooks.on("changeSidebarTab", relayout)
  Hooks.on("renderPlayers", relayout)
  Hooks.on("renderSceneNavigation", relayout)
  Hooks.on("renderHotbar", relayout)
  try {
    const ro = new ResizeObserver(relayout)
    for (const sel of ["#sidebar", "#players", "#hotbar", "#scene-controls", "#scene-navigation", "#navigation"]) {
      const el = document.querySelector(sel)
      if (el) ro.observe(el)
    }
  } catch {}

  if (canvas?.ready) renderHall()
}

/** Для проверок вне Foundry */
export const _internals = { defaultHall, hallHTML, slotPosition, HANDLERS }
