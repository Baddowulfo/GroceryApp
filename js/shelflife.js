/**
 * shelflife.js - turning a product name into a plausible expiry date.
 *
 * A receipt says what you bought and when. It never says when it goes off.
 * This table closes that gap: each category carries typical storage life in
 * days for the fridge, the cupboard and the freezer, plus the keywords that
 * identify it on a Swiss till receipt in German, French and English.
 *
 * The numbers are deliberately conservative for fresh food (better an early
 * nudge than a nasty surprise) and deliberately vague for dry goods, where
 * the pack date is far more accurate than anything we could guess. They are a
 * starting point the user corrects - and every correction is remembered.
 *
 * Order matters: the first category whose pattern matches wins, so specific
 * entries and false-friend traps ("Milchschokolade" is not milk) come first.
 */


/* ------------------------------------------------------------------ *
 * Spelling tolerance
 *
 * OCR and till printers disagree about umlauts: the same product reads as
 * "Rüebli", "Rueebli" or "Ruebli" depending on the day. Folding both the text
 * and the patterns into one plain-ASCII form makes all three the same word.
 * ------------------------------------------------------------------ */

const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');

function collapseDigraphs(s) {
  let previous;
  do { previous = s; s = s.replace(/ue/g, 'u').replace(/oe/g, 'o').replace(/ae/g, 'a'); }
  while (s !== previous);
  return s;
}

/** Fold arbitrary text for matching: lowercase, no accents, no ue/oe/ae. */
export const fold = (s) => collapseDigraphs(stripAccents(String(s || '')).toLowerCase());

/** Fold a regular expression the same way, so patterns and text agree. */
const foldPattern = (re) => new RegExp(collapseDigraphs(stripAccents(re.source)), re.flags);

const D = (fridge, pantry, freezer) => ({ fridge, pantry, freezer });

