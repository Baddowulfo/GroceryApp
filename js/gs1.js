/**
 * gs1.js - parsing of GS1 product codes.
 *
 * Handles the three things a scanner can hand us in 2026:
 *
 *   1. A GS1 Digital Link URI (the "Sunrise 2027" QR code)
 *        https://id.example.org/01/07613039398034/10/L4321?17=270131
 *   2. A GS1 element string (GS1 DataMatrix / GS1 QR / GS1-128 / DataBar),
 *      where FNC1 is transmitted as GS (0x1D) and the whole string may be
 *      prefixed with an AIM symbology identifier such as ]d2 or ]Q3
 *        ]d201076130393980341727013110L4321
 *   3. A plain EAN-13 / EAN-8 / UPC-A linear barcode - GTIN only, no dates.
 *
 * Everything is returned in one normalised shape so the app does not care
 * which carrier the data arrived in.
 */

const GS = '\x1D';

/* ------------------------------------------------------------------ *
 * Application Identifier table
 * ------------------------------------------------------------------ */

// Predefined-length AIs (GS1 General Specifications, figure 7.8.6-2).
// Key = first two digits, value = TOTAL length of AI + data.
const PREDEFINED_TOTAL = {
  '00': 20, '01': 16, '02': 16, '03': 16, '04': 18,
  '11': 8, '12': 8, '13': 8, '14': 8, '15': 8, '16': 8,
  '17': 8, '18': 8, '19': 8, '20': 4,
  '31': 10, '32': 10, '33': 10, '34': 10, '35': 10, '36': 10,
  '41': 16,
};

const T = { STR: 'string', NUM: 'number', DATE: 'date', DATETIME: 'datetime', DEC: 'decimal' };

/** code -> { label, type, max } */
export const AI_TABLE = {};

function ai(code, label, type, max) {
  AI_TABLE[code] = { code, label, type, max };
}

// --- identification keys -------------------------------------------------
ai('00', 'SSCC', T.NUM, 18);
ai('01', 'GTIN', T.NUM, 14);
ai('02', 'GTIN of contained trade items', T.NUM, 14);
ai('03', 'MTO GTIN', T.NUM, 14);
ai('10', 'Batch/Lot', T.STR, 20);
ai('21', 'Serial number', T.STR, 20);
ai('22', 'Consumer product variant', T.STR, 20);
ai('235', 'Third party controlled serial', T.STR, 28);
ai('240', 'Additional product ID', T.STR, 30);
ai('241', 'Customer part number', T.STR, 30);
ai('242', 'Made-to-order variation', T.NUM, 6);
ai('243', 'Packaging component number', T.STR, 20);
ai('250', 'Secondary serial number', T.STR, 30);
ai('251', 'Reference to source entity', T.STR, 30);
ai('253', 'GDTI', T.STR, 30);
ai('254', 'GLN extension', T.STR, 20);
ai('255', 'GCN', T.STR, 25);
ai('30', 'Variable count', T.NUM, 8);
ai('37', 'Count of trade items', T.NUM, 8);

// --- dates ---------------------------------------------------------------
ai('11', 'Production date', T.DATE, 6);
ai('12', 'Due date', T.DATE, 6);
ai('13', 'Packaging date', T.DATE, 6);
ai('15', 'Best before date', T.DATE, 6);
ai('16', 'Sell by date', T.DATE, 6);
ai('17', 'Expiration date', T.DATE, 6);
ai('7003', 'Expiration date and time', T.DATETIME, 10);
ai('7006', 'First freeze date', T.DATE, 6);
ai('7007', 'Harvest date', T.STR, 12);
ai('4324', 'Best before date and time', T.DATETIME, 10);
ai('4326', 'Release date', T.DATE, 6);

