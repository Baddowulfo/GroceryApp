/**
 * app.js - UI wiring.
 */

import { parseCode, daysUntil, AI_TABLE } from './gs1.js';
import * as store from './store.js';
import { lookupProduct, guessShelfLife } from './off.js';
import { Scanner, decodeImageFile, feedback } from './scanner.js';
import { parseReceipt, toDrafts } from './receipt.js';
import { estimateShelfLife, addDays } from './shelflife.js';
import { readReceipt } from './ocr.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOCATIONS = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry', other: 'Elsewhere' };
const LOCATION_ICON = { fridge: '\u{1F9CA}', freezer: '❄️', pantry: '\u{1F35E}', other: '\u{1F6D2}' };

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2600);
}

function isoToday(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function statusFor(days) {
  const { warnDays, soonDays } = store.settings();
  if (days === null) return 'none';
  if (days < 0) return 'alert';
  if (days <= warnDays) return 'alert';
  if (days <= soonDays) return 'warn';
  return 'ok';
}

function pillLabel(days) {
  if (days === null) return 'No date';
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 31) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} yr`;
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

const TITLES = {
  inventory: ['In stock', ''],
  scan: ['Scan', 'Point the camera at a product code'],
  receipt: ['Receipt', 'Add a whole shop at once'],
  decode: ['Decode', 'See what a code actually contains'],
};

let currentView = 'inventory';

function showView(name) {
  currentView = name;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${name}`;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.view === name);
  const [title, sub] = TITLES[name];
  $('#view-title').textContent = title;
  $('#view-sub').textContent = name === 'inventory' ? inventorySubtitle() : sub;
  if (name === 'inventory') renderInventory();
  if (name !== 'scan') stopScanner();
  window.scrollTo({ top: 0 });
}

function inventorySubtitle() {
  const items = store.activeItems();
  const urgent = items.filter((i) => i.expiry && daysUntil(i.expiry) <= store.settings().warnDays).length;
  if (!items.length) return 'Nothing tracked yet';
  const units = items.reduce((n, i) => n + i.quantity, 0);
  const noun = units === 1 ? 'item' : 'items';
  return urgent ? `${units} ${noun} - ${urgent} need eating` : `${units} ${noun}, all fine`;
}

/* ------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------ */

const GROUPS = [
  { key: 'past', title: 'Past its date', test: (d) => d !== null && d < 0 },
  { key: 'now', title: 'Eat now', test: (d) => d !== null && d >= 0 && d <= store.settings().warnDays },
  { key: 'soon', title: 'This week', test: (d) => d !== null && d > store.settings().warnDays && d <= store.settings().soonDays },
  { key: 'later', title: 'Later', test: (d) => d !== null && d > store.settings().soonDays },
  { key: 'undated', title: 'No date', test: (d) => d === null },
];

function renderInventory() {
  const query = $('#search').value.trim().toLowerCase();
  const all = store.activeItems();
  const items = query
    ? all.filter((i) => `${i.name} ${i.brand} ${i.gtin || ''} ${i.lot || ''}`.toLowerCase().includes(query))
    : all;

  $('#inventory-empty').hidden = all.length > 0;
  if (currentView === 'inventory') $('#view-sub').textContent = inventorySubtitle();
  renderStats(all);

  const list = $('#inventory-list');
  list.innerHTML = '';
  if (!items.length) {
    if (all.length) list.innerHTML = '<p class="hint" style="padding:1.5rem 1rem">Nothing matches that search.</p>';
    return;
  }

  for (const group of GROUPS) {
    const inGroup = items.filter((i) => group.test(daysUntil(i.expiry)));
    if (!inGroup.length) continue;
    const heading = document.createElement('div');
    heading.className = 'group-title';
    heading.textContent = `${group.title} (${inGroup.length})`;
    list.appendChild(heading);
    for (const item of inGroup) list.appendChild(itemRow(item));
  }
}

