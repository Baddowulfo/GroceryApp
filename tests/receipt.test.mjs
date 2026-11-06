import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, toDrafts } from '../js/receipt.js';
import { estimateShelfLife, categorise, fold, addDays } from '../js/shelflife.js';

const NOW = new Date('2026-09-05T12:00:00Z');
const opts = { now: NOW };

const MIGROS = `MIGROS
Migros Zuerich Loewenstrasse
Tel. 044 123 45 67
                        CHF
M-Classic Vollmilch 1L        1.45
Bio Rueebli 1kg               2.90
2 x Zopf Butter 500g          7.80
Poulet Geschnetzeltes
  0.482 kg x 24.90           12.00
Naturaplan Joghurt Mocca      1.10
WC-Papier Hakle 8 Rollen      8.95
Aktion Rabatt                -1.50
------------------------------
TOTAL                        32.70
Bar                          40.00
Rueckgeld                     7.30
MWST 2.5% CHF 0.78
05.09.2026 17:42  Kasse 3
Vielen Dank fuer Ihren Einkauf`;

const COOP = `Coop Supermarkt Bahnhof
Naturaplan Bio Milch 1l    1.85 1
Prix Garantie Teigwaren    0.95 1
Cherry Tomaten 250g        2.60 1
Zwischentotal              5.40
TOTAL CHF                  5.40
Supercard Punkte             54
03.09.2026`;

const LIDL = `LIDL SCHWEIZ
VOLLMILCH 1L             1.35 A
BANANEN                  2.15 A
LACHSFILET 200G          8.90 A
Summe                   12.40
04.09.26`;

test('store and purchase date are recognised', () => {
  assert.equal(parseReceipt(MIGROS, opts).store, 'Migros');
  assert.equal(parseReceipt(MIGROS, opts).date, '2026-09-05');
  assert.equal(parseReceipt(COOP, opts).store, 'Coop');
  assert.equal(parseReceipt(COOP, opts).date, '2026-09-03');
  assert.equal(parseReceipt(LIDL, opts).store, 'Lidl');
  assert.equal(parseReceipt(LIDL, opts).date, '2026-09-04');
});

test('a receipt with no date falls back to today', () => {
  assert.equal(parseReceipt('MIGROS\nMilch 1L   1.45\n', opts).date, '2026-09-05');
});

test('totals, payment, tax, loyalty and discount lines are dropped', () => {
  const names = parseReceipt(MIGROS, opts).items.map((i) => i.name);
  for (const junk of ['TOTAL', 'Bar', 'Rueckgeld', 'MWST', 'Aktion Rabatt']) {
    assert.ok(!names.some((n) => n.toLowerCase().includes(junk.toLowerCase())), `${junk} should not be an item`);
  }
  assert.equal(names.length, 6);
});

test('quantity prefixes and weight lines are understood', () => {
  const items = parseReceipt(MIGROS, opts).items;
  const butter = items.find((i) => /Zopf/.test(i.name));
  assert.equal(butter.quantity, 2);
  assert.equal(butter.name, 'Zopf Butter 500g');

  const poulet = items.find((i) => /Poulet/.test(i.name));
  assert.equal(poulet.name, 'Poulet Geschnetzeltes');
  assert.equal(poulet.amount, '0.482 kg');
  assert.equal(poulet.price, 12);
});

test('Coop VAT codes and Lidl block capitals still parse', () => {
  const coop = parseReceipt(COOP, opts).items.map((i) => i.name);
  assert.deepEqual(coop, ['Naturaplan Bio Milch 1l', 'Prix Garantie Teigwaren', 'Cherry Tomaten 250g']);
  const lidl = parseReceipt(LIDL, opts).items.map((i) => i.name);
  assert.deepEqual(lidl, ['VOLLMILCH 1L', 'BANANEN', 'LACHSFILET 200G']);
});

test('dates come from the shelf-life table, counted from the purchase date', () => {
  const drafts = toDrafts(parseReceipt(MIGROS, opts));
  const milk = drafts.find((d) => /Vollmilch/.test(d.name));
  assert.equal(milk.category, 'milk');
  assert.equal(milk.days, 7);
  assert.equal(milk.expiry, '2026-09-12');
  assert.equal(milk.confidence, 'guessed');

  const poulet = drafts.find((d) => /Poulet/.test(d.name));
  assert.equal(poulet.expiry, '2026-09-07');       // 2 days
  assert.equal(poulet.location, 'fridge');
});

test('non-food lines are kept but unticked', () => {
  const paper = toDrafts(parseReceipt(MIGROS, opts)).find((d) => /WC-Papier/.test(d.name));
  assert.equal(paper.confidence, 'skip');
  assert.equal(paper.include, false);
  assert.equal(paper.expiry, null);
});