// --- measures: 31nn..36nn and 39nn are generated -------------------------
const MEASURE_GROUPS = [
  ['310', 'Net weight (kg)'], ['311', 'Length (m)'], ['312', 'Width (m)'],
  ['313', 'Height (m)'], ['314', 'Area (m2)'], ['315', 'Net volume (l)'],
  ['316', 'Net volume (m3)'],
  ['320', 'Net weight (lb)'], ['321', 'Length (in)'], ['322', 'Length (ft)'],
  ['323', 'Length (yd)'], ['324', 'Width (in)'], ['325', 'Width (ft)'],
  ['326', 'Width (yd)'], ['327', 'Height (in)'], ['328', 'Height (ft)'],
  ['329', 'Height (yd)'],
  ['330', 'Gross weight (kg)'], ['331', 'Length, logistic (m)'],
  ['332', 'Width, logistic (m)'], ['333', 'Height, logistic (m)'],
  ['334', 'Area, logistic (m2)'], ['335', 'Volume, logistic (l)'],
  ['336', 'Volume, logistic (m3)'], ['337', 'Kilograms per m2'],
  ['350', 'Area (in2)'], ['351', 'Area (ft2)'], ['352', 'Area (yd2)'],
  ['360', 'Net volume (qt)'], ['361', 'Net volume (gal)'],
  ['364', 'Net volume (in3)'], ['365', 'Net volume (ft3)'],
];
for (const [base, label] of MEASURE_GROUPS) {
  for (let d = 0; d <= 5; d++) ai(base + d, label, T.DEC, 6);
}
for (const [base, label] of [['390', 'Amount payable'], ['391', 'Amount payable + ISO currency'],
  ['392', 'Amount payable, single item'], ['393', 'Amount payable, single item + currency'],
  ['394', 'Percentage discount'], ['395', 'Amount payable per unit']]) {
  for (let d = 0; d <= 9; d++) ai(base + d, label, T.DEC, 15);
}

// --- logistics / locations ----------------------------------------------
ai('400', 'Customer PO number', T.STR, 30);
ai('401', 'GINC', T.STR, 30);
ai('402', 'GSIN', T.NUM, 17);
ai('403', 'Routing code', T.STR, 30);
for (const [code, label] of [['410', 'Ship to GLN'], ['411', 'Bill to GLN'],
  ['412', 'Purchased from GLN'], ['413', 'Ship for GLN'], ['414', 'Physical location GLN'],
  ['415', 'Invoicing party GLN'], ['416', 'Production location GLN'], ['417', 'Party GLN']]) {
  ai(code, label, T.NUM, 13);
}
ai('420', 'Ship to postal code', T.STR, 20);
ai('421', 'Ship to postal code (with ISO country)', T.STR, 12);
ai('422', 'Country of origin', T.NUM, 3);
ai('423', 'Country of initial processing', T.NUM, 15);
ai('424', 'Country of processing', T.NUM, 3);
ai('425', 'Country of disassembly', T.NUM, 15);
ai('426', 'Country covering full process chain', T.NUM, 3);
ai('427', 'Country subdivision of origin', T.STR, 3);

// --- internal / regulatory ----------------------------------------------
ai('7001', 'NATO stock number', T.NUM, 13);
ai('7002', 'Meat carcasses classification', T.STR, 30);
ai('7004', 'Active potency', T.NUM, 4);
ai('7005', 'Catch area', T.STR, 12);
ai('7008', 'Aquatic species', T.STR, 3);
ai('7009', 'Fishing gear type', T.STR, 10);
ai('7010', 'Production method', T.STR, 2);
ai('7011', 'Test by date', T.STR, 10);
for (const [code, label] of [['710', 'NHRN Germany (PZN)'], ['711', 'NHRN France (CIP)'],
  ['712', 'NHRN Spain (CN)'], ['713', 'NHRN Brazil (DRGC)'], ['714', 'NHRN Portugal (AIM)'],
  ['715', 'NHRN United States (NDC)'], ['716', 'NHRN Italy (AIC)']]) ai(code, label, T.STR, 20);
ai('8001', 'Roll products', T.NUM, 14);
ai('8002', 'Mobile phone identifier', T.STR, 20);
ai('8003', 'GRAI', T.STR, 30);
ai('8004', 'GIAI', T.STR, 30);
ai('8005', 'Price per unit of measure', T.NUM, 6);
ai('8006', 'ITIP', T.NUM, 18);
ai('8007', 'IBAN', T.STR, 34);
ai('8008', 'Date/time of production', T.STR, 12);
ai('8010', 'CPID', T.STR, 30);
ai('8011', 'CPID serial number', T.NUM, 12);
ai('8012', 'Software version', T.STR, 20);
ai('8013', 'GMN', T.STR, 25);
ai('8017', 'GSRN provider', T.NUM, 18);
ai('8018', 'GSRN recipient', T.NUM, 18);
ai('8019', 'Service relation instance number', T.NUM, 10);
ai('8020', 'Payment slip reference', T.STR, 25);
ai('8026', 'ITIP of contained items', T.NUM, 18);
ai('8110', 'Coupon code (North America)', T.STR, 70);
ai('8111', 'Loyalty points', T.NUM, 4);
ai('8112', 'Paperless coupon code', T.STR, 70);
ai('8200', 'Product URL', T.STR, 70);
for (let i = 90; i <= 99; i++) ai(String(i), 'Internal (' + i + ')', T.STR, 90);

