/**
 * Торговцы и лавки.
 *
 * Торговец — любой персонаж с флагом merchant.enabled. Его инвентарь — ассортимент.
 * У товара: цена, цена продажи (по умолчанию половина), раздел, запас (пусто — без ограничений),
 * «только мастер». У торговца: сколько тратит за визит на всю партию и порог мелочи
 * (не покупает то, за что заплатил бы меньше N янтаря).
 *
 * Все сделки выполняет клиент мастера (через сокет), по очереди.
 */

import {
  MOD, SOCKET, esc, flag, numFlag, normName,
  isEquipment, isAmulet, isSeal, isArtifact, qtyOf, subTypeOf, placeOf, PLACES,
  isOurCharacter, isMerchant, amberOf, amberSlots, slotsForNew, computeLoad,
  addToActor, removeFromItem, sameThing,
} from "./common.mjs"

const DEFAULT_WALLET = 1000
const DEFAULT_MIN_SELL = 5
const SHOP_KEYS = ["price", "resale", "section", "stock", "gmOnly"]
const SECTION_ORDER = ["Свет", "Снаряжение", "Оружие", "Броня", "Печати", "Амулеты", "Артефакты"]
const ALL = "__all"

/* -------------------------------------------- */
/*  Данные торговца и товара                    */
/* -------------------------------------------- */

export const walletOf = (m) => numFlag(m, "merchant.wallet") ?? DEFAULT_WALLET
export const minSellOf = (m) => numFlag(m, "merchant.minSell") ?? DEFAULT_MIN_SELL

export function shopState(m) {
  return {
    open: !!flag(m, "shop.open", false),
    spent: numFlag(m, "shop.spent") ?? 0,
    visit: flag(m, "shop.visit", null),
  }
}
const remainingOf = (m) => Math.max(walletOf(m) - shopState(m).spent, 0)

export const priceOf = (i) => numFlag(i, "price")
export function resaleOf(i) {
  const r = numFlag(i, "resale")
  if (r !== null) return r
  const p = priceOf(i)
  return p === null ? null : Math.floor(p / 2)
}
export const stockOf = (i) => {
  const s = numFlag(i, "stock")
  return s === null ? null : Math.max(Math.floor(s), 0)
}
export const gmOnlyOf = (i) => flag(i, "gmOnly", null) ?? isArtifact(i)

export function defaultSection(i) {
  if (isSeal(i)) return "Печати"
  if (isAmulet(i)) return "Амулеты"
  if (isArtifact(i)) return "Артефакты"
  if (subTypeOf(i) === "weapon") return "Оружие"
  if (subTypeOf(i) === "armour") return "Броня"
  return "Снаряжение"
}
export const sectionOf = (i) => String(flag(i, "section", "") || "").trim() || defaultSection(i)

function sortSections(list) {
  const uniq = [...new Set(list)]
  return uniq.sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a)
    const ib = SECTION_ORDER.indexOf(b)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return a.localeCompare(b, "ru")
  })
}

/** Товары, которые видит пользователь */
function goodsOf(merchant, gm) {
  return merchant.items.filter((i) => isEquipment(i) && (gm || (priceOf(i) !== null && !gmOnlyOf(i))))
}

/** «Двойник» вещи Жука в ассортименте торговца */
export function findTwin(merchant, item) {
  return merchant.items.find((i) => isEquipment(i) && priceOf(i) !== null && sameThing(i, item)) ?? null
}

/** Копия товара без полей лавки — то, что ляжет Жуку в мешок */
function cleanShopData(item) {
  const data = item.toObject()
  delete data._id
  const f = data.flags?.[MOD]
  if (f) for (const k of SHOP_KEYS) delete f[k]
  return data
}

const kindTags = (i) =>
  [
    isAmulet(i) && `<span class="nk-tag nk-kind nk-kind-amulet">амулет</span>`,
    isSeal(i) && `<span class="nk-tag nk-kind nk-kind-seal">печать</span>`,
    isArtifact(i) && `<span class="nk-tag nk-kind nk-kind-artifact">артефакт</span>`,
  ]
    .filter(Boolean)
    .join("")

/* -------------------------------------------- */
/*  Лист торговца (видит мастер)                */
/* -------------------------------------------- */

export function merchantBlockHTML(actor) {
  const st = shopState(actor)
  const status = st.open
    ? `Лавка открыта · куплено у Жуков на ${st.spent} из ${walletOf(actor)} я`
    : "Лавка закрыта"
  return `<fieldset class="nk-merchant">
    <legend>Торговец · видит только мастер</legend>
    <div class="nk-merchant-head">
      <span class="nk-merchant-status ${st.open ? "nk-open" : ""}">${status}</span>
      <button type="button" class="nk-shop-toggle">
        <i class="fa-solid fa-store"></i> ${st.open ? "Закрыть лавку" : "Открыть лавку"}</button>
    </div>
    <div class="nk-merchant-grid">
      <label>Торговец</label>
      <input type="checkbox" name="flags.${MOD}.merchant.enabled" checked>
      <label>Тратит за визит</label>
      <span class="nk-pair"><input type="number" name="flags.${MOD}.merchant.wallet" value="${walletOf(actor)}" min="0" step="1"> я, на всю партию</span>
      <label>Не берёт дешевле</label>
      <span class="nk-pair"><input type="number" name="flags.${MOD}.merchant.minSell" value="${minSellOf(actor)}" min="0" step="1"> я, по цене продажи</span>
    </div>
    <p class="hint">Ниже — ассортимент. Цена, продажа, раздел и запас — на листе каждого товара.
      Лавку можно открыть и правым кликом по торговцу в списке актёров, кнопкой в меню токена
      или макросом: перетащите торговца на панель макросов.</p>
  </fieldset>`
}