test('an unrecognised line is added with no date rather than a guess', () => {
  const drafts = toDrafts(parseReceipt('MIGROS\nXY-42 Spezial            3.20\n', opts));
  assert.equal(drafts[0].confidence, 'unknown');
  assert.equal(drafts[0].expiry, null);
  assert.equal(drafts[0].include, true);
});

test('a remembered correction beats the table', () => {
  const learned = { 'm-classic vollmilch 1l': 4 };
  const milk = toDrafts(parseReceipt(MIGROS, opts), learned).find((d) => /Vollmilch/.test(d.name));
  assert.equal(milk.days, 4);
  assert.equal(milk.expiry, '2026-09-09');
  assert.equal(milk.confidence, 'learned');
});

test('umlauts survive any spelling the printer or the OCR chooses', () => {
  for (const spelling of ['Rüebli', 'Rueebli', 'Ruebli', 'RUEBLI']) {
    assert.equal(categorise(spelling).key, 'root-veg', spelling);
  }
  for (const spelling of ['Käse', 'Kaese', 'Kase']) {
    assert.equal(categorise(spelling).key, 'cheese', spelling);
  }
  assert.equal(fold('Müesli'), fold('Mueesli'));
});

test('false friends are not miscategorised', () => {
  assert.equal(categorise('Milchschokolade').key, 'chocolate');
  assert.equal(categorise('Apfelsaft naturtrueb').key, 'juice');
  assert.equal(categorise('Milchbroetchen').key, 'bread');
  assert.equal(categorise('Haltbare Milch UHT').key, 'uht-milk');
  assert.equal(categorise('Kokosmilch').key, 'coconut-milk');
});

test('shelf life is measured in the right place', () => {
  assert.equal(estimateShelfLife('Lachsfilet').location, 'fridge');
  assert.equal(estimateShelfLife('Teigwaren Hoernli').location, 'pantry');
  assert.equal(estimateShelfLife('Tiefkuehlerbsen').location, 'freezer');
  assert.equal(estimateShelfLife('Kartoffeln').days, 30);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-09-05', 7), '2026-09-12');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2028-02-27', 3), '2028-03-01');   // leap year
});

test('garbage in does not throw', () => {
  for (const junk of ['', '\n\n\n', '!!! ???', 'aaaa'.repeat(500)]) {
    assert.ok(Array.isArray(parseReceipt(junk, opts).items));
  }
});

/* --------------------------------------------------------------------- *
 * A real receipt.
 *
 * This is the verbatim output of Tesseract reading a photograph of a Coop
 * receipt from Biel — smudges, "Sannelsack" for "Sammelsack" and all. It is
 * the regression test that keeps the parser honest about what OCR actually
 * produces, as opposed to what a hand-written fixture pretends it produces.
 * --------------------------------------------------------------------- */

const REAL_COOP = `Fir mich und dich.

Biel Nidaugasse

Artikel Henge . Preis Aktion Total

Universalerde 15L 1) 6.95 6.95 9

Geb. -Kehrichtsack 1 11.00 11.00 *
Geb. -Kehrichtsack 1 6.00 6.00 1*
Sannelsack 251 1 17.00 17.00 1*

TOTAL CHE
PostFinance
* Kundenbeleg ***

Buchung
PostF inag
e aN

15:40:19
31413108
Ag000001110505`;

test('a real photographed Coop receipt', () => {
  const parsed = parseReceipt(REAL_COOP, opts);

  // The logo is a picture, but the slogan is text - even misread as "Fir".
  assert.equal(parsed.store, 'Coop');

  // Four numeric columns per line: Menge, Preis, Aktion, Total. The name must
  // survive all of them, and the price taken must be the total.
  assert.deepEqual(parsed.items.map((i) => i.name),
    ['Universalerde 15L', 'Geb. -Kehrichtsack', 'Geb. -Kehrichtsack', 'Sannelsack 251']);
  assert.deepEqual(parsed.items.map((i) => i.price), [6.95, 11, 6, 17]);
  assert.deepEqual(parsed.items.map((i) => i.quantity), [1, 1, 1, 1]);

  // The column header, the total, the payment and the booking noise all go.
  const names = parsed.items.map((i) => i.name.toLowerCase()).join(' ');
  for (const junk of ['artikel', 'total', 'postfinance', 'buchung', 'kundenbeleg']) {
    assert.ok(!names.includes(junk), junk);
  }

  // Everything on this receipt is a rubbish bag or a bag of soil.
  const drafts = toDrafts(parsed);
  assert.ok(drafts.every((d) => d.confidence === 'skip' && d.include === false));
});

test('a single-price receipt keeps sizes that look like quantities', () => {
  // The column stripper must not eat the "1L" off a Migros line.
  const items = parseReceipt('MIGROS\nM-Classic Vollmilch 1L        1.45\n', opts).items;
  assert.equal(items[0].name, 'M-Classic Vollmilch 1L');
  assert.equal(items[0].quantity, 1);
});