/** AI codes that carry a date we care about, best first. */
export const EXPIRY_AIS = ['17', '7003', '15', '4324', '16'];

/* ------------------------------------------------------------------ *
 * Low level helpers
 * ------------------------------------------------------------------ */

/**
 * GS1 dates are YYMMDD. The century is inferred with the GS1 pivot rule:
 * a two-digit year 51..99 years ahead of the current year belongs to the
 * previous century. DD = 00 means "end of that month".
 * Returns an ISO yyyy-mm-dd string, or null if the value is not a date.
 */
export function parseGs1Date(value, now = new Date()) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = +value.slice(0, 2);
  const mm = +value.slice(2, 4);
  let dd = +value.slice(4, 6);
  if (mm < 1 || mm > 12) return null;

  const currentYear = now.getFullYear();
  let diff = yy - (currentYear % 100);
  if (diff >= 51) diff -= 100;
  else if (diff <= -50) diff += 100;
  const year = currentYear + diff;

  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd === 0) dd = lastDay;          // "end of month"
  else if (dd > lastDay) return null;

  return String(year).padStart(4, '0') + '-' +
         String(mm).padStart(2, '0') + '-' +
         String(dd).padStart(2, '0');
}

/** YYMMDDHHMM (AI 7003 / 4324) -> { date, time }. */
export function parseGs1DateTime(value, now = new Date()) {
  if (!/^\d{8,10}$/.test(value)) return null;
  const date = parseGs1Date(value.slice(0, 6), now);
  if (!date) return null;
  const hh = value.slice(6, 8) || '00';
  const mi = value.slice(8, 10) || '00';
  if (+hh > 23 || +mi > 59) return { date, time: null };
  return { date, time: hh + ':' + mi };
}

/** Normalise any GTIN-8/12/13/14 to 14 digits. */
export function normaliseGtin(gtin) {
  const digits = String(gtin || '').replace(/\D/g, '');
  if (!digits || digits.length > 14) return null;
  return digits.padStart(14, '0');
}