export function bindMerchantBlock(el, actor) {
  el?.querySelector(".nk-shop-toggle")?.addEventListener("click", (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    toggleShop(actor)
  })
}

/** Бирки товара в инвентаре торговца */
export function merchantRowTags(item) {
  if (!game.user.isGM) return []
  const tags = []
  const price = priceOf(item)
  if (price === null) tags.push(`<span class="item-info nk-tag nk-tag-bad">цена не задана</span>`)
  else tags.push(`<span class="item-info nk-tag nk-price">${price} я · продажа ${resaleOf(item)}</span>`)
  tags.push(`<span class="item-info nk-tag nk-muted">${esc(sectionOf(item))}</span>`)
  const stock = stockOf(item)
  if (stock === 0) tags.push(`<span class="item-info nk-tag nk-tag-bad">нет в наличии</span>`)
  else if (stock !== null) tags.push(`<span class="item-info nk-tag nk-muted">запас ${stock}</span>`)
  if (gmOnlyOf(item)) tags.push(`<span class="item-info nk-tag nk-muted"><i class="fa-solid fa-eye-slash"></i> только мастер</span>`)
  return tags
}

/** Поля лавки на листе товара торговца */
export function shopItemFieldsHTML(item, dis) {
  const merchant = item.parent
  if (!game.user.isGM || !isMerchant(merchant)) return ""
  const listId = `nk-sections-${item.id}`
  const sections = sortSections([...SECTION_ORDER, ...merchant.items.filter(isEquipment).map(sectionOf)])
  const price = priceOf(item)
  const resaleSet = numFlag(item, "resale")
  return `<fieldset class="nk-shop-fields">
    <legend>Лавка · видит только мастер</legend>
    <div class="form-group">
      <label>Цена</label>
      <div class="form-fields nk-pair"><input type="number" name="flags.${MOD}.price" value="${price ?? ""}" min="0" step="1" placeholder="не задана" ${dis}> я</div>
      <p class="hint">Без цены товар видит только мастер.</p>
    </div>
    <div class="form-group">
      <label>Продажа</label>
      <div class="form-fields nk-pair"><input type="number" name="flags.${MOD}.resale" value="${resaleSet ?? ""}" min="0" step="1"
        placeholder="${price === null ? "половина цены" : Math.floor(price / 2)}" ${dis}> я</div>
      <p class="hint">Сколько торговец платит Жуку за такую вещь. Пусто — половина цены.</p>
    </div>
    <div class="form-group">
      <label>Раздел</label>
      <div class="form-fields"><input type="text" name="flags.${MOD}.section" value="${esc(flag(item, "section", ""))}"
        placeholder="${esc(defaultSection(item))}" list="${listId}" ${dis}>
        <datalist id="${listId}">${sections.map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist></div>
    </div>
    <div class="form-group">
      <label>В наличии</label>
      <div class="form-fields"><input type="number" name="flags.${MOD}.stock" value="${stockOf(item) ?? ""}" min="0" step="1" placeholder="без ограничений" ${dis}></div>
    </div>
    <div class="form-group">
      <label>Только мастер</label>
      <div class="form-fields"><input type="checkbox" name="flags.${MOD}.gmOnly" ${gmOnlyOf(item) ? "checked" : ""} ${dis}></div>
      <p class="hint">Игроки не видят товар в лавке. Мастер может выдать его кнопкой «Выдать».</p>
    </div>
  </fieldset>`
}

/* -------------------------------------------- */
/*  Открыть / закрыть                           */
/* -------------------------------------------- */

export async function toggleShop(actor) {
  if (!game.user.isGM) return ui.notifications.warn("Открывать и закрывать лавку может только мастер.")
  if (!isMerchant(actor)) return ui.notifications.warn(`${actor?.name ?? "Этот актёр"} — не торговец.`)
  const st = shopState(actor)
  if (st.open) {
    await actor.update({ [`flags.${MOD}.shop.open`]: false })
    await ChatMessage.create({
      speaker: { alias: actor.name },
      content: `<div class="nk-card nk-shop-card nk-closed"><div class="nk-card-title">Лавка закрыта: ${esc(actor.name)}</div></div>`,
    })
  } else {
    await actor.update({ [`flags.${MOD}.shop`]: { open: true, spent: 0, visit: foundry.utils.randomID() } })
    await ChatMessage.create({
      speaker: { alias: actor.name },
      content: `<div class="nk-card nk-shop-card">
        <img src="${esc(actor.img)}" alt="">
        <div>
          <div class="nk-card-title">Лавка открыта: ${esc(actor.name)}</div>
          <button type="button" data-nk-action="enter" data-merchant="${actor.uuid}"><i class="fa-solid fa-store"></i> Зайти в лавку</button>
        </div>
      </div>`,
    })
  }
}

const APPS = new Map()

export function openShopWindow(merchant) {
  if (!isMerchant(merchant)) return
  if (!game.user.isGM && !shopState(merchant).open) {
    return ui.notifications.info(`${merchant.name}: лавка закрыта.`)
  }
  let app = APPS.get(merchant.id)
  if (!app) {
    app = new ShopApp(merchant)
    APPS.set(merchant.id, app)
  }
  app.render({ force: true })
  return app
}