function itemRow(item) {
  const days = daysUntil(item.expiry);
  const status = statusFor(days);
  const button = document.createElement('button');
  button.className = 'item';
  button.dataset.id = item.id;

  const bits = [];
  if (item.quantity > 1) bits.push(`${item.quantity}x`);
  if (item.brand) bits.push(item.brand);
  bits.push(LOCATIONS[item.location] || '');
  if (item.expiry) bits.push(formatDate(item.expiry));

  button.innerHTML = `
    <span class="item-thumb" ${item.image ? `style="background-image:url('${esc(item.image)}')"` : ''}>${item.image ? '' : (LOCATION_ICON[item.location] || '\u{1F6D2}')}</span>
    <span class="item-main">
      <span class="item-name">${esc(item.name || 'Unnamed product')}</span>
      <span class="item-meta">${esc(bits.filter(Boolean).join(' · '))}</span>
    </span>
    <span class="pill ${status}">${pillLabel(days)}</span>`;
  button.addEventListener('click', () => openItemSheet(item.id));
  return button;
}

function renderStats(items) {
  const warn = store.settings().warnDays;
  const urgent = items.filter((i) => i.expiry !== null && daysUntil(i.expiry) <= warn);
  const expired = items.filter((i) => i.expiry !== null && daysUntil(i.expiry) < 0);
  const waste = store.wasteStats(30);
  const rate = waste.total ? Math.round((waste.binned / waste.total) * 100) : null;

  $('#stat-row').innerHTML = `
    <div class="stat ${expired.length ? 'alert' : ''}"><b>${expired.length}</b><small>past date</small></div>
    <div class="stat ${urgent.length ? 'warn' : ''}"><b>${urgent.length - expired.length < 0 ? 0 : urgent.length - expired.length}</b><small>eat within ${warn}d</small></div>
    <div class="stat"><b>${items.reduce((n, i) => n + i.quantity, 0)}</b><small>in stock</small></div>
    <div class="stat"><b>${rate === null ? '–' : rate + '%'}</b><small>binned, 30d</small></div>`;
}

/* ------------------------------------------------------------------ *
 * Sheets
 * ------------------------------------------------------------------ */

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('#scrim').hidden = false;
  return $('#sheet-body');
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
  $('#sheet-body').innerHTML = '';
}

/* --- add / edit ------------------------------------------------------ */

const QUICK_DATES = [
  ['Today', 0], ['+2d', 2], ['+3d', 3], ['+5d', 5],
  ['1 week', 7], ['2 weeks', 14], ['1 month', 30], ['3 months', 90], ['1 year', 365],
];

/**
 * @param {object} draft  partial item
 * @param {'add'|'edit'} mode
 */