export const CATEGORIES = [
  /* --- traps: these must be tested before the generic word they contain --- */
  { key: 'chocolate', label: 'Chocolate', home: 'pantry', days: D(365, 365, 365),
    match: /schok|schogg|chocolat|choc\b|ovomalt|toblerone|lindt|cailler/i },
  { key: 'uht-milk', label: 'Long-life milk', home: 'pantry', days: D(14, 180, 180),
    match: /uht|haltbare?\s*milch|lait\s*uht|kondensmilch/i },
  { key: 'coconut-milk', label: 'Coconut milk', home: 'pantry', days: D(5, 540, 540),
    match: /kokosmilch|lait\s*de\s*coco|coconut\s*milk/i },
  { key: 'ice-cream', label: 'Ice cream', home: 'freezer', days: D(0, 0, 180),
    match: /glace|speiseeis|ice\s*cream|magnum|cornet/i },
  { key: 'frozen', label: 'Frozen food', home: 'freezer', days: D(1, 0, 180),
    match: /tiefk|tk[-\s]|surgel|gefrier|frozen|pizza\s*tk/i },

  /* --- highly perishable ------------------------------------------------ */
  { key: 'fish', label: 'Fresh fish', home: 'fridge', days: D(2, 0, 120),
    match: /fisch|lachs|saumon|forelle|truite|thon\b|dorade|zander|meeresfr|crevet|garnel|shrimp|poisson|seafood/i },
  { key: 'mince', label: 'Minced meat', home: 'fridge', days: D(2, 0, 90),
    match: /hackfleisch|gehackt|hackt|hache|mince[dr]?\s*meat|tatar|cipollata/i },
  { key: 'poultry', label: 'Fresh poultry', home: 'fridge', days: D(2, 0, 180),
    match: /poulet|hahnchen|huhner|huhn\b|pouletbrust|dinde|truthahn|pute\b|chicken|volaille/i },
  { key: 'meat', label: 'Fresh meat', home: 'fridge', days: D(3, 0, 180),
    match: /steak|schnitzel|kotelett|entrecote|filet|rindfleisch|schweins|kalbs|lamm|agneau|b[oœ]uf|porc|viande|fleisch(?!kase)/i },
  { key: 'berries', label: 'Berries', home: 'fridge', days: D(3, 2, 180),
    match: /erdbeer|himbeer|heidelbeer|brombeer|beeren|fraise|framboise|myrtille|berr(y|ies)/i },
  { key: 'salad', label: 'Salad and leaves', home: 'fridge', days: D(4, 0, 0),
    match: /salat|salade|rucola|roquette|nussli|spinat|epinard|lattich|batavia|lollo/i },
  { key: 'bread', label: 'Bread', home: 'pantry', days: D(7, 3, 90),
    match: /\bbrot|brotchen|gipfeli|croissant|baguette|\bpain\b|weggli|zopf|semmel|ciabatta|focaccia|fladen/i },
  { key: 'fresh-meal', label: 'Fresh ready meal', home: 'fridge', days: D(3, 0, 0),
    match: /anna'?s\s*best|fertigmen|menu\b|sandwich|wrap\b|sushi|salatschale|traiteur/i },
  { key: 'fresh-pasta', label: 'Fresh pasta', home: 'fridge', days: D(5, 0, 90),
    match: /frischteig|ravioli|tortellini|gnocchi|pate\s*fraiche/i },
  { key: 'mushrooms', label: 'Mushrooms', home: 'fridge', days: D(5, 0, 0),
    match: /champignon|pilze|steinpilz|shiitake|mushroom/i },
  { key: 'herbs', label: 'Fresh herbs', home: 'fridge', days: D(6, 0, 180),
    match: /krauter|basilikum|basilic|petersilie|persil|schnittlauch|koriander|minze|thymian|rosmarin/i },
  { key: 'cold-cuts', label: 'Cold cuts', home: 'fridge', days: D(5, 0, 60),
    match: /aufschnitt|schinken|jambon|speck|bacon|cervelat|bratwurst|wienerli|wurstchen|charcuterie|lyoner/i },
  { key: 'salami', label: 'Cured sausage', home: 'fridge', days: D(30, 14, 90),
    match: /salami|landjager|trockenfleisch|bundnerfleisch|chorizo|proscuitto|prosciutto|rohschinken/i },

  /* --- dairy ------------------------------------------------------------- */
  { key: 'milk', label: 'Milk', home: 'fridge', days: D(7, 1, 90),
    match: /milch|\blait\b|\bmilk\b|rahm|sahne|creme\s*enti|halbrahm|vollrahm/i },
  { key: 'yogurt', label: 'Yoghurt', home: 'fridge', days: D(14, 0, 0),
    match: /jogh?urt|yogourt|yaourt|skyr|kefir/i },
  { key: 'quark', label: 'Quark and cottage cheese', home: 'fridge', days: D(10, 0, 0),
    match: /quark|sere|huttenkase|cottage|blanc\s*battu/i },
  { key: 'soft-cheese', label: 'Soft cheese', home: 'fridge', days: D(10, 0, 60),
    match: /mozzarella|ricotta|frischkase|philadelphia|brie|camembert|feta|burrata|chevre|ziger/i },
  { key: 'cheese', label: 'Cheese', home: 'fridge', days: D(21, 0, 180),
    match: /kase|fromage|cheese|gruyere|emmentaler|appenzeller|parmesan|raclette|tilsiter|sbrinz|mozzarell/i },
  { key: 'butter', label: 'Butter', home: 'fridge', days: D(35, 0, 180),
    match: /butter|beurre|margarine/i },
  { key: 'eggs', label: 'Eggs', home: 'fridge', days: D(21, 7, 0),
    match: /\beier\b|\bei\b|oeufs?|\beggs?\b|freiland.?ei/i },

  /* --- fruit and vegetables --------------------------------------------- */
  // a juice is tested before its fruit, so "Apfelsaft" is not an apple
  { key: 'juice', label: 'Juice', home: 'fridge', days: D(10, 180, 0),
    match: /saft|jus\b|juice|smoothie|nektar/i },
  { key: 'banana', label: 'Bananas', home: 'pantry', days: D(7, 5, 90),
    match: /banane|banana/i },
  { key: 'avocado', label: 'Avocado', home: 'fridge', days: D(5, 3, 0),
    match: /avocado|avocat/i },
  { key: 'stone-fruit', label: 'Soft fruit', home: 'fridge', days: D(5, 3, 180),
    match: /pfirsich|nektarine|aprikose|pflaume|zwetschg|kirsche|cerise|peche|abricot|prune|trauben|raisin|feige|mango|papaya|kiwi/i },
  { key: 'apple', label: 'Apples and pears', home: 'fridge', days: D(21, 7, 0),
    match: /apfel|birne|pomme|poire|apple|pear/i },
  { key: 'citrus', label: 'Citrus', home: 'fridge', days: D(14, 7, 0),
    match: /orange|zitrone|citron|limette|mandarin|clementine|grapefruit|pampelmuse|lemon/i },
  { key: 'soft-veg', label: 'Soft vegetables', home: 'fridge', days: D(7, 3, 180),
    match: /tomate|gurke|concombre|peperoni|paprika|poivron|zucchetti|courgette|aubergine|melanzane/i },
  { key: 'brassica', label: 'Broccoli and beans', home: 'fridge', days: D(5, 0, 240),
    match: /broccoli|brokkoli|blumenkohl|chou.?fleur|bohnen|haricot|erbsen|petit\s*pois|spargel|asperge|fenchel|federkohl/i },
  { key: 'root-veg', label: 'Root vegetables', home: 'fridge', days: D(14, 7, 240),
    match: /ruebli|karotte|carotte|sellerie|celeri|lauch|poireau|kohl|chou\b|randen|betterave|kohlrabi|rande/i },
  { key: 'potato', label: 'Potatoes', home: 'pantry', days: D(21, 30, 0),
    match: /kartoffel|hardopfel|patate|pomme\s*de\s*terre|potato|susskartoffel/i },
  { key: 'onion', label: 'Onions and garlic', home: 'pantry', days: D(60, 60, 0),
    match: /zwiebel|oignon|knoblauch|\bail\b|schalotte|onion|garlic/i },

  /* --- fridge staples ---------------------------------------------------- */
  { key: 'tofu', label: 'Tofu and vegan protein', home: 'fridge', days: D(10, 0, 90),
    match: /tofu|seitan|tempeh|planted|quorn|veggie\s*burger/i },
  { key: 'dips', label: 'Fresh dips and sauces', home: 'fridge', days: D(7, 0, 60),
    match: /hummus|guacamole|\bdip\b|tzatziki|pesto\s*frisch|frischsauce|sauce\s*fraiche/i },
  { key: 'opened-condiment', label: 'Condiments', home: 'fridge', days: D(120, 365, 0),
    match: /ketchup|senf|moutarde|mayonnaise|sauce|dressing|essig|vinaigre|soja|pesto/i },

  /* --- cupboard ---------------------------------------------------------- */
  { key: 'jam', label: 'Jam and honey', home: 'pantry', days: D(180, 540, 0),
    match: /konfiture|marmelade|confiture|honig|miel|honey|nutella|aufstrich/i },
  { key: 'cereal', label: 'Cereal and muesli', home: 'pantry', days: D(0, 180, 0),
    match: /muesli|muesli|cornflakes|cereal|cereale|haferflocken|porridge|granola/i },
  { key: 'pasta', label: 'Pasta and rice', home: 'pantry', days: D(0, 540, 0),
    match: /teigwaren|spaghetti|nudeln|penne|fusilli|hörnli|hornli|pates|\breis\b|\briz\b|\brice\b|risotto|couscous|quinoa|polenta/i },
  { key: 'baking', label: 'Flour, sugar, salt', home: 'pantry', days: D(0, 540, 0),
    match: /mehl|farine|zucker|sucre|\bsalz\b|\bsel\b|backpulver|hefe|levure|starke|vanille/i },
  { key: 'oil', label: 'Oil', home: 'pantry', days: D(0, 365, 0),
    match: /(^|\s)ol\b|olivenol|sonnenblumenol|rapsol|erdnussol|huile|olive\s*oil|bratcreme/i },
  { key: 'tinned', label: 'Tinned and jarred', home: 'pantry', days: D(0, 730, 0),
    match: /konserve|\bdose\b|buchse|pelee|conserve|tin(ned)?\b|mais\b|kichererbsen|linsen|lentille|bouillon|suppe|soupe/i },
  { key: 'coffee', label: 'Coffee and tea', home: 'pantry', days: D(0, 365, 0),
    match: /kaffee|cafe|espresso|\btee\b|the\b|\btea\b|kapseln|nespresso/i },
  { key: 'snacks', label: 'Snacks and biscuits', home: 'pantry', days: D(0, 180, 0),
    match: /guetzli|biscuit|chips|cracker|nusse|noix|nuts|mandeln|studenten|popcorn|riegel|barre/i },
  { key: 'drinks', label: 'Drinks', home: 'pantry', days: D(0, 365, 0),
    match: /mineral|wasser|\beau\b|water|cola|rivella|schweppes|bier|biere|\bwein\b|\bvin\b|prosecco|sirup|energy/i },

  /* --- not food: keep it off the list ------------------------------------ */
  { key: 'non-food', label: 'Not food', home: 'other', days: D(0, 0, 0), food: false,
    match: /\bwc\b|toiletten|papier|handetuch|waschmittel|weichsp|spulmittel|seife|savon|shampoo|duschgel|zahnpasta|zahnb|deo\b|windel|tampon|binden|batterie|sack\b|tragtasche|sac\s|tasche|kehricht|entsorg|erde\b|blumenerde|pflanzerde|dunger|zeitung|glubirne|folie|alufolie|kerze|blumen|fleurs|katzen|hunde|futter|mullsack|abfallsack|putz|reinig|papiertaschent/i },
];

// Compile every pattern once, in the folded alphabet.
for (const category of CATEGORIES) category.match = foldPattern(category.match);

/** Rough guess at how a receipt line should be stored and for how long. */
export function categorise(name) {
  const text = fold(name).trim();
  if (!text) return null;
  for (const category of CATEGORIES) {
    if (category.match.test(text)) return category;
  }
  return null;
}

/**
 * @returns {{days:number|null, location:string, category:object|null, label:string}}
 */
export function estimateShelfLife(name) {
  const category = categorise(name);
  if (!category) return { days: null, location: 'fridge', category: null, label: 'not recognised' };
  if (category.food === false) return { days: null, location: 'other', category, label: 'not food' };
  const days = category.days[category.home];
  return {
    days: days || null,
    location: category.home,
    category,
    label: `${category.label} · about ${days} days in the ${category.home}`,
  };
}

/** Same category, different shelf: "what if I freeze it?" */
export function daysFor(categoryKey, location) {
  const category = CATEGORIES.find((c) => c.key === categoryKey);
  if (!category) return null;
  return category.days[location] || null;
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