/* -------------------------------------------- */
/*  Окно лавки                                  */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api

class ShopApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["nk-shop-app"],
    tag: "div",
    window: { icon: "fa-solid fa-store", resizable: true, title: "Лавка" },
    position: { width: 580, height: 680 },
    actions: {
      mode: ShopApp.#onMode,
      section: ShopApp.#onSection,
      toggle: ShopApp.#onToggle,
      buy: ShopApp.#onBuy,
      sell: ShopApp.#onSell,
      give: ShopApp.#onGive,
    },
  }

  constructor(merchant, options = {}) {
    super({ ...options, id: `nk-shop-${merchant.id}` })
    this.merchant = merchant
    this.mode = "buy"
    this.section = ALL
    this.buyerId = null
    this.expanded = new Set()
  }

  get title() {
    return `Лавка: ${this.merchant.name}`
  }

  /** Кем можно покупать */
  get buyers() {
    const chars = game.actors.filter((a) => isOurCharacter(a) && !isMerchant(a))
    if (!game.user.isGM) return chars.filter((a) => a.isOwner)
    const played = chars.filter((a) => a.hasPlayerOwner)
    return played.length ? played : chars
  }

  get buyer() {
    const list = this.buyers
    let b = list.find((a) => a.id === this.buyerId)
    if (!b) b = list.find((a) => a.id === game.user.character?.id) ?? list[0] ?? null
    this.buyerId = b?.id ?? null
    return b
  }

  async _prepareContext() {
    const merchant = this.merchant
    const gm = game.user.isGM
    const buyer = this.buyer
    const L = buyer ? computeLoad(buyer) : null
    const minSell = minSellOf(merchant)
    const remaining = remainingOf(merchant)
    const enrich = (i) =>
      foundry.applications.ux.TextEditor.implementation.enrichHTML(i.system.description ?? "", { relativeTo: i })

    const goods = goodsOf(merchant, gm)
    const sections = sortSections(goods.map(sectionOf))
    if (this.section !== ALL && !sections.includes(this.section)) this.section = ALL
    const inSection = (sec) => this.section === ALL || sec === this.section

    let rows = []
    if (this.mode === "buy") {
      const list = goods.filter((i) => inSection(sectionOf(i)))
      list.sort(
        (a, b) => sections.indexOf(sectionOf(a)) - sections.indexOf(sectionOf(b)) || a.name.localeCompare(b.name, "ru")
      )
      for (const i of list) {
        const price = priceOf(i)
        const stock = stockOf(i)
        rows.push({
          id: i.id,
          name: i.name,
          kinds: kindTags(i),
          slots: slotsForNew(i, 1),
          price,
          stock,
          hidden: gmOnlyOf(i) || price === null,
          canBuy: price !== null && stock !== 0 && !!buyer && (!gmOnlyOf(i) || gm),
          desc: this.expanded.has(i.id) ? await enrich(i) : null,
        })
      }
    } else if (buyer) {
      for (const i of buyer.items.filter(isEquipment)) {
        const twin = findTwin(merchant, i)
        const visibleTwin = twin && (gm || !gmOnlyOf(twin))
        const sec = visibleTwin ? sectionOf(twin) : null
        if (this.section !== ALL && sec !== this.section) continue
        const resale = visibleTwin ? resaleOf(twin) : null
        let reason = null
        if (!visibleTwin) reason = `${merchant.name} не берёт`
        else if (resale < minSell) reason = `мелочь, дешевле ${minSell} я`
        else if (resale > remaining) reason = "не хватит кошелька торговца"
        rows.push({
          id: i.id,
          name: i.name + (qtyOf(i) > 1 ? ` ×${qtyOf(i)}` : ""),
          kinds: kindTags(i),
          place: PLACES[placeOf(i)]?.label,
          resale,
          reason,
          desc: this.expanded.has(i.id) ? await enrich(i) : null,
        })
      }
      rows.sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || a.name.localeCompare(b.name, "ru"))
    }

    return {
      gm,
      merchant,
      open: shopState(merchant).open,
      buyers: this.buyers,
      buyer,
      L,
      mode: this.mode,
      sections,
      section: this.section,
      rows,
      remaining,
      wallet: walletOf(merchant),
    }
  }

  async _renderHTML(ctx) {
    const { gm, buyer, L } = ctx
    const buyerSelect = ctx.buyers.length
      ? `<label class="nk-buyer">${ctx.mode === "buy" ? "Покупает" : "Продаёт"}
          <select name="nk-buyer">${ctx.buyers
            .map((a) => `<option value="${a.id}" ${a.id === buyer?.id ? "selected" : ""}>${esc(a.name)}</option>`)
            .join("")}</select></label>`
      : `<span class="nk-muted">Нет Жука, за которого можно торговать</span>`

    const stats = L
      ? `<span class="nk-chip"><i class="fa-solid fa-coins"></i> янтарь <b>${L.amber}</b></span>
         <span class="nk-chip nk-slot-chip ${L.overloaded ? "nk-bad" : ""}">ячейки ${L.packSlots}/${L.capacity}</span>`
      : ""

    const tab = (sec, label) =>
      `<a class="nk-sec ${ctx.section === sec ? "active" : ""}" data-action="section" data-section="${esc(sec)}">${esc(label)}</a>`

    const closedNote = !ctx.open && gm ? `<div class="nk-shop-note">Лавка закрыта — игроки сюда не попадут. Мастер может торговать за Жуков.</div>` : ""

    let list
    if (ctx.mode === "buy") {
      list = ctx.rows.length
        ? ctx.rows
            .map((r) => {
              const stock = r.stock === 0 ? `<span class="nk-muted">нет в наличии</span>` : r.stock !== null ? `<span class="nk-muted">осталось ${r.stock}</span>` : ""
              const price = r.price === null ? `<span class="nk-tag-bad">цена не задана</span>` : `${r.price} я`
              const btn = r.canBuy
                ? `<button type="button" data-action="buy" data-item-id="${r.id}">Купить</button>`
                : r.price === null ? "" : `<button type="button" disabled>Купить</button>`
              const give = gm && r.hidden && buyer ? `<button type="button" data-action="give" data-item-id="${r.id}">Выдать</button>` : ""
              return `<div class="nk-row ${r.hidden ? "nk-row-gm" : ""}">
                <div class="nk-row-main">
                  <a class="nk-row-name" data-action="toggle" data-item-id="${r.id}">${esc(r.name)}</a>
                  ${r.kinds}
                  ${r.hidden ? `<i class="fa-solid fa-eye-slash nk-muted" data-tooltip="Игроки этот товар не видят"></i>` : ""}
                  ${stock}
                  <span class="nk-grow"></span>
                  <span class="nk-slot">${r.slots} яч.</span>
                  <span class="nk-price">${price}</span>
                  ${give}${btn}
                </div>
                ${r.desc !== null ? `<div class="nk-row-desc">${r.desc || "<i>Без описания.</i>"}</div>` : ""}
              </div>`
            })
            .join("")
        : `<div class="nk-empty-list">В этом разделе пусто.</div>`
    } else {
      list = !buyer
        ? ""
        : ctx.rows.length
          ? ctx.rows
              .map((r) => `<div class="nk-row ${r.reason ? "nk-row-off" : ""}">
                <div class="nk-row-main">
                  <a class="nk-row-name" data-action="toggle" data-item-id="${r.id}">${esc(r.name)}</a>
                  ${r.kinds}
                  <span class="nk-muted nk-place">${esc(r.place ?? "")}</span>
                  <span class="nk-grow"></span>
                  ${r.reason
                    ? `<span class="nk-muted">${esc(r.reason)}</span>`
                    : `<span class="nk-price">${r.resale} я</span><button type="button" data-action="sell" data-item-id="${r.id}">Продать</button>`}
                </div>
                ${r.desc !== null ? `<div class="nk-row-desc">${r.desc || "<i>Без описания.</i>"}</div>` : ""}
              </div>`)
              .join("")
          : `<div class="nk-empty-list">Здесь нечего продать.</div>`
    }

    const wallet = ctx.mode === "sell"
      ? `<div class="nk-wallet">${esc(ctx.merchant.name)} готов потратить ещё <b>${ctx.remaining}</b> из ${ctx.wallet} я</div>`
      : ""

    return `<div class="nk-shop">
      <div class="nk-shop-top">${buyerSelect}<span class="nk-grow"></span>${stats}</div>
      ${closedNote}
      <div class="nk-shop-modes">
        <a class="nk-mode ${ctx.mode === "buy" ? "active" : ""}" data-action="mode" data-mode="buy">Купить</a>
        <a class="nk-mode ${ctx.mode === "sell" ? "active" : ""}" data-action="mode" data-mode="sell">Продать</a>
        <span class="nk-grow"></span>
        ${wallet}
      </div>
      <nav class="nk-secs">${tab(ALL, "Всё")}${ctx.sections.map((s) => tab(s, s)).join("")}</nav>
      <div class="nk-list">${list}</div>
    </div>`
  }

  _replaceHTML(result, content) {
    content.innerHTML = result
    content.querySelector('select[name="nk-buyer"]')?.addEventListener("change", (ev) => {
      this.buyerId = ev.target.value
      this.render()
    })
  }

  _onClose(options) {
    super._onClose?.(options)
    APPS.delete(this.merchant.id)
  }

  static #onMode(event, target) {
    this.mode = target.dataset.mode === "sell" ? "sell" : "buy"
    this.expanded.clear()
    this.render()
  }

  static #onSection(event, target) {
    this.section = target.dataset.section ?? ALL
    this.render()
  }

  static #onToggle(event, target) {
    const id = target.dataset.itemId
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.render()
  }

  static #onBuy(event, target) {
    buyFlow(this, target.dataset.itemId)
  }

  static #onSell(event, target) {
    sellFlow(this, target.dataset.itemId)
  }

  static #onGive(event, target) {
    giveFlow(this, target.dataset.itemId)
  }
}

