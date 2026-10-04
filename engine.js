/* Standalone engine for the iPad build: a JavaScript port of server.py.
 * All data lives in this device's IndexedDB; nothing is sent anywhere.
 * index.html talks to it through BCLocal.handle(path, body), the same routes the Python server exposes.
 */
"use strict";
(function () {
  const BUILD = "2026.10.04-1512";
  const PAYMENTS = ["cash", "card", "other"];
  const SAMPLE_MENU = [
    ["Hot Dog", "Food", 3.0, 0.85, 0, 20], ["Nachos", "Food", 3.5, 1.05, 0, 15], ["Pretzel", "Food", 3.0, 0.9, 0, 10],
    ["Popcorn", "Food", 2.0, 0.3, 0, 20], ["Candy", "Snacks", 1.5, 0.7, 0, 20], ["Chips", "Snacks", 1.5, 0.55, 0, 20],
    ["Bottled Water", "Drinks", 1.5, 0.35, 0, 24], ["Soda", "Drinks", 2.0, 0.55, 0, 24],
    ["Sports Drink", "Drinks", 2.5, 0.95, 0, 12], ["Hot Chocolate", "Drinks", 2.0, 0.4, 0, 20],
  ];
  const bad = m => { throw new Error(m); };
  const pad = n => String(n).padStart(2, "0");
  const nowStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const todayStr = () => nowStr().slice(0, 10);
  const money = x => Math.round((Number(x) + 1e-9) * 100) / 100;
  const round = (x, n) => { const p = Math.pow(10, n); return Math.round((x + 1e-9) * p) / p; };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function num(body, key, o = {}) {
    let v = body[key];
    if (v === undefined || v === null || v === "") { if (o.def === undefined) bad("Missing value: " + key); v = o.def; }
    v = Number(v);
    if (!Number.isFinite(v)) bad(key + " must be a number");
    if (o.min !== undefined && v < o.min) bad(`${key} must be at least ${o.min}`);
    if (o.max !== undefined && v > o.max) bad(`${key} must be at most ${o.max}`);
    return o.int ? Math.trunc(v) : v;
  }
  function text(body, key, o = {}) {
    const max = o.max ?? 80, req = o.req ?? true;
    const v = String(body[key] ?? o.def ?? "").trim();
    if (req && !v) bad(key + " is required");
    return v.slice(0, max);
  }

  /* ---------------- storage ---------------- */
  let DB = null, storage = "indexeddb", chain = Promise.resolve();
  const emptyDB = () => ({ app: "booster-concessions", version: 1, seq: {}, items: [], events: [], sales: [], lines: [], moves: [], meta: { lastBackup: null } });
  function reseq() {
    const mx = a => a.reduce((m, r) => Math.max(m, r.id), 0);
    DB.seq = { item: mx(DB.items), event: mx(DB.events), sale: mx(DB.sales), line: mx(DB.lines), move: mx(DB.moves) };
  }
  const nid = k => ++DB.seq[k];
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("booster-concessions", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(val, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  async function load() {
    let raw = null;
    try { raw = await idbGet("db"); }
    catch (e) {
      storage = "localstorage";
      try { raw = localStorage.getItem("bc-db"); } catch (e2) { storage = "memory"; }
    }
    try { DB = raw ? JSON.parse(raw) : emptyDB(); } catch (e) { DB = emptyDB(); }
    if (!DB.meta) DB.meta = { lastBackup: null };
    reseq();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }
  function save() {
    const s = JSON.stringify(DB);
    chain = chain.then(async () => {
      if (storage === "indexeddb") await idbSet("db", s);
      else if (storage === "localstorage") localStorage.setItem("bc-db", s);
    });
    return chain.catch(e => { chain = Promise.resolve(); throw new Error("Could not save to this iPad (" + (e && e.message || e) + "). Free up space and try again."); });
  }
  const ready = load();

  /* ---------------- domain ---------------- */
  const activeEvent = () => DB.events.filter(e => e.active).sort((a, b) => b.id - a.id)[0] || null;
  const itemById = id => DB.items.find(i => i.id === id);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function lastBackupInfo() {
    const lb = DB.meta.lastBackup;
    const since = DB.sales.filter(s => !lb || s.ts > lb).length;
    return { last_backup: lb, sales_since_backup: since };
  }
  function getState() {
    const items = DB.items.slice().sort((a, b) => cmp(b.active, a.active) || cmp(a.category, b.category) || cmp(a.name, b.name)).map(i => ({ ...i }));
    const events = DB.events.map(e => {
      const ss = DB.sales.filter(s => s.event_id === e.id && !s.voided);
      return { ...e, sales_count: ss.length, revenue: ss.reduce((a, s) => a + s.total, 0) };
    }).sort((a, b) => cmp(b.date, a.date) || b.id - a.id);
    const act = activeEvent();
    return { items, events, active_event: act ? { ...act } : null, today: todayStr(), local: true, build: BUILD, storage, ...lastBackupInfo() };
  }

  function createItem(body) {
    const name = text(body, "name");
    if (DB.items.some(i => i.active && i.name.toLowerCase() === name.toLowerCase())) bad(`There is already an item named ${name}`);
    const price = money(num(body, "price", { min: 0, max: 1000 }));
    const cost = round(num(body, "cost", { def: 0, min: 0, max: 1000 }), 4);
    const stock = num(body, "stock", { def: 0, min: 0, max: 100000 });
    const reorder = num(body, "reorder_level", { def: 0, min: 0, max: 100000 });
    const category = text(body, "category", { max: 40, def: "Food" }) || "Food";
    const id = nid("item");
    DB.items.push({ id, name, category, price, cost, stock, reorder_level: reorder, active: 1, created: nowStr() });
    if (stock) DB.moves.push({ id: nid("move"), ts: nowStr(), item_id: id, kind: "opening", qty: stock, amount: 0, note: "Starting stock", event_id: null });
    return id;
  }
  function updateItem(id, body) {
    const row = itemById(id) || bad("Item not found");
    const name = "name" in body ? text(body, "name") : row.name;
    const active = "active" in body ? (body.active ? 1 : 0) : row.active;
    if (active && DB.items.some(i => i.active && i.id !== id && i.name.toLowerCase() === name.toLowerCase())) bad(`There is already an item named ${name}`);
    const category = text(body, "category", { max: 40, def: row.category }) || row.category;
    const price = money(num(body, "price", { def: row.price, min: 0, max: 1000 }));
    const cost = round(num(body, "cost", { def: row.cost, min: 0, max: 1000 }), 4);
    const reorder = num(body, "reorder_level", { def: row.reorder_level, min: 0, max: 100000 });
    Object.assign(row, { name, category, price, cost, reorder_level: reorder, active });
  }
  function restock(id, body) {
    const row = itemById(id) || bad("Item not found");
    const qty = num(body, "qty", { min: 0.0001, max: 100000 });
    const total = money(num(body, "total_cost", { min: 0, max: 100000 }));
    const note = text(body, "note", { max: 120, req: false });
    const onHand = Math.max(row.stock, 0);
    const newCost = round((onHand * row.cost + total) / (onHand + qty), 4);
    const ev = activeEvent();
    row.stock += qty; row.cost = newCost;
    DB.moves.push({ id: nid("move"), ts: nowStr(), item_id: id, kind: "purchase", qty, amount: total, note, event_id: ev ? ev.id : null });
    return newCost;
  }
  function adjust(id, body) {
    const row = itemById(id) || bad("Item not found");
    const note = text(body, "note", { max: 120, req: false });
    const ev = activeEvent(), eid = ev ? ev.id : null;
    if (body.mode === "waste") {
      const qty = num(body, "qty", { min: 0.0001, max: 100000 });
      row.stock -= qty;
      DB.moves.push({ id: nid("move"), ts: nowStr(), item_id: id, kind: "waste", qty: -qty, amount: round(qty * row.cost, 2), note: note || "Waste", event_id: eid });
    } else if (body.mode === "count") {
      const counted = num(body, "counted", { min: 0, max: 100000 });
      const delta = counted - row.stock;
      if (delta === 0) return;
      row.stock = counted;
      DB.moves.push({ id: nid("move"), ts: nowStr(), item_id: id, kind: "count", qty: delta, amount: round(-delta * row.cost, 2), note: note || "Stock count", event_id: eid });
    } else bad("Unknown adjustment");
  }

  function createSale(body) {
    const lines = body.items;
    if (!Array.isArray(lines) || !lines.length) bad("The cart is empty");
    if (!PAYMENTS.includes(body.payment)) bad("Choose cash, card or other");
    const merged = new Map();
    for (const ln of lines) {
      if (!ln || typeof ln !== "object") bad("Bad cart");
      const iid = num(ln, "id", { int: true }), qty = num(ln, "qty", { min: 1, max: 999, int: true });
      merged.set(iid, (merged.get(iid) || 0) + qty);
    }
    const rows = []; let total = 0;
    for (const [iid, qty] of merged) {
      const it = itemById(iid);
      if (!it || !it.active) bad("An item in the cart is no longer on the menu");
      rows.push([it, qty]); total += money(it.price * qty);
    }
    total = money(total);
    let tendered = null;
    if (body.payment === "cash") {
      tendered = money(num(body, "tendered", { def: total, min: 0, max: 100000 }));
      if (tendered + 1e-9 < total) bad("Cash received is less than the total");
    }
    const ev = activeEvent(), sid = nid("sale");
    DB.sales.push({ id: sid, ts: nowStr(), event_id: ev ? ev.id : null, payment: body.payment, total, tendered, voided: 0, void_ts: null });
    for (const [it, qty] of rows) {
      DB.lines.push({ id: nid("line"), sale_id: sid, item_id: it.id, name: it.name, qty, price: it.price, cost: it.cost });
      it.stock -= qty;
    }
    return { id: sid, total, change: tendered !== null ? money(tendered - total) : 0 };
  }
  function voidSale(id) {
    const sale = DB.sales.find(s => s.id === id) || bad("Sale not found");
    if (sale.voided) bad("That sale is already voided");
    for (const ln of DB.lines.filter(l => l.sale_id === id)) {
      const it = itemById(ln.item_id); if (it) it.stock += ln.qty;
      DB.moves.push({ id: nid("move"), ts: nowStr(), item_id: ln.item_id, kind: "void", qty: ln.qty, amount: 0, note: `Voided sale #${id}`, event_id: sale.event_id });
    }
    sale.voided = 1; sale.void_ts = nowStr();
  }
  function linesBySale() {
    const m = new Map();
    for (const l of DB.lines) { if (!m.has(l.sale_id)) m.set(l.sale_id, []); m.get(l.sale_id).push(l); }
    return m;
  }
  function listSales(q) {
    const lbs = linesBySale(), evName = new Map(DB.events.map(e => [e.id, e.name]));
    let rows = DB.sales.slice();
    if (q.event) rows = rows.filter(s => q.event === "none" ? s.event_id === null : s.event_id === parseInt(q.event, 10));
    rows.sort((a, b) => b.id - a.id);
    return rows.slice(0, Math.min(parseInt(q.limit || 200, 10), 1000)).map(s => {
      const ls = lbs.get(s.id) || [];
      return { ...s, event_name: s.event_id !== null ? evName.get(s.event_id) || null : null,
        lines: ls.map(l => ({ name: l.name, qty: l.qty, price: l.price, cost: l.cost })), cogs: round(ls.reduce((a, l) => a + l.qty * l.cost, 0), 2) };
    });
  }

  function createEvent(body) {
    const name = text(body, "name"), d = text(body, "date", { max: 10, def: todayStr() });
    if (!DATE_RE.test(d)) bad("Date must look like 2026-10-09");
    const notes = text(body, "notes", { max: 200, req: false });
    DB.events.forEach(e => e.active = 0);
    const id = nid("event");
    DB.events.push({ id, name, date: d, active: 1, notes });
    return id;
  }
  function activateEvent(id) {
    if (!DB.events.some(e => e.id === id)) bad("Event not found");
    DB.events.forEach(e => e.active = e.id === id ? 1 : 0);
  }

  /* ---------------- reports ---------------- */
  function trendOf(ser) {
    const n = ser.length;
    if (n < 2) return { dir: "na", pct: null };
    const h = Math.floor(n / 2);
    const early = ser.slice(0, h).reduce((a, b) => a + b, 0) / h, recent = ser.slice(-h).reduce((a, b) => a + b, 0) / h;
    if (early === 0) return { dir: recent > 0 ? "new" : "flat", pct: null };
    const pct = (recent - early) / early * 100;
    return { dir: pct >= 15 ? "up" : pct <= -15 ? "down" : "flat", pct: Math.round(pct) };
  }
  function report(q) {
    const frm = q.from || "0000-01-01", to = q.to || "9999-12-31";
    if (!DATE_RE.test(frm) || !DATE_RE.test(to)) bad("Bad date");
    const evId = q.event ? parseInt(q.event, 10) : null;
    if (q.event && Number.isNaN(evId)) bad("Bad request: invalid event");
    const inRange = ts => { const d = ts.slice(0, 10); return d >= frm && d <= to; };
    const sales = DB.sales.filter(s => !s.voided && inRange(s.ts) && (evId === null || s.event_id === evId));
    const lbs = linesBySale(), evById = new Map(DB.events.map(e => [e.id, e]));
    const cogsOf = s => (lbs.get(s.id) || []).reduce((a, l) => a + l.qty * l.cost, 0);

    const revenue = money(sales.reduce((a, s) => a + s.total, 0));
    let cost = 0, units = 0;
    for (const s of sales) for (const l of lbs.get(s.id) || []) { cost += l.qty * l.cost; units += l.qty; }
    cost = money(cost);
    const txns = sales.length, gross = money(revenue - cost);
    const moves = DB.moves.filter(m => inRange(m.ts) && (evId === null || m.event_id === evId));
    const writeoffs = money(moves.filter(m => m.kind === "waste" || m.kind === "count").reduce((a, m) => a + m.amount, 0));
    const purchases = money(moves.filter(m => m.kind === "purchase").reduce((a, m) => a + m.amount, 0));
    const totals = { revenue, cogs: cost, gross_profit: gross, margin: revenue ? round(gross / revenue * 100, 1) : 0, transactions: txns, units,
      avg_sale: txns ? money(revenue / txns) : 0, writeoffs, net_profit: money(gross - writeoffs), purchases, cash_result: money(revenue - purchases) };

    const group = (keyFn) => { const m = new Map(); for (const s of sales) { const k = keyFn(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; };
    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
    const by_day = [...group(s => s.ts.slice(0, 10))].sort((a, b) => cmp(a[0], b[0])).map(([day, ss]) => ({ day, txns: ss.length, revenue: money(sum(ss, s => s.total)), profit: money(sum(ss, s => s.total) - sum(ss, cogsOf)) }));
    const by_hour = [...group(s => s.ts.slice(11, 13))].sort((a, b) => cmp(a[0], b[0])).map(([hour, ss]) => ({ hour, txns: ss.length, revenue: sum(ss, s => s.total) }));
    const by_payment = [...group(s => s.payment)].map(([payment, ss]) => ({ payment, txns: ss.length, revenue: sum(ss, s => s.total) })).sort((a, b) => b.revenue - a.revenue);
    const by_event = [...group(s => s.event_id)].map(([event_id, ss]) => {
      const e = event_id !== null ? evById.get(event_id) : null;
      const minDay = ss.reduce((m, s) => (s.ts < m ? s.ts : m), ss[0].ts).slice(0, 10);
      return { event_id, name: e ? e.name : "No event", date: e ? e.date : minDay, txns: ss.length, revenue: money(sum(ss, s => s.total)), profit: money(sum(ss, s => s.total) - sum(ss, cogsOf)) };
    }).sort((a, b) => cmp(a.date, b.date));

    // sessions: an event, or a plain day when no event was running
    const sessions = new Map(), series = new Map(), sessTotal = new Map(), sold = new Map();
    for (const s of sales) {
      const day = s.ts.slice(0, 10), e = s.event_id !== null ? evById.get(s.event_id) : null;
      const key = s.event_id !== null ? "e" + s.event_id : "d" + day;
      sessions.set(key, { date: e ? e.date : day, label: e ? e.name : day });
      for (const l of lbs.get(s.id) || []) {
        if (!series.has(l.item_id)) series.set(l.item_id, new Map());
        const sm = series.get(l.item_id); sm.set(key, (sm.get(key) || 0) + l.qty);
        sessTotal.set(key, (sessTotal.get(key) || 0) + l.qty);
        const o = sold.get(l.item_id) || { units: 0, revenue: 0, cogs: 0 };
        o.units += l.qty; o.revenue += l.qty * l.price; o.cogs += l.qty * l.cost; sold.set(l.item_id, o);
      }
    }
    const order = [...sessions.keys()].sort((a, b) => cmp(sessions.get(a).date, sessions.get(b).date) || cmp(a, b));
    const items = [];
    for (const it of DB.items.slice().sort((a, b) => cmp(a.name, b.name))) {
      const s = sold.get(it.id);
      if (!s && !it.active) continue;
      const u = s ? s.units : 0, rev = s ? money(s.revenue) : 0, profit = s ? money(s.revenue - s.cogs) : 0;
      const ser = order.map(k => (series.get(it.id) || new Map()).get(k) || 0);
      items.push({ id: it.id, name: it.name, category: it.category, active: it.active, units: u, revenue: rev, profit,
        margin: rev ? round(profit / rev * 100, 1) : (it.price ? round((it.price - it.cost) / it.price * 100, 1) : 0),
        profit_per_unit: u ? round(profit / u, 2) : round(it.price - it.cost, 2),
        series: ser, stock: it.stock, reorder_level: it.reorder_level,
        trend: trendOf(ser.map((x, i) => (sessTotal.get(order[i]) ? x / sessTotal.get(order[i]) : 0))) });
    }
    const totalUnits = sum(items, i => i.units), n = items.length;
    const avgUnitProfit = totalUnits ? sum(items, i => i.profit) / totalUnits : 0;
    const popCut = n ? 0.7 / n : 0;
    for (const i of items) {
      i.share = totalUnits ? round(i.units / totalUnits * 100, 1) : 0;
      const popular = totalUnits > 0 && i.units / totalUnits >= popCut, profitable = i.profit_per_unit >= avgUnitProfit;
      i.class = totalUnits ? (popular && profitable ? "star" : popular ? "plowhorse" : profitable ? "puzzle" : "dog") : "none";
    }
    items.sort((a, b) => b.units - a.units || cmp(a.name, b.name));
    const val = DB.items.filter(i => i.active).reduce((a, i) => a + Math.max(i.stock, 0) * i.cost, 0);
    return { totals, by_day, by_hour, by_payment, by_event, items,
      sessions: order.map(k => ({ key: k, date: sessions.get(k).date, label: sessions.get(k).label })),
      avg_unit_profit: round(avgUnitProfit, 2), pop_cut_pct: round(popCut * 100, 1), inventory_value: money(val) };
  }

  /* ---------------- exports / backup ---------------- */
  const csvCell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = (head, rows) => "﻿" + [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const r4 = x => Math.round((x + 1e-9) * 10000) / 10000;
  function exportCsv(kind) {
    const evName = new Map(DB.events.map(e => [e.id, e.name])), itemName = new Map(DB.items.map(i => [i.id, i.name]));
    if (kind === "sales") {
      const sales = new Map(DB.sales.map(s => [s.id, s]));
      return csv(["sale_id", "time", "event", "payment", "item", "qty", "price", "unit_cost", "line_total", "line_profit", "voided"],
        DB.lines.slice().sort((a, b) => a.sale_id - b.sale_id || a.id - b.id).map(l => { const s = sales.get(l.sale_id);
          return [l.sale_id, s.ts, evName.get(s.event_id) || "", s.payment, l.name, l.qty, l.price, l.cost, r4(l.qty * l.price), r4(l.qty * l.price - l.qty * l.cost), s.voided]; }));
    }
    if (kind === "inventory") {
      return csv(["item", "category", "price", "unit_cost", "profit_per_unit", "on_hand", "reorder_at", "stock_value", "active"],
        DB.items.slice().sort((a, b) => cmp(a.category, b.category) || cmp(a.name, b.name)).map(i => [i.name, i.category, i.price, i.cost, r4(i.price - i.cost), i.stock, i.reorder_level, r4(i.stock * i.cost), i.active]));
    }
    if (kind === "moves") {
      return csv(["time", "item", "type", "qty_change", "amount", "note"], DB.moves.map(m => [m.ts, itemName.get(m.item_id), m.kind, m.qty, m.amount, m.note]));
    }
    bad("Unknown export");
  }
  async function saveFile(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; }
      catch (e) { if (e && e.name === "AbortError") return false; }
    }
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
  async function exportFile(kind) {
    await ready;
    const stamp = todayStr();
    if (kind === "backup") {
      const ok = await saveFile(`concessions-backup-${stamp}.json`, "application/json", JSON.stringify({ ...DB, exported: nowStr() }));
      if (ok) { DB.meta.lastBackup = nowStr(); await save(); }
      return ok;
    }
    const names = { sales: `sales-${stamp}.csv`, inventory: `inventory-${stamp}.csv`, moves: `stock-history-${stamp}.csv` };
    return saveFile(names[kind], "text/csv", exportCsv(kind));
  }
  function shiftDate(s, days) {
    const d = new Date(s.slice(0, 10) + "T12:00:00"); d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` + s.slice(10);
  }
  function restoreFrom(textJson, shiftToToday) {
    let o; try { o = JSON.parse(textJson); } catch (e) { bad("That file isn't a valid backup."); }
    if (!o || o.app !== "booster-concessions" || !["items", "events", "sales", "lines", "moves"].every(k => Array.isArray(o[k]))) bad("That file isn't a Booster Club backup.");
    const next = { app: o.app, version: 1, seq: {}, items: o.items, events: o.events, sales: o.sales, lines: o.lines, moves: o.moves, meta: { lastBackup: null } };
    if (shiftToToday && next.events.length) {
      const last = next.events.reduce((m, e) => (e.date > m ? e.date : m), "0000-00-00");
      const days = Math.round((new Date(todayStr() + "T12:00:00") - new Date(last + "T12:00:00")) / 864e5);
      next.events.forEach(e => e.date = shiftDate(e.date, days));
      next.sales.forEach(s => { s.ts = shiftDate(s.ts, days); if (s.void_ts) s.void_ts = shiftDate(s.void_ts, days); });
      next.moves.forEach(m => m.ts = shiftDate(m.ts, days));
      next.items.forEach(i => i.created = shiftDate(i.created, days));
    }
    DB = next; reseq();
  }

  /* ---------------- router (mirrors server.py) ---------------- */
  async function handle(path, body) {
    await ready;
    const u = new URL(path, "http://x"), parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/").slice(1);
    const q = Object.fromEntries(u.searchParams);
    const post = body !== undefined, p = parts.join("/");
    if (!post) {
      if (p === "state") return getState();
      if (p === "report") return report(q);
      if (p === "sales") return listSales(q);
      bad("Not found");
    }
    let r = { ok: true };
    const id = parseInt(parts[1], 10);
    if (p === "items") r = { id: createItem(body) };
    else if (parts[0] === "items" && parts.length === 2) updateItem(id, body);
    else if (parts[0] === "items" && parts[2] === "restock") r = { cost: restock(id, body) };
    else if (parts[0] === "items" && parts[2] === "adjust") adjust(id, body);
    else if (p === "sample-menu") {
      if (DB.items.length) bad("The menu is not empty");
      SAMPLE_MENU.forEach(([name, category, price, cost, stock, reorder_level]) => createItem({ name, category, price, cost, stock, reorder_level }));
    }
    else if (p === "sales") r = createSale(body);
    else if (parts[0] === "sales" && parts[2] === "void") voidSale(id);
    else if (p === "events") r = { id: createEvent(body) };
    else if (parts[0] === "events" && parts[2] === "activate") activateEvent(id);
    else if (p === "events/end") DB.events.forEach(e => e.active = 0);
    else if (p === "local/restore") restoreFrom(body.json, false);
    else if (p === "local/demo") {
      const res = await fetch("demo.json"); if (!res.ok) bad("Demo data isn't available offline yet. Connect once and try again.");
      restoreFrom(await res.text(), true);
    }
    else if (p === "local/erase") { DB = emptyDB(); reseq(); }
    else bad("Not found");
    await save();
    return r;
  }

  window.BCLocal = { ready, handle, exportFile, build: BUILD };
})();