function openEditSheet(draft, mode = 'add') {
  const fromCode = draft.expirySource === 'code';
  const body = openSheet(`
    <h2>${mode === 'add' ? 'Add to stock' : 'Edit item'}</h2>
    ${draft.gtin ? `<p class="muted" id="gtin-line">GTIN ${esc(draft.gtin)}${draft.lot ? ' · lot ' + esc(draft.lot) : ''}</p>` : ''}

    <div class="field">
      <label for="f-name">Product</label>
      <input id="f-name" value="${esc(draft.name || '')}" placeholder="What is it?" autocomplete="off">
    </div>

    <div class="row">
      <div class="field">
        <label for="f-expiry">Use by</label>
        <input id="f-expiry" type="date" value="${esc(draft.expiry || '')}">
      </div>
      <div class="field" style="max-width:9rem">
        <label for="f-qty">Quantity</label>
        <div class="stepper">
          <button type="button" id="qty-minus">-</button>
          <input id="f-qty" type="number" min="1" step="1" value="${draft.quantity || 1}">
          <button type="button" id="qty-plus">+</button>
        </div>
      </div>
    </div>

    <div id="source-line">${fromCode
      ? `<span class="badge-source">✓ ${esc(draft.expiryKind || 'Expiry date')} read from the code</span>`
      : '<span class="badge-source manual">No date in the code - set one</span>'}</div>

    <div class="chips" id="date-chips">
      ${QUICK_DATES.map(([label, days]) => `<button type="button" class="chip" data-days="${days}">${label}</button>`).join('')}
    </div>

    <div class="row" style="margin-top:.8rem">
      <div class="field">
        <label for="f-location">Where</label>
        <select id="f-location">
          ${Object.entries(LOCATIONS).map(([k, v]) => `<option value="${k}"${draft.location === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="field">
      <label for="f-note">Note</label>
      <input id="f-note" value="${esc(draft.note || '')}" placeholder="Optional">
    </div>

    <div class="sheet-actions">
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">${mode === 'add' ? 'Add' : 'Save'}</button>
    </div>`);

  const expiryInput = body.querySelector('#f-expiry');
  const qtyInput = body.querySelector('#f-qty');

  body.querySelector('#date-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    expiryInput.value = isoToday(+chip.dataset.days);
    draft.expirySource = 'manual';
    body.querySelector('#source-line').innerHTML = '<span class="badge-source manual">Date set by hand</span>';
    for (const c of body.querySelectorAll('.chip')) c.classList.toggle('is-active', c === chip);
  });
  body.querySelector('#qty-minus').addEventListener('click', () => { qtyInput.value = Math.max(1, +qtyInput.value - 1); });
  body.querySelector('#qty-plus').addEventListener('click', () => { qtyInput.value = +qtyInput.value + 1; });
  body.querySelector('#f-cancel').addEventListener('click', closeSheet);

  body.querySelector('#f-save').addEventListener('click', () => {
    const fields = {
      ...draft,
      name: body.querySelector('#f-name').value.trim() || (draft.gtin ? `Product ${draft.gtin.replace(/^0+/, '')}` : 'Unnamed product'),
      expiry: expiryInput.value || null,
      quantity: Math.max(1, +qtyInput.value || 1),
      location: body.querySelector('#f-location').value,
      note: body.querySelector('#f-note').value.trim(),
    };
    if (mode === 'add') {
      store.addItem(fields);
      toast(`Added ${fields.name}`);
    } else {
      store.updateItem(draft.id, fields);
      toast('Saved');
    }
    closeSheet();
    showView('inventory');
  });

  // Look the product up in the background so the name fills itself in.
  if (draft.gtin && !draft.name) {
    lookupProduct(draft.gtin).then((product) => {
      if (!product || !product.found || $('#sheet').hidden) return;
      const nameInput = body.querySelector('#f-name');
      if (!nameInput.value) {
        nameInput.value = [product.name, product.quantity].filter(Boolean).join(', ');
      }
      draft.brand = product.brand;
      draft.image = product.image;
      if (!expiryInput.value) {
        const days = store.shelfLifeFor(draft.gtin) || guessShelfLife(product.categories);
        if (days) {
          expiryInput.value = isoToday(days);
          draft.expirySource = 'estimated';
          body.querySelector('#source-line').innerHTML =
            `<span class="badge-source manual">Estimated: this kind of product usually keeps ~${days} days</span>`;
        }
      }
    }).catch(() => {});
  }
}

/* --- item detail ----------------------------------------------------- */

function openItemSheet(id) {
  const item = store.getItem(id);
  if (!item) return;
  const days = daysUntil(item.expiry);
  const body = openSheet(`
    <h2>${esc(item.name)}</h2>
    <p class="muted">${esc([item.brand, LOCATIONS[item.location], item.quantity > 1 ? item.quantity + ' in stock' : ''].filter(Boolean).join(' · '))}</p>
    <div class="summary-card" style="margin:.8rem 0">
      <dl>
        <dt>Use by</dt><dd>${item.expiry ? esc(formatDate(item.expiry)) + ` (${pillLabel(days)})` : 'not set'}</dd>
        <dt>Date from</dt><dd>${item.expirySource === 'code' ? esc(item.expiryKind || 'the code') : item.expirySource === 'estimated' ? 'an estimate' : 'you'}</dd>
        ${item.gtin ? `<dt>GTIN</dt><dd>${esc(item.gtin)}</dd>` : ''}
        ${item.lot ? `<dt>Batch</dt><dd>${esc(item.lot)}</dd>` : ''}
        ${item.note ? `<dt>Note</dt><dd>${esc(item.note)}</dd>` : ''}
      </dl>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" id="i-eat">Used it</button>
      <button class="btn danger" id="i-bin">Threw it out</button>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" id="i-edit">Edit</button>
      <button class="btn ghost" id="i-del">Remove</button>
    </div>`);

  body.querySelector('#i-eat').addEventListener('click', () => { store.resolveItem(id, 'consumed'); closeSheet(); toast('Nice - eaten, not wasted'); });
  body.querySelector('#i-bin').addEventListener('click', () => { store.resolveItem(id, 'discarded'); closeSheet(); toast('Logged as waste'); });
  body.querySelector('#i-edit').addEventListener('click', () => openEditSheet({ ...item }, 'edit'));
  body.querySelector('#i-del').addEventListener('click', () => { store.removeItem(id); closeSheet(); toast('Removed'); });
}

/* --- settings -------------------------------------------------------- */

function openSettingsSheet() {
  const s = store.settings();
  const body = openSheet(`
    <h2>Settings</h2>
    <div class="row">
      <div class="field">
        <label for="s-warn">"Eat now" threshold (days)</label>
        <input id="s-warn" type="number" min="0" max="30" value="${s.warnDays}">
      </div>
      <div class="field">
        <label for="s-soon">"This week" threshold (days)</label>
        <input id="s-soon" type="number" min="1" max="90" value="${s.soonDays}">
      </div>
    </div>
    <p class="muted">Everything is stored on this device only. Back it up before clearing browser data.</p>
    <div class="sheet-actions">
      <button class="btn ghost" id="s-export">Export backup</button>
      <label class="btn ghost file-btn" style="text-align:center">Import<input id="s-import" type="file" accept="application/json" hidden></label>
    </div>
    <div class="sheet-actions">
      <button class="btn danger" id="s-clear">Delete everything</button>
      <button class="btn primary" id="s-close">Done</button>
    </div>`);

  body.querySelector('#s-warn').addEventListener('change', (e) => store.setSetting('warnDays', +e.target.value));
  body.querySelector('#s-soon').addEventListener('change', (e) => store.setSetting('soonDays', +e.target.value));
  body.querySelector('#s-close').addEventListener('click', closeSheet);
  body.querySelector('#s-export').addEventListener('click', () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `freshtrack-backup-${isoToday()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  body.querySelector('#s-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { store.importJson(await file.text()); toast('Backup restored'); closeSheet(); }
    catch (err) { toast(err.message); }
  });
  body.querySelector('#s-clear').addEventListener('click', () => {
    if (window.confirm('Delete all tracked groceries on this device?')) { store.clearAll(); closeSheet(); toast('Cleared'); }
  });
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

let scanner = null;

async function startScanner() {
  if (!scanner) scanner = new Scanner($('#video'), $('#frame'));
  try {
    await scanner.start(handleScan, (msg) => { $('#scan-status').textContent = msg; });
    $('#btn-scan-toggle').textContent = 'Stop camera';
    $('#btn-flip').hidden = false;
    $('#btn-torch').hidden = false;
    $('#scan-hint').textContent = `Decoder: ${scanner.decoderName}. Hold the code inside the frame.`;
  } catch (err) {
    $('#scan-status').textContent = '';
    $('#scan-hint').textContent = friendlyCameraError(err);
    $('#btn-scan-toggle').textContent = 'Start camera';
  }
}

function friendlyCameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'Camera permission was refused. Allow it in the browser settings, or type the code instead.';
  if (name === 'NotFoundError') return 'No camera found on this device. Type the code, or decode a photo.';
  if (String(err.message).includes('fallback decoder')) return 'This browser has no built-in barcode decoder and the fallback could not be downloaded. Type the code, or open the app where the CDN is reachable.';
  return `Camera unavailable: ${err.message}`;
}

function stopScanner() {
  if (scanner) { scanner.stop(); $('#btn-scan-toggle').textContent = 'Start camera'; }
}

function handleScan(text, format) {
  feedback(true);
  const parsed = parseCode(text);
  logScan(text, format, parsed);
  if (!parsed.gtin && !parsed.expiry) {
    toast('Scanned, but that is not a product code');
    return;
  }
  stopScanner();
  openEditSheet(draftFromParsed(parsed));
}

function draftFromParsed(parsed) {
  return {
    gtin: parsed.gtin,
    lot: parsed.lot,
    serial: parsed.serial,
    expiry: parsed.expiry,
    expiryKind: parsed.expiryKind,
    expirySource: parsed.expiry ? 'code' : 'manual',
    quantity: 1,
    location: 'fridge',
    raw: parsed.raw,
    name: '',
  };
}

function logScan(text, format, parsed) {
  const line = document.createElement('div');
  line.className = 'logline';
  line.textContent = `${format || parsed.format} · ${text.slice(0, 90)}`;
  $('#scan-log').prepend(line);
  while ($('#scan-log').children.length > 4) $('#scan-log').lastChild.remove();
}


/* ------------------------------------------------------------------ *
 * Receipts
 *
 * A receipt gives the shopping list and the purchase date. The expiry date
 * has to be inferred: category shelf life counted from the day of purchase,
 * overridden by anything the user has corrected before, and left blank when
 * we genuinely do not know. Every line is editable before it is saved.
 * ------------------------------------------------------------------ */

let review = null;   // { parsed, drafts, text }

function setProgress(fraction, label) {
  $('#receipt-progress').hidden = false;
  $('#progress-bar').style.width = Math.round(fraction * 100) + '%';
  $('#progress-label').textContent = label;
}

async function handleReceiptPhoto(file) {
  $('#receipt-review').hidden = true;
  $('#receipt-intro').hidden = true;
  setProgress(0, 'Starting');
  try {
    const text = await readReceipt(file, {
      lang: $('#receipt-lang').value,
      onProgress: (fraction, label) => setProgress(fraction, label),
    });
    $('#receipt-progress').hidden = true;
    showReceipt(text);
  } catch (err) {
    $('#receipt-progress').hidden = true;
    $('#receipt-intro').hidden = false;
    toast(err.message);
  }
}

function showReceipt(text) {
  const parsed = parseReceipt(text);
  const drafts = toDrafts(parsed, store.learnedShelfLives());
  review = { parsed, drafts, text };
  renderReview();
}

function renderReview() {
  const { parsed, drafts, text } = review;
  const box = $('#receipt-review');
  $('#receipt-intro').hidden = true;
  box.hidden = false;

  if (!drafts.length) {
    box.innerHTML = `
      <div class="summary-card">
        <h2>Nothing readable</h2>
        <p class="muted">No product lines came out of that image. Photograph the receipt straight on and filling the frame, or paste the text instead.</p>
      </div>
      ${rawTextBlock(text)}
      <div class="review-actions"><button class="btn ghost" id="rv-again">Try another photo</button></div>`;
    $('#rv-again').addEventListener('click', resetReceipt);
    return;
  }

  const counts = drafts.reduce((acc, d) => { acc[d.confidence] = (acc[d.confidence] || 0) + 1; return acc; }, {});

  box.innerHTML = `
    <div class="review-head">
      <div style="flex:1">
        <h2>${esc(parsed.store || 'Receipt')}</h2>
        <p class="muted">${drafts.length} lines · ${counts.guessed || 0} dated from the shelf-life table${counts.learned ? ', ' + counts.learned + ' from your own history' : ''}${counts.unknown ? ', ' + counts.unknown + ' unknown' : ''}</p>
      </div>
      <div class="field">
        <label for="rv-date">Bought on</label>
        <input id="rv-date" type="date" value="${esc(parsed.date)}">
      </div>
    </div>
    <div id="rv-lines">${drafts.map(lineMarkup).join('')}</div>
    ${rawTextBlock(text)}
    <div class="review-actions">
      <button class="btn ghost" id="rv-cancel">Discard</button>
      <button class="btn primary" id="rv-add">Add ${drafts.filter((d) => d.include).length} items</button>
    </div>`;

  $('#rv-date').addEventListener('change', (e) => {
    // Re-date every line that still has its computed date.
    review.parsed.date = e.target.value;
    for (const draft of review.drafts) if (draft.days && !draft.edited) draft.expiry = addDays(e.target.value, draft.days);
    renderReview();
  });

  $('#rv-lines').addEventListener('change', onLineChange);
  $('#rv-lines').addEventListener('input', onLineChange);
  $('#rv-cancel').addEventListener('click', resetReceipt);
  $('#rv-add').addEventListener('click', commitReview);
}

function lineMarkup(draft, index) {
  const note = draft.confidence === 'unknown' ? 'not recognised — set a date or leave it undated'
    : draft.confidence === 'skip' ? 'not food'
    : `${draft.categoryLabel} · ${draft.days} days`;
  return `
    <div class="line ${draft.include ? '' : 'is-off'}" data-i="${index}">
      <input type="checkbox" data-role="include" ${draft.include ? 'checked' : ''} aria-label="Include ${esc(draft.name)}">
      <div class="line-main">
        <input class="line-name" data-role="name" value="${esc(draft.name)}">
        <div class="line-meta">
          ${draft.quantity > 1 ? `<span>${draft.quantity}x</span>` : ''}
          ${draft.amount ? `<span>${esc(draft.amount)}</span>` : ''}
          <span class="tag ${draft.confidence}">${draft.confidence}</span>
          <span>${esc(note)}</span>
        </div>
      </div>
      <input type="date" data-role="expiry" value="${esc(draft.expiry || '')}">
    </div>`;
}

function rawTextBlock(text) {
  return `<details class="raw-text"><summary>What the reader saw</summary><pre>${esc(text)}</pre></details>`;
}

function onLineChange(event) {
  const row = event.target.closest('.line');
  if (!row) return;
  const draft = review.drafts[+row.dataset.i];
  const role = event.target.dataset.role;

  if (role === 'include') {
    draft.include = event.target.checked;
    row.classList.toggle('is-off', !draft.include);
    $('#rv-add').textContent = `Add ${review.drafts.filter((d) => d.include).length} items`;
  } else if (role === 'expiry') {
    draft.expiry = event.target.value || null;
    draft.edited = true;
  } else if (role === 'name') {
    draft.name = event.target.value;
    // Renaming a line is usually how an unrecognised item gets recognised.
    if (!draft.edited) {
      const guess = estimateShelfLife(draft.name);
      if (guess.days) {
        draft.days = guess.days;
        draft.location = guess.location;
        draft.category = guess.category.key;
        draft.categoryLabel = guess.category.label;
        draft.confidence = 'guessed';
        draft.expiry = addDays(review.parsed.date, guess.days);
        row.querySelector('[data-role="expiry"]').value = draft.expiry;
        row.querySelector('.line-meta').innerHTML =
          `<span class="tag guessed">guessed</span><span>${esc(guess.category.label)} · ${guess.days} days</span>`;
      }
    }
  }
}

function commitReview() {
  const chosen = review.drafts.filter((d) => d.include);
  if (!chosen.length) { toast('Nothing ticked'); return; }

  const purchase = review.parsed.date;
  store.addItems(chosen.map((draft) => ({
    name: draft.name,
    quantity: draft.quantity,
    expiry: draft.expiry,
    expirySource: draft.confidence === 'learned' ? 'learned' : draft.edited ? 'manual' : 'estimated',
    expiryKind: draft.categoryLabel || '',
    location: draft.location === 'other' ? 'pantry' : draft.location,
    note: [review.parsed.store, 'receipt ' + purchase].filter(Boolean).join(' · '),
    raw: draft.raw,
  })));

  // Learn from what was corrected, so the next receipt starts closer.
  for (const draft of chosen) {
    if (!draft.edited || !draft.expiry) continue;
    const days = Math.round((Date.parse(draft.expiry + 'T12:00:00Z') - Date.parse(purchase + 'T12:00:00Z')) / 86400000);
    store.rememberNameShelfLife(draft.name, days);
  }

  toast(`Added ${chosen.length} items`);
  resetReceipt();
  showView('inventory');
}

function resetReceipt() {
  review = null;
  $('#receipt-review').hidden = true;
  $('#receipt-review').innerHTML = '';
  $('#receipt-progress').hidden = true;
  $('#receipt-intro').hidden = false;
  $('#file-receipt').value = '';
}

function pasteReceiptSheet() {
  const body = openSheet(`
    <h2>Paste receipt text</h2>
    <p class="muted">From a digital receipt, an email, or anywhere else you already have the text.</p>
    <div class="field"><textarea id="p-text" rows="8" style="margin:0;width:100%" placeholder="MIGROS\nM-Classic Vollmilch 1L   1.45\n..."></textarea></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="p-cancel">Cancel</button>
      <button class="btn primary" id="p-go">Read it</button>
    </div>`);
  body.querySelector('#p-cancel').addEventListener('click', closeSheet);
  body.querySelector('#p-go').addEventListener('click', () => {
    const text = body.querySelector('#p-text').value;
    closeSheet();
    if (text.trim()) showReceipt(text);
  });
}

/* ------------------------------------------------------------------ *
 * Decode view
 * ------------------------------------------------------------------ */

const SAMPLES = {
  dl: 'https://id.gs1.org/01/09506000134352/10/ABC-123?17=270131&3103=000355',
  dm: ']d2010950600013435217270131\x1D10ABC-123',
  ean: '5449000000996',
};

function renderDecode(input) {
  const parsed = parseCode(input);
  const out = $('#decode-output');
  if (!input.trim()) { out.innerHTML = ''; return; }

  const rows = parsed.segments.map((s) => {
    const highlight = ['17', '15', '7003', '01'].includes(s.ai);
    const decoded = s.value === null ? '<span class="muted">could not decode</span>'
      : (typeof s.value === 'number' ? s.value : esc(s.value)) + (s.time ? ' ' + esc(s.time) : '');
    return `<tr class="${highlight ? 'highlight' : ''}">
      <td><code>${esc(s.ai)}</code></td>
      <td>${esc(s.label)}</td>
      <td><code>${esc(s.raw)}</code></td>
      <td>${decoded}</td></tr>`;
  }).join('');

  const days = daysUntil(parsed.expiry);
  out.innerHTML = `
    <div class="summary-card">
      <h2>${parsed.format === 'digital-link' ? 'GS1 Digital Link' : parsed.format === 'element-string' ? 'GS1 element string' : parsed.format === 'plain-gtin' ? 'Plain linear barcode' : 'Not recognised'}</h2>
      <dl>
        ${parsed.symbology ? `<dt>Symbology</dt><dd>${esc(parsed.symbology)}</dd>` : ''}
        <dt>GTIN</dt><dd>${parsed.gtin ? esc(parsed.gtin) + (parsed.gtinValid ? ' ✓' : ' ⚠ check digit') : '–'}</dd>
        <dt>Expiry</dt><dd>${parsed.expiry ? `${esc(formatDate(parsed.expiry))} (${pillLabel(days)}) · ${esc(parsed.expiryKind)}` : 'not in this code'}</dd>
        ${parsed.lot ? `<dt>Batch</dt><dd>${esc(parsed.lot)}</dd>` : ''}
        ${parsed.serial ? `<dt>Serial</dt><dd>${esc(parsed.serial)}</dd>` : ''}
        ${parsed.netWeight ? `<dt>Net weight</dt><dd>${parsed.netWeight} kg</dd>` : ''}
      </dl>
    </div>
    ${parsed.warnings.length ? `<div class="warnings"><b>Notes</b><ul>${parsed.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${rows ? `<table class="ai-table"><thead><tr><th>AI</th><th>Meaning</th><th>Raw</th><th>Decoded</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${parsed.gtin ? `<div class="alt-input"><button class="btn primary" id="decode-add">Add this to stock</button></div>` : ''}`;

  const add = $('#decode-add');
  if (add) add.addEventListener('click', () => openEditSheet(draftFromParsed(parsed)));
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function typeCodeSheet() {
  const body = openSheet(`
    <h2>Type or paste a code</h2>
    <p class="muted">A barcode number, or the whole contents of a QR code.</p>
    <div class="field"><input id="t-code" placeholder="5449000000996" autocomplete="off"></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="t-cancel">Cancel</button>
      <button class="btn primary" id="t-go">Continue</button>
    </div>`);
  body.querySelector('#t-cancel').addEventListener('click', closeSheet);
  const go = () => {
    const parsed = parseCode(body.querySelector('#t-code').value);
    if (!parsed.gtin && !parsed.expiry) { toast('That is not a product code'); return; }
    openEditSheet(draftFromParsed(parsed));
  };
  body.querySelector('#t-go').addEventListener('click', go);
  body.querySelector('#t-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.querySelector('#t-code').focus();
}

function init() {
  store.subscribe(renderInventory);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
  for (const btn of document.querySelectorAll('[data-goto]')) {
    btn.addEventListener('click', () => showView(btn.dataset.goto));
  }

  $('#search').addEventListener('input', renderInventory);
  $('#btn-settings').addEventListener('click', openSettingsSheet);
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  $('#btn-scan-toggle').addEventListener('click', () => {
    if (scanner && scanner.running) stopScanner(); else startScanner();
  });
  $('#btn-flip').addEventListener('click', () => scanner?.flip());
  $('#btn-torch').addEventListener('click', async () => {
    const on = await scanner?.toggleTorch();
    if (on === false) toast('This camera has no torch control');
  });
  $('#file-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#scan-hint').textContent = 'Decoding the photo...';
    try {
      const text = await decodeImageFile(file);
      if (text) handleScan(text, 'photo');
      else toast('No code found in that image');
    } catch (err) { toast('Could not decode: ' + err.message); }
    $('#scan-hint').textContent = 'Point at the QR code, Data Matrix or barcode on the pack.';
    e.target.value = '';
  });

  $('#btn-type-code').addEventListener('click', typeCodeSheet);
  $('#btn-add-manual').addEventListener('click', () => openEditSheet({ quantity: 1, location: 'fridge', expirySource: 'manual' }));
  $('#btn-add-manual-empty').addEventListener('click', () => openEditSheet({ quantity: 1, location: 'fridge', expirySource: 'manual' }));

  $('#file-receipt').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleReceiptPhoto(file);
  });
  $('#btn-receipt-text').addEventListener('click', pasteReceiptSheet);

  $('#btn-decode').addEventListener('click', () => renderDecode($('#decode-input').value));
  $('#decode-input').addEventListener('input', () => renderDecode($('#decode-input').value));
  for (const btn of document.querySelectorAll('[data-sample]')) {
    btn.addEventListener('click', () => {
      $('#decode-input').value = SAMPLES[btn.dataset.sample];
      renderDecode(SAMPLES[btn.dataset.sample]);
    });
  }

  showView('inventory');
  renderInventory();
}

document.addEventListener('DOMContentLoaded', init);