/* -------------------------------------------- */
/*  Окошки подтверждения                        */
/* -------------------------------------------- */

const line = (label, field, cls = "") => `<div class="nk-line"><span>${label}</span><b data-f="${field}" class="${cls}"></b></div>`

async function confirmDeal({ title, max, lines, update, okLabel }) {
  const { DialogV2 } = foundry.applications.api
  const content = `<div class="nk-deal-form">
    <div class="nk-line"><span>Сколько</span><input type="number" name="qty" value="1" min="1" max="${max}" step="1"></div>
    ${lines}
    <div class="nk-line-warn" data-f="warn"></div>
  </div>`
  const result = await DialogV2.wait({
    window: { title },
    content,
    buttons: [
      { action: "ok", label: okLabel, icon: "fa-solid fa-coins", default: true, callback: (ev, btn) => btn.form.elements.qty.valueAsNumber },
      { action: "cancel", label: "Отмена" },
    ],
    render: (event, dialog) => {
      const root = dialog.element
      const input = root.querySelector('[name="qty"]')
      const ok = root.querySelector('button[data-action="ok"]')
      const set = (f, text, cls) => {
        const el = root.querySelector(`[data-f="${f}"]`)
        if (!el) return
        el.textContent = text
        if (cls !== undefined) el.classList.toggle("nk-bad", !!cls)
      }
      const refresh = () => {
        const n = Math.clamp(Math.floor(Number(input.value)) || 1, 1, max)
        const r = update(n, set)
        if (ok) {
          ok.disabled = !!r.block
          const lbl = ok.querySelector("span") ?? ok
          if (lbl === ok) ok.textContent = r.label
          else lbl.textContent = r.label
        }
      }
      input?.addEventListener("input", refresh)
      refresh()
    },
    rejectClose: false,
  })
  const n = Number(result)
  return Number.isFinite(n) && n >= 1 ? Math.clamp(Math.floor(n), 1, max) : null
}

