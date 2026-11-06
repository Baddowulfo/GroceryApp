/**
 * receipt.js - turning the text of a till receipt into grocery items.
 *
 * Written against Swiss supermarket receipts (Migros, Coop, Aldi, Lidl,
 * Denner, Volg, Spar) but the fallback rules are generic: find the lines that
 * look like "some words ..... 1.45", throw away the ones that are totals,
 * payments, discounts or loyalty noise, and keep the rest.
 *
 * OCR output is messy by nature, so every rule here is forgiving and the user
 * reviews the result before anything is saved.
 */

import { estimateShelfLife, addDays, fold } from './shelflife.js';

const STORES = [
  [/migros|m-?budget|m-?classic|migipedia|cumulus/i, 'Migros'],
  [/\bcoop\b|prix\s*garantie|naturaplan|supercard|f\S{0,3}r\s+mich\s+und\s+dich|pour\s+moi\s+et\s+pour\s+toi/i, 'Coop'],
  [/\blidl\b/i, 'Lidl'],
  [/\baldi\b/i, 'Aldi'],
  [/\bdenner\b/i, 'Denner'],
  [/\bvolg\b/i, 'Volg'],
  [/\bspar\b/i, 'Spar'],
  [/manor|globus/i, 'Manor'],
];

// Lines that are never a product.
const NOT_AN_ITEM = new RegExp([
  'total', 'summe', 'zwischensumme', 'subtotal', 'betrag', 'saldo', 'somme',
  'bar\\b', 'bargeld', 'karte', 'carte', 'twint', 'ec\\b', 'maestro', 'visa', 'mastercard',
  'kreditkarte', 'debit', 'kontaktlos', 'zahlung', 'paiement',
  'postfinance', 'reka', 'lunch.?check', 'buchung', 'terminal', 'autoris',
  'signatur', 'trx', 'transaktion', 'kundenbeleg', 'haendler', 'handler',
  'ruckgeld', 'wechselgeld', 'rendu', 'change\\b',
  'mwst', 'mehrwertsteuer', '\\btva\\b', '\\bvat\\b', 'steuer',
  'rabatt', 'aktion', 'ristourne', 'remise', 'discount', 'bon\\b', 'gutschein',
  'cumulus', 'supercard', 'punkte', 'points', 'treue',
  'kasse', 'kassier', 'filiale', 'quittung', 'beleg', 'ticket', 'rechnung',
  'artikel', 'positionen', 'anzahl\\s*artikel', 'stuck\\s*total',
  'danke', 'merci', 'wiedersehen', 'besuch', 'tel\\.', 'www\\.', 'gmbh', '\\bag\\b',
  'uid\\b', 'che-', 'datum', 'uhrzeit', 'zeit\\b', 'runden', 'rundung', 'trinkgeld',
  'einkauf', 'genossenschaft', 'strasse', 'offnungszeiten', 'kundendienst',
].join('|'), 'i');

const PRICE_AT_END = /(-?\d{1,4}[.,]\d{2})\s*(?:[A-Za-z0-9]{1,3}\*?|\*)?\s*$/;
const TRAILING_PRICE = /\s(-?\d{1,4}[.,]\d{2})\s*$/;
// A quantity column, possibly with an OCR smudge stuck to it ("1)", "1|").
const QUANTITY_COLUMN = /\s(\d{1,3}(?:[.,]\d{1,3})?)[^\s\d]{0,2}\s*$/;
const QUANTITY_PREFIX = /^\s*(\d{1,3})\s*[x×*]\s*/i;
const WEIGHT_LINE = /^\s*(\d+[.,]\d+)\s*(kg|g|l|ml|st|stk)\b.*?[x×*]\s*(\d+[.,]\d+)/i;
const DATE_ANY = /(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})|(\d{4})-(\d{2})-(\d{2})/;

/** OCR reads 0 as O and 1 as l often enough to be worth undoing, but only in numbers. */
function fixDigits(text) {
  return text.replace(/[OoIlSB](?=[\d.,])|(?<=[\d.,])[OoIlSB]/g,
    (c) => ({ O: '0', o: '0', I: '1', l: '1', S: '5', B: '8' }[c]));
}

