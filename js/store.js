/**
 * store.js - all app state, persisted locally in the browser.
 *
 * Nothing leaves the device except the optional Open Food Facts lookup.
 * One localStorage key holds the whole state; for a household-sized
 * inventory that is a few tens of kilobytes at most.
 */

const KEY = 'freshtrack.v1';

const EMPTY = {
  version: 1,
  items: [],        // see newItem() for the shape
  products: {},     // gtin -> cached Open Food Facts result
  shelfLife: {},    // gtin -> days, learned from manual entries
  shelfLifeNames: {}, // receipt line (folded) -> days, learned from corrections
  log: [],          // { at, action: 'consumed'|'discarded', name, gtin }
  settings: { warnDays: 3, soonDays: 7 },
};

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed,
      settings: { ...EMPTY.settings, ...(parsed.settings || {}) } };
  } catch {
    return structuredClone(EMPTY);   // private mode, blocked storage, corrupt data
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save state:', err);
  }
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function getState() { return state; }
export function settings() { return state.settings; }

export function setSetting(key, value) {
  state.settings[key] = value;
  persist();
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function newItem(fields = {}) {
  return {
    id: uid(),
    name: '',
    brand: '',
    image: '',
    gtin: null,
    quantity: 1,
    unit: '',
    expiry: null,          // ISO yyyy-mm-dd
    expirySource: 'manual', // 'code' | 'manual' | 'estimated'
    expiryKind: '',        // e.g. "Expiration date" / "Best before date"
    lot: null,
    serial: null,
    location: 'fridge',
    note: '',
    raw: '',
    addedAt: new Date().toISOString(),
    status: 'active',
    ...fields,
  };
}

/** Active items, soonest expiry first, undated last. */
export function activeItems() {
  return state.items
    .filter((i) => i.status === 'active')
    .sort((a, b) => {
      if (!a.expiry && !b.expiry) return a.name.localeCompare(b.name);
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.localeCompare(b.expiry);
    });
}

export function getItem(id) { return state.items.find((i) => i.id === id); }

/**
 * Add an item. If an identical product with the same expiry is already in
 * stock, bump its quantity instead of creating a near-duplicate row.
 */
export function addItem(fields) {
  const item = newItem(fields);
  const twin = state.items.find((i) =>
    i.status === 'active' && i.gtin && i.gtin === item.gtin &&
    i.expiry === item.expiry && i.lot === item.lot);
  if (twin) {
    twin.quantity += item.quantity;
    persist();
    return twin;
  }
  state.items.unshift(item);
  if (item.gtin && item.expiry && item.expirySource === 'manual') rememberShelfLife(item.gtin, item.expiry);
  persist();
  return item;
}

export function updateItem(id, changes) {
  const item = getItem(id);
  if (!item) return null;
  Object.assign(item, changes);
  persist();
  return item;
}

export function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  persist();
}

/** Mark one unit as eaten or binned; the row disappears when nothing is left. */
export function resolveItem(id, action) {
  const item = getItem(id);
  if (!item) return;
  item.quantity -= 1;
  state.log.unshift({ at: new Date().toISOString(), action, name: item.name, gtin: item.gtin });
  state.log = state.log.slice(0, 500);
  if (item.quantity <= 0) {
    item.status = action;
    item.resolvedAt = new Date().toISOString();
  }
  persist();
}

/* --- learned shelf life ------------------------------------------------ */

function rememberShelfLife(gtin, expiry) {
  const days = Math.round((Date.parse(expiry + 'T00:00:00Z') - Date.now()) / 86400000);
  if (days > 0 && days < 1000) state.shelfLife[gtin] = days;
}

/** Days this product usually lasts, if we have seen it entered by hand before. */
export function shelfLifeFor(gtin) {
  return gtin ? state.shelfLife[gtin] || null : null;
}

/**
 * Receipts have no barcode, so what is learned there is keyed by the printed
 * line instead. Corrections are what make the second shop better than the first.
 */
export function rememberNameShelfLife(name, days) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || !(days > 0) || days > 1000) return;
  state.shelfLifeNames[key] = days;
  persist();
}

export function learnedShelfLives() { return state.shelfLifeNames; }

/** Add a reviewed receipt in one go. */
export function addItems(fieldsList) {
  const added = [];
  for (const fields of fieldsList) added.push(newItem(fields));
  // unshift as a block so the whole shop keeps its order in the list
  state.items.unshift(...added);
  persist();
  return added;
}

/* --- product cache ----------------------------------------------------- */

export function cachedProduct(gtin) { return gtin ? state.products[gtin] || null : null; }

export function cacheProduct(gtin, product) {
  if (!gtin) return;
  state.products[gtin] = { ...product, fetchedAt: Date.now() };
  persist();
}

/* --- waste statistics --------------------------------------------------- */

export function wasteStats(days = 30) {
  const since = Date.now() - days * 86400000;
  const recent = state.log.filter((e) => Date.parse(e.at) >= since);
  const eaten = recent.filter((e) => e.action === 'consumed').length;
  const binned = recent.filter((e) => e.action === 'discarded').length;
  return { eaten, binned, total: eaten + binned };
}

/* --- backup ------------------------------------------------------------- */

export function exportJson() { return JSON.stringify(state, null, 2); }

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('That file does not look like a FreshTrack backup.');
  state = { ...structuredClone(EMPTY), ...parsed };
  persist();
}

export function clearAll() {
  state = structuredClone(EMPTY);
  persist();
}