async function buyFlow(app, itemId) {
  const merchant = app.merchant
  const item = merchant.items.get(itemId)
  const buyer = app.buyer
  if (!item || !buyer) return ui.notifications.warn("Не выбран Жук-покупатель.")
  const price = priceOf(item)
  if (price === null) return
  const stock = stockOf(item)
  const max = stock ?? 99
  if (max < 1) return ui.notifications.warn("Нет в наличии.")
  const L = computeLoad(buyer)

  const qty = await confirmDeal({
    title: `Купить: ${item.name}`,
    max,
    okLabel: "Купить",
    lines: line("Цена", "cost") + line("Янтарь", "amber") + line("Ячейки", "slots", "nk-slot"),
    update: (n, set) => {
      const cost = price * n
      const after = L.amber - cost
      const slots = L.packSlots - L.amberSlots + amberSlots(after) + slotsForNew(item, n)
      set("cost", `${cost} я`)
      set("amber", `${L.amber} → ${after}`, after < 0)
      set("slots", `${L.packSlots}/${L.capacity} → ${slots}/${L.capacity}`)
      if (after < 0) {
        set("warn", "")
        return { block: true, label: `Не хватает ${-after} я` }
      }
      set("warn", slots > L.capacity ? "Перегруз: отряд движется вдвое медленнее." : "")
      return { block: false, label: `Купить за ${cost} я` }
    },
  })
  if (!qty) return
  await shopRequest("buy", { merchantUuid: merchant.uuid, itemId, buyerUuid: buyer.uuid, qty })
}

async function sellFlow(app, itemId) {
  const merchant = app.merchant
  const seller = app.buyer
  const item = seller?.items.get(itemId)
  if (!item) return
  const twin = findTwin(merchant, item)
  if (!twin) return
  const resale = resaleOf(twin)
  const have = qtyOf(item)
  const remaining = remainingOf(merchant)
  const L = computeLoad(seller)

  const qty = await confirmDeal({
    title: `Продать: ${item.name}`,
    max: have,
    okLabel: "Продать",
    lines: line("Получите", "total") + line("Янтарь", "amber") + line(`${esc(merchant.name)} потратит ещё`, "wallet"),
    update: (n, set) => {
      const total = resale * n
      set("total", `${total} я`)
      set("amber", `${L.amber} → ${L.amber + total}`)
      set("wallet", `${remaining} → ${remaining - total} я`, total > remaining)
      if (total > remaining) {
        set("warn", "")
        return { block: true, label: "Кошелёк торговца пуст" }
      }
      set("warn", "")
      return { block: false, label: `Продать за ${total} я` }
    },
  })
  if (!qty) return
  await shopRequest("sell", { merchantUuid: merchant.uuid, itemId, sellerUuid: seller.uuid, qty })
}

async function giveFlow(app, itemId) {
  if (!game.user.isGM) return
  const merchant = app.merchant
  const item = merchant.items.get(itemId)
  const buyer = app.buyer
  if (!item || !buyer) return
  const stock = stockOf(item)
  const max = stock ?? 99
  if (max < 1) return ui.notifications.warn("Нет в наличии.")
  const qty = await confirmDeal({
    title: `Выдать: ${item.name} → ${buyer.name}`,
    max,
    okLabel: "Выдать",
    lines: "",
    update: (n) => ({ block: false, label: `Выдать ×${n}` }),
  })
  if (!qty) return
  await shopRequest("give", { merchantUuid: merchant.uuid, itemId, buyerUuid: buyer.uuid, qty })
}

/* -------------------------------------------- */
/*  Сделки (клиент мастера)                     */
/* -------------------------------------------- */

let queue = Promise.resolve()
const enqueue = (fn) => (queue = queue.then(fn, fn))

async function shopRequest(kind, payload) {
  payload.userId = game.user.id
  if (game.user.isGM) {
    const res = await enqueue(() => HANDLERS[kind](payload).catch((err) => fail(err)))
    if (res?.error) ui.notifications.warn(res.error)
    return
  }
  if (!game.users.activeGM) return ui.notifications.warn("Торговец отлучился: мастер не в игре.")
  game.socket.emit(SOCKET, { action: `shop:${kind}`, payload })
}

function fail(err) {
  console.error(`${MOD} | сделка`, err)
  return { error: "Сделка сорвалась — подробности в консоли мастера." }
}