function toNumber(text) {
  const n = parseFloat(String(text).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function detectStore(text) {
  const head = text.slice(0, 600);
  for (const [pattern, name] of STORES) if (pattern.test(head)) return name;
  return null;
}

function detectDate(text, now) {
  const currentYear = now.getFullYear();
  for (const line of text.split('\n')) {
    const m = DATE_ANY.exec(fixDigits(line));
    if (!m) continue;
    let y, mo, d;
    if (m[4]) { y = +m[4]; mo = +m[5]; d = +m[6]; }
    else {
      d = +m[1]; mo = +m[2]; y = +m[3];
      if (y < 100) y += 2000;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (y < currentYear - 2 || y > currentYear + 1) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Strip article codes, VAT letters and other trailing noise from a name. */
function cleanName(name) {
  return name
    .replace(/^[\s|.:*#>-]+/, '')
    .replace(/[\s.:*#|-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\d{6,}\s+/, '')          // leading article number
    .replace(/\s+[A-Z]$/, '')           // trailing VAT class letter
    .trim();
}

/**
 * Coop and friends print "Artikel | Menge | Preis | Aktion | Total", so once
 * the total has been taken off the end there can be two more prices and a
 * quantity still clinging to the product name. Migros prints a single price,
 * and there the name must be left alone - so the quantity column is only
 * stripped when at least one extra price was found before it. That is what
 * keeps the "1L" on "M-Classic Vollmilch 1L".
 */
function splitColumns(text) {
  let name = text;
  let prices = 0;
  for (let i = 0; i < 2; i++) {
    const m = TRAILING_PRICE.exec(name);
    if (!m) break;
    name = name.slice(0, m.index);
    prices++;
  }
  if (!prices) return { name, quantity: null, amount: '' };

  const q = QUANTITY_COLUMN.exec(name);
  if (!q) return { name, quantity: null, amount: '' };
  name = name.slice(0, q.index);
  const value = toNumber(q[1]);
  // A fractional quantity is a weight, not a count of packets.
  return Number.isInteger(value) && value > 0
    ? { name, quantity: Math.min(value, 99), amount: '' }
    : { name, quantity: 1, amount: value ? String(value) : '' };
}

function looksLikeAName(name) {
  const letters = (name.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return letters >= 3 && letters / Math.max(name.length, 1) > 0.4;
}

/**
 * @param {string} text raw OCR text
 * @returns {{store, date, items: Array, skipped: Array}}
 */
export function parseReceipt(text, opts = {}) {
  const now = opts.now || new Date();
  const raw = String(text || '');
  const store = detectStore(raw);
  const date = detectDate(raw, now) || now.toISOString().slice(0, 10);

  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trimEnd());
  const items = [];
  const skipped = [];
  let pendingName = null;      // a product name whose price is on the next line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // "0.482 kg x 24.90     12.00" - the weight line for the name above it
    const weight = WEIGHT_LINE.exec(fixDigits(trimmed));
    if (weight && pendingName) {
      const priceMatch = PRICE_AT_END.exec(fixDigits(trimmed));
      items.push({
        raw: `${pendingName} / ${trimmed}`,
        name: cleanName(pendingName),
        quantity: 1,
        amount: `${toNumber(weight[1])} ${weight[2].toLowerCase()}`,
        price: priceMatch ? toNumber(priceMatch[1]) : toNumber(weight[3]),
      });
      pendingName = null;
      continue;
    }

    const priceMatch = PRICE_AT_END.exec(fixDigits(trimmed));
    if (!priceMatch) {
      // No price: might be a product whose price is on the following line.
      const candidate = cleanName(trimmed);
      pendingName = (!NOT_AN_ITEM.test(fold(candidate)) && looksLikeAName(candidate)) ? candidate : null;
      continue;
    }
    pendingName = null;

    const price = toNumber(priceMatch[1]);
    const columns = splitColumns(trimmed.slice(0, priceMatch.index));
    let name = cleanName(columns.name);

    if (NOT_AN_ITEM.test(fold(name)) || NOT_AN_ITEM.test(fold(trimmed))) { skipped.push(trimmed); continue; }
    if (price !== null && price < 0) { skipped.push(trimmed); continue; }   // discount line
    if (!looksLikeAName(name)) { skipped.push(trimmed); continue; }

    let quantity = columns.quantity || 1;
    const q = QUANTITY_PREFIX.exec(name);          // Migros writes "2 x Zopf Butter"
    if (q) { quantity = Math.min(+q[1], 99); name = cleanName(name.slice(q[0].length)); }
    if (!looksLikeAName(name)) { skipped.push(trimmed); continue; }

    items.push({ raw: trimmed, name, quantity, price, amount: columns.amount || undefined });
  }

  return { store, date, items, skipped };
}

/**
 * Turn parsed lines into items ready for the review screen: a date for every
 * line we recognise, and an honest "no date" for every line we do not.
 *
 * @param learned  optional map of lowercased name -> days, from past corrections
 */
export function toDrafts(parsed, learned = {}) {
  return parsed.items.map((item) => {
    const key = item.name.toLowerCase();
    const remembered = learned[key];
    const guess = estimateShelfLife(item.name);
    const days = remembered ?? guess.days;

    return {
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      amount: item.amount || '',
      raw: item.raw,
      location: guess.location,
      category: guess.category ? guess.category.key : null,
      categoryLabel: guess.category ? guess.category.label : null,
      days,
      expiry: days ? addDays(parsed.date, days) : null,
      // 'learned' beats 'guessed' beats 'unknown'; 'skip' for non-food
      confidence: guess.category && guess.category.food === false ? 'skip'
        : remembered ? 'learned' : days ? 'guessed' : 'unknown',
      include: !(guess.category && guess.category.food === false),
    };
  });
}