/** GS1 mod-10 check digit over a normalised (14 digit) GTIN. */
export function gtinCheckDigitValid(gtin) {
  const g = normaliseGtin(gtin);
  if (!g) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (+g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +g[13];
}

function aiLengthAt(str, pos) {
  for (const len of [4, 3, 2]) {
    if (AI_TABLE[str.substr(pos, len)]) return len;
  }
  return 0;
}

function decodeValue(code, raw, now) {
  const def = AI_TABLE[code];
  if (!def) return { raw, value: raw };
  if (def.type === T.DATE) return { raw, value: parseGs1Date(raw, now) };
  if (def.type === T.DATETIME) {
    const dt = parseGs1DateTime(raw, now);
    return { raw, value: dt ? dt.date : null, time: dt ? dt.time : null };
  }
  if (def.type === T.DEC && /^\d{4}$/.test(code)) {
    const decimals = +code[3];
    const n = +raw;
    return { raw, value: Number.isFinite(n) ? n / Math.pow(10, decimals) : null };
  }
  return { raw, value: raw };
}

/* ------------------------------------------------------------------ *
 * Element strings (GS1 DataMatrix / GS1 QR / GS1-128 / DataBar)
 * ------------------------------------------------------------------ */

const SYMBOLOGY = {
  ']d2': 'GS1 DataMatrix', ']Q3': 'GS1 QR Code', ']C1': 'GS1-128',
  ']e0': 'GS1 DataBar', ']e1': 'GS1 DataBar (composite)', ']e2': 'GS1 DataBar (composite)',
  ']E0': 'EAN-13 / UPC-A', ']E4': 'EAN-8', ']d1': 'Data Matrix', ']Q1': 'QR Code',
  ']Q2': 'QR Code', ']Q0': 'QR Code',
};

function stripSymbology(input) {
  if (input.length >= 3 && input[0] === ']') {
    const id = input.slice(0, 3);
    return { symbology: SYMBOLOGY[id] || ('Unknown (' + id + ')'), aim: id, body: input.slice(3) };
  }
  return { symbology: null, aim: null, body: input };
}

/**
 * Parse a GS1 element string into ordered AI segments.
 * Accepts GS (0x1D) as the FNC1 separator, and tolerates the common
 * keyboard-wedge substitutes <GS>, {GS} and ^.
 */
export function parseElementString(input, now = new Date()) {
  const { symbology, aim, body } = stripSymbology(String(input));
  const str = body.replace(/<GS>/gi, GS).replace(/\{GS\}/gi, GS).replace(/\^/g, GS);

  const segments = [];
  const warnings = [];
  let pos = 0;

  while (pos < str.length) {
    if (str[pos] === GS) { pos++; continue; }

    const aiLen = aiLengthAt(str, pos);

    if (!aiLen) {
      // Unknown AI: assume two digits and read to the next separator so the
      // rest of the string can still be recovered.
      const code = str.substr(pos, 2);
      if (!/^\d{2}$/.test(code)) {
        warnings.push('Stopped at position ' + pos + ': "' + str.slice(pos, pos + 8) + '" is not an application identifier.');
        break;
      }
      const end = str.indexOf(GS, pos + 2);
      const value = end === -1 ? str.slice(pos + 2) : str.slice(pos + 2, end);
      pos = end === -1 ? str.length : end + 1;
      segments.push({ ai: code, label: 'Unknown AI ' + code, known: false, raw: value, value });
      warnings.push('Unknown application identifier ' + code + '.');
      continue;
    }

    const code = str.substr(pos, aiLen);
    const total = PREDEFINED_TOTAL[code.slice(0, 2)];
    let value;

    if (total) {
      const dataLen = total - aiLen;
      value = str.substr(pos + aiLen, dataLen);
      pos += aiLen + dataLen;
      if (str[pos] === GS) pos++;          // a separator after a fixed field is legal
      if (value.length < dataLen) warnings.push('AI ' + code + ' is truncated.');
    } else {
      const end = str.indexOf(GS, pos + aiLen);
      value = end === -1 ? str.slice(pos + aiLen) : str.slice(pos + aiLen, end);
      pos = end === -1 ? str.length : end + 1;
      const def = AI_TABLE[code];
      if (def && value.length > def.max) {
        warnings.push('AI ' + code + ' is longer than the ' + def.max + ' characters allowed.');
      }
    }

    segments.push({
      ai: code,
      label: AI_TABLE[code].label,
      known: true,
      ...decodeValue(code, value, now),
    });
  }

  return { format: 'element-string', symbology, aim, segments, warnings };
}

/* ------------------------------------------------------------------ *
 * GS1 Digital Link URIs
 * ------------------------------------------------------------------ */

// Primary keys that may start a Digital Link path.
const PRIMARY_KEYS = {
  '01': 1, '8006': 1, '8013': 1, '8010': 1, '00': 1, '253': 1, '255': 1,
  '401': 1, '402': 1, '414': 1, '417': 1, '8003': 1, '8004': 1, '8017': 1, '8018': 1,
};

// Alphanumeric "convenience alphas" were removed in Digital Link 1.3, but
// codes printed before that are still in circulation, so we accept them.
const LEGACY_ALPHAS = {
  gtin: '01', itip: '8006', cpv: '22', lot: '10', ser: '21', sscc: '00',
  gdti: '253', gcn: '255', ginc: '401', gsin: '402', gln: '414', party: '417',
  glnx: '254', grai: '8003', giai: '8004', gsrnp: '8017', gsrn: '8018',
  cpid: '8010', cpsn: '8011', exp: '17', expdt: '7003', srin: '8019',
};

export function looksLikeDigitalLink(input) {
  return /^https?:\/\//i.test(String(input).trim());
}

export function parseDigitalLink(input, now = new Date()) {
  const raw = String(input).trim();
  let url;
  try { url = new URL(raw); } catch { return null; }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const segments = [];
  const warnings = [];

  // The GS1 path is the trailing run of key/value pairs; anything before it
  // (for example /gs1/ or a shop path) is the domain part and is ignored.
  let start = -1;
  for (let i = parts.length - 2; i >= 0; i -= 2) {
    const key = LEGACY_ALPHAS[parts[i].toLowerCase()] || parts[i];
    if (PRIMARY_KEYS[key]) { start = i; break; }
  }
  if (start === -1) {
    warnings.push('No GS1 primary key (for example /01/<GTIN>) found in the path.');
    return { format: 'digital-link', url: raw, origin: url.origin, segments, warnings, unrecognised: true };
  }

  let primary = null;
  for (let i = start; i + 1 < parts.length; i += 2) {
    const rawKey = parts[i];
    const code = LEGACY_ALPHAS[rawKey.toLowerCase()] || rawKey;
    let value = parts[i + 1];
    if (!AI_TABLE[code]) { warnings.push('Unknown path key "' + rawKey + '".'); continue; }
    if (code === '01' || code === '02' || code === '03') value = normaliseGtin(value) || value;
    if (!primary && PRIMARY_KEYS[code]) primary = code;
    segments.push({ ai: code, label: AI_TABLE[code].label, known: true, source: 'path', ...decodeValue(code, value, now) });
  }

  for (const [rawKey, value] of url.searchParams) {
    if (rawKey.toLowerCase().startsWith('linktype')) continue;
    const code = LEGACY_ALPHAS[rawKey.toLowerCase()] || rawKey;
    if (!AI_TABLE[code]) continue;   // non-GS1 query parameters are legal, just not ours
    segments.push({ ai: code, label: AI_TABLE[code].label, known: true, source: 'query', ...decodeValue(code, value, now) });
  }

  return { format: 'digital-link', url: raw, origin: url.origin, primary, segments, warnings };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Parse anything a scanner produced into one normalised shape.
 */
export function parseCode(input, opts = {}) {
  const now = opts.now || new Date();
  const raw = String(input == null ? '' : input).trim();

  const empty = {
    ok: false, format: 'unknown', symbology: null, raw,
    gtin: null, gtinValid: false, expiry: null, expiryAi: null, expiryKind: null,
    expiryTime: null, bestBefore: null, lot: null, serial: null,
    netWeight: null, price: null, url: null, segments: [], warnings: [],
  };
  if (!raw) return empty;

  let parsed;
  if (looksLikeDigitalLink(raw)) {
    parsed = parseDigitalLink(raw, now);
    if (!parsed) return { ...empty, warnings: ['Looked like a URL but could not be parsed.'] };
  } else if (/^(\d{8}|\d{12,14})$/.test(raw) && gtinCheckDigitValid(raw)) {
    // A plain linear barcode: GTIN only, nothing else on board.
    parsed = {
      format: 'plain-gtin', symbology: null, warnings: [],
      segments: [{ ai: '01', label: 'GTIN', known: true, raw, value: normaliseGtin(raw) }],
    };
  } else {
    parsed = parseElementString(raw, now);
    if (!parsed.segments.length) {
      return { ...empty, warnings: ['Not a GS1 code - no application identifiers recognised.'] };
    }
  }

  const out = { ...empty, ...parsed, raw, warnings: (parsed.warnings || []).slice() };
  const find = (code) => parsed.segments.find((s) => s.ai === code);

  const gtinSeg = find('01') || find('02') || find('03');
  if (gtinSeg) {
    out.gtin = normaliseGtin(gtinSeg.value);
    out.gtinValid = gtinCheckDigitValid(out.gtin);
    if (!out.gtinValid) out.warnings.push('GTIN check digit does not match.');
  }

  for (const code of EXPIRY_AIS) {
    const seg = find(code);
    if (seg && seg.value) {
      out.expiry = seg.value;
      out.expiryAi = code;
      out.expiryKind = AI_TABLE[code].label;
      out.expiryTime = seg.time || null;
      break;
    }
  }
  const bb = find('15') || find('4324');
  if (bb && bb.value) out.bestBefore = bb.value;

  const lot = find('10'); if (lot) out.lot = lot.value;
  const ser = find('21'); if (ser) out.serial = ser.value;

  const weight = parsed.segments.find((s) => /^310\d$/.test(s.ai));
  if (weight && typeof weight.value === 'number') out.netWeight = weight.value;
  const price = parsed.segments.find((s) => /^39[02]\d$/.test(s.ai));
  if (price && typeof price.value === 'number') out.price = price.value;

  out.ok = Boolean(out.gtin) || parsed.segments.length > 0;
  return out;
}

/** Days from today until an ISO date. Negative means already past. */
export function daysUntil(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}