export function handleShopSocket(msg) {
  if (!msg?.action) return
  if (msg.action === "nk-notify") {
    if (msg.userId === game.user.id) ui.notifications[msg.level ?? "warn"](msg.text)
    return
  }
  if (!msg.action.startsWith("shop:") || game.user !== game.users.activeGM) return
  const kind = msg.action.slice(5)
  const handler = HANDLERS[kind]
  if (!handler) return
  enqueue(async () => {
    const res = await handler(msg.payload).catch((err) => fail(err))
    if (res?.error) game.socket.emit(SOCKET, { action: "nk-notify", userId: msg.payload?.userId, text: res.error })
  })
}

async function participants({ merchantUuid, buyerUuid, sellerUuid, userId }) {
  const merchant = await fromUuid(merchantUuid)
  const actor = await fromUuid(buyerUuid ?? sellerUuid)
  const user = game.users.get(userId)
  if (!merchant || !actor || !user) return { error: "Сделка не удалась: не нашёл участников." }
  if (!isMerchant(merchant)) return { error: `${merchant.name} больше не торгует.` }
  if (!user.isGM && !shopState(merchant).open) return { error: `${merchant.name}: лавка закрыта.` }
  if (!isOurCharacter(actor) || isMerchant(actor)) return { error: "Торговать можно только за Жука." }
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) return { error: "Торговать можно только за своего Жука." }
  return { merchant, actor, user }
}

const HANDLERS = {
  async buy(p) {
    const P = await participants(p)
    if (P.error) return P
    const { merchant, actor: buyer, user } = P
    const item = merchant.items.get(p.itemId)
    if (!item) return { error: "Этого товара уже нет." }
    const price = priceOf(item)
    if (price === null) return { error: "У товара не задана цена." }
    if (gmOnlyOf(item) && !user.isGM) return { error: "Этот товар не продаётся." }
    const stock = stockOf(item)
    if (stock === 0) return { error: "Нет в наличии." }
    const n = Math.clamp(Math.floor(Number(p.qty)) || 1, 1, stock ?? 999)
    const cost = price * n
    const amber = amberOf(buyer)
    if (cost > amber) return { error: `Не хватает ${cost - amber} я.` }

    await buyer.update({ "system.wealth.pennies": amber - cost })
    const added = await addToActor(buyer, cleanShopData(item), n, (i) => sameThing(i, item))
    if (stock !== null) await item.update({ [`flags.${MOD}.stock`]: stock - n })

    const L = computeLoad(buyer)
    await postDeal(buyer, {
      type: "buy",
      merchantUuid: merchant.uuid,
      merchantName: merchant.name,
      actorUuid: buyer.uuid,
      actorName: buyer.name,
      name: item.name,
      qty: n,
      amount: cost,
      amberBefore: amber,
      amberAfter: amber - cost,
      overloaded: L.overloaded,
      targetItemId: added.id,
      merchItemId: item.id,
      stockTracked: stock !== null,
    })
    return { ok: true }
  },

  async sell(p) {
    const P = await participants(p)
    if (P.error) return P
    const { merchant, actor: seller, user } = P
    const item = seller.items.get(p.itemId)
    if (!item || !isEquipment(item)) return { error: "Этой вещи уже нет." }
    const twin = findTwin(merchant, item)
    if (!twin || (gmOnlyOf(twin) && !user.isGM)) return { error: `${merchant.name} такое не берёт.` }
    const resale = resaleOf(twin)
    const minSell = minSellOf(merchant)
    if (resale < minSell) return { error: `${merchant.name} не берёт мелочь дешевле ${minSell} я.` }
    const have = qtyOf(item)
    const n = Math.clamp(Math.floor(Number(p.qty)) || 1, 1, have)
    const total = resale * n
    const remaining = remainingOf(merchant)
    if (total > remaining) return { error: `${merchant.name} готов потратить ещё только ${remaining} я.` }

    const snapshot = item.toObject()
    delete snapshot._id
    snapshot.system.quantity = n
    const amber = amberOf(seller)
    const st = shopState(merchant)
    const stock = stockOf(twin)

    await seller.update({ "system.wealth.pennies": amber + total })
    await removeFromItem(item, n)
    if (stock !== null) await twin.update({ [`flags.${MOD}.stock`]: stock + n })
    await merchant.update({ [`flags.${MOD}.shop.spent`]: st.spent + total })

    await postDeal(seller, {
      type: "sell",
      merchantUuid: merchant.uuid,
      merchantName: merchant.name,
      actorUuid: seller.uuid,
      actorName: seller.name,
      name: item.name,
      qty: n,
      amount: total,
      amberBefore: amber,
      amberAfter: amber + total,
      sourceItemId: item.id,
      snapshot,
      merchItemId: twin.id,
      stockTracked: stock !== null,
      visit: st.visit,
    })
    return { ok: true }
  },

  async give(p) {
    const P = await participants(p)
    if (P.error) return P
    const { merchant, actor: buyer, user } = P
    if (!user.isGM) return { error: "Выдавать может только мастер." }
    const item = merchant.items.get(p.itemId)
    if (!item) return { error: "Этого товара уже нет." }
    const stock = stockOf(item)
    if (stock === 0) return { error: "Нет в наличии." }
    const n = Math.clamp(Math.floor(Number(p.qty)) || 1, 1, stock ?? 999)

    const added = await addToActor(buyer, cleanShopData(item), n, (i) => sameThing(i, item))
    if (stock !== null) await item.update({ [`flags.${MOD}.stock`]: stock - n })

    await postDeal(buyer, {
      type: "give",
      merchantUuid: merchant.uuid,
      merchantName: merchant.name,
      actorUuid: buyer.uuid,
      actorName: buyer.name,
      name: item.name,
      qty: n,
      amount: 0,
      targetItemId: added.id,
      merchItemId: item.id,
      stockTracked: stock !== null,
    })
    return { ok: true }
  },
}

