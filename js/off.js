/**
 * off.js - product names from Open Food Facts.
 *
 * A GS1 code carries an expiry date but no product name, so a GTIN alone
 * reads as a 14 digit number. Open Food Facts is an open database with good
 * coverage of European supermarket products and permissive CORS, so a
 * single fetch turns "07613039398034" into "Nescafe Gold, 200 g".
 *
 * Results (including misses) are cached in local storage, so each product is
 * only ever looked up once.
 */

import { cachedProduct, cacheProduct } from './store.js';

const ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'product_name,product_name_de,product_name_fr,generic_name,brands,quantity,image_front_small_url,image_small_url,categories_tags';
const MISS_TTL = 1000 * 60 * 60 * 24 * 30;   // retry a miss after a month

/** Open Food Facts is keyed by the barcode as printed, not the padded GTIN-14. */
function lookupKeys(gtin14) {
  const trimmed = gtin14.replace(/^0+/, '');
  const keys = new Set([trimmed]);
  if (trimmed.length <= 13) keys.add(trimmed.padStart(13, '0'));
  if (trimmed.length <= 12) keys.add(trimmed.padStart(12, '0'));
  if (trimmed.length <= 8) keys.add(trimmed.padStart(8, '0'));
  keys.add(gtin14);
  return [...keys];
}

function pickName(p) {
  return p.product_name || p.product_name_de || p.product_name_fr || p.generic_name || '';
}

/**
 * @returns {Promise<{name, brand, quantity, image, found} | null>}
 */
export async function lookupProduct(gtin, { signal } = {}) {
  if (!gtin) return null;

  const cached = cachedProduct(gtin);
  if (cached && (cached.found || Date.now() - cached.fetchedAt < MISS_TTL)) return cached;

  for (const key of lookupKeys(gtin)) {
    try {
      const res = await fetch(`${ENDPOINT}${encodeURIComponent(key)}.json?fields=${FIELDS}`, {
        signal, headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status !== 1 || !data.product) continue;

      const p = data.product;
      const product = {
        found: true,
        name: pickName(p).trim(),
        brand: (p.brands || '').split(',')[0].trim(),
        quantity: (p.quantity || '').trim(),
        image: p.image_front_small_url || p.image_small_url || '',
        categories: (p.categories_tags || []).slice(0, 4),
      };
      if (!product.name && !product.brand) continue;
      cacheProduct(gtin, product);
      return product;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // offline or blocked - fall through and record a miss
    }
  }

  const miss = { found: false, name: '', brand: '', quantity: '', image: '' };
  cacheProduct(gtin, miss);
  return miss;
}

/**
 * Rough shelf-life guess from the product's Open Food Facts categories, used
 * only to preselect a sensible date in the manual entry sheet.
 */
const CATEGORY_DAYS = [
  [/fresh-?(fish|seafood)|raw-?meat|minced|hackfleisch/, 2],
  [/fresh-?(meat|poultry|chicken)|sausages/, 3],
  [/salads|fresh-?herbs|berries|mushrooms/, 4],
  [/milk|yogurt|yoghurt|fresh-?dairy|cream/, 7],
  [/breads|viennoiseries|pastries/, 4],
  [/fruits|vegetables/, 7],
  [/cheeses/, 14],
  [/eggs/, 21],
  [/frozen/, 180],
  [/canned|preserves|dried|pasta|rice|cereals|flour|sugar|coffee|tea|spices/, 365],
  [/beverages|waters|sodas/, 180],
];

export function guessShelfLife(categories = []) {
  const joined = categories.join(' ');
  for (const [pattern, days] of CATEGORY_DAYS) if (pattern.test(joined)) return days;
  return null;
}
