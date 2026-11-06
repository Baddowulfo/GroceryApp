import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCode, parseGs1Date, parseElementString, parseDigitalLink,
  gtinCheckDigitValid, normaliseGtin, daysUntil,
} from '../js/gs1.js';

const GS = '\x1D';
const NOW = new Date('2026-09-05T12:00:00Z');   // fixed clock, so tests do not rot

// Known-good real EAN-13s, used so the check-digit tests mean something.
const COKE = '5449000000996';
const FABER = '4006381333931';

test('check digits', () => {
  assert.ok(gtinCheckDigitValid(COKE));
  assert.ok(gtinCheckDigitValid(FABER));
  assert.ok(gtinCheckDigitValid('0' + COKE));            // GTIN-14 form
  assert.ok(!gtinCheckDigitValid('5449000000997'));
  assert.equal(normaliseGtin(COKE), '0' + COKE);
  assert.equal(normaliseGtin('96385074'), '000000' + '96385074');
});

test('dates: plain, end of month, century pivot', () => {
  assert.equal(parseGs1Date('270131', NOW), '2027-01-31');
  assert.equal(parseGs1Date('261200', NOW), '2026-12-31');   // DD=00 -> end of month
  assert.equal(parseGs1Date('280200', NOW), '2028-02-29');   // leap year
  assert.equal(parseGs1Date('250101', NOW), '2025-01-01');   // recent past
  assert.equal(parseGs1Date('750101', NOW), '2075-01-01');   // 49 ahead -> still ahead
  assert.equal(parseGs1Date('770101', NOW), '1977-01-01');   // 51 ahead -> previous century
  assert.equal(parseGs1Date('991231', NOW), '1999-12-31');
  assert.equal(parseGs1Date('261332', NOW), null);           // impossible month
  assert.equal(parseGs1Date('260231', NOW), null);           // 31 February
  assert.equal(parseGs1Date('26013', NOW), null);            // too short
});

test('digital link: canonical form with expiry in the query', () => {
  const r = parseCode(`https://id.gs1.org/01/0${COKE}/10/ABC123?17=270131&3103=000355`, { now: NOW });
  assert.equal(r.format, 'digital-link');
  assert.equal(r.gtin, '0' + COKE);
  assert.ok(r.gtinValid);
  assert.equal(r.expiry, '2027-01-31');
  assert.equal(r.expiryAi, '17');
  assert.equal(r.lot, 'ABC123');
  assert.equal(r.netWeight, 0.355);                          // 3103 -> 3 decimals
});

test('digital link: qualifiers, custom domain path prefix, extra query params', () => {
  const r = parseCode(`https://brand.example/en/products/01/0${COKE}/22/2A/10/L99/21/S7?17=261200&utm_source=pack`, { now: NOW });
  assert.equal(r.gtin, '0' + COKE);
  assert.equal(r.lot, 'L99');
  assert.equal(r.serial, 'S7');
  assert.equal(r.expiry, '2026-12-31');
  assert.equal(r.segments.find((s) => s.ai === '22').value, '2A');
});

test('digital link: legacy convenience alphas still decode', () => {
  const r = parseCode(`https://example.com/gtin/0${COKE}/lot/XY?exp=270228`, { now: NOW });
  assert.equal(r.gtin, '0' + COKE);
  assert.equal(r.lot, 'XY');
  assert.equal(r.expiry, '2027-02-28');
});

test('digital link: URL that carries no GS1 data', () => {
  const r = parseCode('https://example.com/about-us', { now: NOW });
  assert.equal(r.gtin, null);
  assert.ok(r.warnings.length > 0);
});

test('element string: fixed-length AIs need no separator', () => {
  const r = parseCode(`01${'0' + COKE}17270131`, { now: NOW });
  assert.equal(r.format, 'element-string');
  assert.equal(r.gtin, '0' + COKE);
  assert.equal(r.expiry, '2027-01-31');
});

test('element string: variable field terminated by GS, with symbology prefix', () => {
  const r = parseCode(`]d201${'0' + COKE}10LOT-42${GS}17270131`, { now: NOW });
  assert.equal(r.symbology, 'GS1 DataMatrix');
  assert.equal(r.lot, 'LOT-42');
  assert.equal(r.expiry, '2027-01-31');
});

test('element string: final variable field runs to the end', () => {
  const r = parseCode(`01${'0' + COKE}1727013110LOT-42`, { now: NOW });
  assert.equal(r.expiry, '2027-01-31');
  assert.equal(r.lot, 'LOT-42');
});

test('element string: keyboard-wedge separators are accepted', () => {
  const a = parseCode(`01${'0' + COKE}10LOT1<GS>17270131`, { now: NOW });
  const b = parseCode(`01${'0' + COKE}10LOT1^17270131`, { now: NOW });
  assert.equal(a.lot, 'LOT1');
  assert.equal(a.expiry, '2027-01-31');
  assert.deepEqual([b.lot, b.expiry], ['LOT1', '2027-01-31']);
});

test('element string: best-before (15) is used when there is no 17', () => {
  const r = parseCode(`01${'0' + COKE}15270131`, { now: NOW });
  assert.equal(r.expiry, '2027-01-31');
  assert.equal(r.expiryAi, '15');
  assert.equal(r.bestBefore, '2027-01-31');
});

test('element string: 17 wins over 15 when both are present', () => {
  const r = parseCode(`01${'0' + COKE}15270101172702281`, { now: NOW });
  assert.equal(r.expiry, '2027-02-28');
  assert.equal(r.bestBefore, '2027-01-01');
});

test('element string: expiry date and time (7003)', () => {
  const r = parseCode(`01${'0' + COKE}70032701311830`, { now: NOW });
  assert.equal(r.expiry, '2027-01-31');
  assert.equal(r.expiryTime, '18:30');
});

test('element string: unknown AI is reported but does not stop the parse', () => {
  const r = parseCode(`01${'0' + COKE}88FOO${GS}17270131`, { now: NOW });
  assert.equal(r.expiry, '2027-01-31');
  assert.ok(r.warnings.some((w) => w.includes('88')));
});

test('plain linear barcode: GTIN only', () => {
  const r = parseCode(COKE, { now: NOW });
  assert.equal(r.format, 'plain-gtin');
  assert.equal(r.gtin, '0' + COKE);
  assert.equal(r.expiry, null);
});

test('bad input is handled without throwing', () => {
  for (const bad of ['', null, undefined, 'hello world', '12345', '!!!', 'ftp://x/01/123']) {
    const r = parseCode(bad, { now: NOW });
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('a wrong check digit is flagged but the code still parses', () => {
  const r = parseCode('01' + '05449000000997' + '17270131', { now: NOW });
  assert.equal(r.expiry, '2027-01-31');
  assert.equal(r.gtinValid, false);
  assert.ok(r.warnings.some((w) => w.includes('check digit')));
});

test('daysUntil', () => {
  assert.equal(daysUntil('2026-09-05', NOW), 0);
  assert.equal(daysUntil('2026-09-08', NOW), 3);
  assert.equal(daysUntil('2026-09-01', NOW), -4);
  assert.equal(daysUntil(null, NOW), null);
});