/* -------------------------------------------- */
/*  Карточка сделки и отмена                    */
/* -------------------------------------------- */

function dealCardHTML(d) {
  const what = `<b>${esc(d.name)}</b>${d.qty > 1 ? ` ×${d.qty}` : ""}`
  let title
  let sub
  if (d.type === "buy") {
    title = `Покупка: ${what} за ${d.amount} я`
    sub = `${esc(d.merchantName)} · янтарь ${d.amberBefore} → ${d.amberAfter}${d.overloaded ? ` · <span class="nk-chat-warn">перегруз</span>` : ""}`
  } else if (d.type === "sell") {
    title = `Продажа: ${what} за ${d.amount} я`
    sub = `${esc(d.merchantName)} · янтарь ${d.amberBefore} → ${d.amberAfter}`
  } else {
    title = `Выдано: ${what}`
    sub = `${esc(d.merchantName)} · без оплаты`
  }
  const undone = d.undone
    ? `<div class="nk-card-undone">Отменено мастером</div>`
    : `<div class="nk-card-gm"><span>видит только мастер</span><button type="button" data-nk-action="undo">Отменить</button></div>`
  return `<div class="nk-card nk-deal nk-deal-${d.type} ${d.undone ? "nk-is-undone" : ""}">
    <div class="nk-card-title">${d.undone ? `<s>${title}</s>` : title}</div>
    <div class="nk-card-foot">${sub}</div>
    ${undone}
  </div>`
}

async function postDeal(actor, deal) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: dealCardHTML(deal),
    flags: { [MOD]: { deal } },
  })
}

const undoing = new Set()

async function undoDeal(message) {
  if (!game.user.isGM) return
  const deal = message.getFlag(MOD, "deal")
  if (!deal || deal.undone || undoing.has(message.id)) return
  undoing.add(message.id)
  try {
    const res = await enqueue(() => revertDeal(deal).catch((err) => fail(err)))
    if (res?.error) return ui.notifications.warn(res.error)
    deal.undone = true
    await message.update({ content: dealCardHTML(deal), [`flags.${MOD}.deal`]: deal })
  } finally {
    undoing.delete(message.id)
  }
}

async function revertDeal(d) {
  const actor = await fromUuid(d.actorUuid)
  const merchant = await fromUuid(d.merchantUuid)
  if (!actor) return { error: "Жук не найден — отмените вручную." }
  const merchItem = merchant?.items.get(d.merchItemId)

  if (d.type === "buy" || d.type === "give") {
    const item = actor.items.get(d.targetItemId)
    if (!item || qtyOf(item) < d.qty) return { error: `У ${actor.name} уже нет «${d.name}» ×${d.qty} — отмените вручную.` }
    await removeFromItem(item, d.qty)
    if (d.amount) await actor.update({ "system.wealth.pennies": amberOf(actor) + d.amount })
    if (d.stockTracked && merchItem) await merchItem.update({ [`flags.${MOD}.stock`]: (stockOf(merchItem) ?? 0) + d.qty })
    return { ok: true }
  }

  if (d.type === "sell") {
    const amber = amberOf(actor)
    if (amber < d.amount) return { error: `У ${actor.name} уже нет ${d.amount} я — отмените вручную.` }
    await actor.update({ "system.wealth.pennies": amber - d.amount })
    const source = actor.items.get(d.sourceItemId)
    if (source) await source.update({ "system.quantity": qtyOf(source) + d.qty })
    else await actor.createEmbeddedDocuments("Item", [{ ...d.snapshot, _id: d.sourceItemId }], { keepId: true, renderSheet: false })
    if (d.stockTracked && merchItem) await merchItem.update({ [`flags.${MOD}.stock`]: Math.max((stockOf(merchItem) ?? 0) - d.qty, 0) })
    if (merchant) {
      const st = shopState(merchant)
      if (st.visit === d.visit) await merchant.update({ [`flags.${MOD}.shop.spent`]: Math.max(st.spent - d.amount, 0) })
    }
    return { ok: true }
  }
  return { error: "Неизвестная сделка." }
}

/* -------------------------------------------- */
/*  Макрос, меню, токен                         */
/* -------------------------------------------- */

async function createShopMacro(actor, slot) {
  const command = `game.modules.get("${MOD}")?.api?.toggleShop("${actor.uuid}")`
  let macro = game.macros.find((m) => m.command === command && m.isOwner)
  macro ??= await Macro.implementation.create({
    name: `Лавка: ${actor.name}`,
    type: "script",
    img: actor.img,
    command,
  })
  await game.user.assignHotbarMacro(macro, slot)
}

function actorFromLi(li) {
  const el = li instanceof HTMLElement ? li : li?.[0]
  const id = el?.dataset?.entryId ?? el?.dataset?.documentId
  return id ? game.actors.get(id) : null
}

function addDirectoryOptions(app, options) {
  if (!Array.isArray(options)) return
  if (options.some((o) => o?.nkShop)) return
  options.push(
    {
      nkShop: true,
      name: "Открыть / закрыть лавку",
      icon: '<i class="fa-solid fa-store"></i>',
      condition: (li) => game.user.isGM && isMerchant(actorFromLi(li)),
      callback: (li) => toggleShop(actorFromLi(li)),
    },
    {
      nkShop: true,
      name: "Сделать торговцем",
      icon: '<i class="fa-solid fa-scale-balanced"></i>',
      condition: (li) => {
        const a = actorFromLi(li)
        return game.user.isGM && isOurCharacter(a) && !isMerchant(a)
      },
      callback: (li) => actorFromLi(li)?.update({ [`flags.${MOD}.merchant.enabled`]: true }),
    }
  )
}

/** Базовый актёр токена (лавка всегда живёт на нём) */
function merchantOfToken(token) {
  const doc = token?.document ?? token
  const actor = (doc?.actorId && game.actors.get(doc.actorId)) || doc?.actor
  return isMerchant(actor) ? actor : null
}

function patchTokenDoubleClick() {
  const Tok = CONFIG.Token?.objectClass
  const proto = Tok?.prototype
  if (!proto || proto._nkShopPatched) return
  if (typeof proto._onClickLeft2 !== "function" || typeof proto._canView !== "function") return
  const canView = proto._canView
  const click2 = proto._onClickLeft2
  proto._canView = function (user, event) {
    const m = merchantOfToken(this)
    if (m && !user.isGM && shopState(m).open) return true
    return canView.call(this, user, event)
  }
  proto._onClickLeft2 = function (event) {
    const m = merchantOfToken(this)
    if (m && !game.user.isGM && shopState(m).open) {
      openShopWindow(m)
      return
    }
    return click2.call(this, event)
  }
  proto._nkShopPatched = true
}

/** Для проверок вне Foundry */
export const _internals = { HANDLERS, revertDeal, dealCardHTML, undoDeal, ShopApp, APPS }

/* -------------------------------------------- */
/*  Инициализация                               */
/* -------------------------------------------- */

export function initShop() {
  const mod = game.modules.get(MOD)
  if (mod) {
    mod.api = {
      toggleShop: (ref) => {
        const a = typeof ref === "string" ? fromUuidSync(ref) ?? game.actors.getName(ref) : ref
        return toggleShop(a)
      },
      openShop: (ref) => {
        const a = typeof ref === "string" ? fromUuidSync(ref) ?? game.actors.getName(ref) : ref
        return openShopWindow(a)
      },
    }
  }

  try {
    patchTokenDoubleClick()
  } catch (err) {
    console.warn(`${MOD} | двойной клик по торговцу не подключился`, err)
  }

  // Карточки в чате: «Зайти в лавку» и «Отменить»
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const el = html instanceof HTMLElement ? html : html?.[0]
    if (!el || el.dataset.nkBound) return
    el.dataset.nkBound = "1"
    if (!game.user.isGM) el.querySelectorAll(".nk-card-gm").forEach((x) => x.remove())
    el.querySelector('[data-nk-action="undo"]')?.addEventListener("click", (ev) => {
      ev.preventDefault()
      undoDeal(message)
    })
    el.querySelectorAll('[data-nk-action="enter"]').forEach((b) =>
      b.addEventListener("click", (ev) => {
        ev.preventDefault()
        const m = fromUuidSync(b.dataset.merchant)
        if (m) openShopWindow(m)
        else ui.notifications.warn("Торговец не найден.")
      })
    )
  })

  // Правый клик в списке актёров (v13; старое имя хука — на всякий случай)
  Hooks.on("getActorContextOptions", addDirectoryOptions)
  Hooks.on("getActorDirectoryEntryContext", addDirectoryOptions)

  // Кнопка в меню токена
  Hooks.on("renderTokenHUD", (hud, html) => {
    if (!game.user.isGM) return
    const el = html instanceof HTMLElement ? html : html?.[0]
    const m = merchantOfToken(hud.object)
    if (!el || !m) return
    const col = el.querySelector(".col.right") ?? el.querySelector(".right")
    if (!col || col.querySelector(".nk-hud-shop")) return
    const open = shopState(m).open
    col.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="control-icon nk-hud-shop ${open ? "active" : ""}" data-tooltip="${open ? "Закрыть лавку" : "Открыть лавку"}">
        <i class="fa-solid fa-store"></i></button>`
    )
    col.querySelector(".nk-hud-shop").addEventListener("click", (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      toggleShop(m).then(() => hud.render?.())
    })
  })

  // Торговца на панель макросов — получится кнопка «открыть/закрыть лавку»
  Hooks.on("hotbarDrop", (bar, data, slot) => {
    if (!game.user.isGM || data?.type !== "Actor" || !data.uuid) return
    const actor = fromUuidSync(data.uuid)
    if (!isMerchant(actor)) return
    createShopMacro(actor, slot)
    return false
  })

  // Окна лавок следят за торговцем и покупателем
  const refresh = (actor) => {
    if (!actor) return
    for (const app of APPS.values()) {
      if (app.merchant.id === actor.id) {
        if (!game.user.isGM && (!shopState(actor).open || !isMerchant(actor))) {
          app.close()
          ui.notifications.info(`${actor.name}: лавка закрыта.`)
        } else app.render()
      } else if (app.buyerId === actor.id) app.render()
    }
  }
  Hooks.on("updateActor", (actor) => refresh(actor))
  for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (item) => refresh(item.parent))
}
