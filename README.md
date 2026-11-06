# FreshTrack

A phone-first web app that scans product codes, reads the **expiry date straight out
of the code** where the code carries one, and keeps a list of what is in the house
sorted by what needs eating first.

Built for the switch from 1D barcodes to 2D codes ("GS1 Sunrise 2027"): the new QR
and Data Matrix codes can carry a batch number and an expiry date alongside the GTIN,
which is exactly what a spoilage tracker needs.

---

## What it does today

- **Scans** QR, GS1 Data Matrix, EAN-13/8, UPC and Code 128 through the phone camera.
- **Parses** all three things a scanner can return:
  - a GS1 Digital Link URI — `https://id.gs1.org/01/09506000134352/10/ABC-123?17=270131`
  - a GS1 element string with FNC1 separators — what a GS1 DataMatrix contains
  - a plain linear barcode — GTIN only, no date
- **Pulls the date out** — AI `17` (expiration), `15` (best before), `7003` (expiry
  date and time), including the `DD=00` "end of month" convention and the GS1 century
  pivot rule.
- **Falls back to manual entry** when the code has no date, which today is still most
  products: quick chips (+3 days, 1 week, 1 month…) and a date picker. The app
  remembers how long you usually give a given product and pre-fills it next time.
- **Names the product** by looking the GTIN up in Open Food Facts, so the list reads
  "Nescafé Gold, 200 g" rather than a 14-digit number.
- **Sorts by urgency** — past date / eat now / this week / later / no date — and tracks
  how much you ate versus binned over the last 30 days.
- **Reads receipts** — photograph a till receipt and the whole shop lands in the list
  at once. See below for how the dates are worked out.
- **Decode tab** — paste any code and see every application identifier it contains.
  This is the tool for finding out what your supermarket actually encodes.
- Works offline, installs to the home screen, stores everything **on the device only**.

## Receipts, and where their dates come from

A receipt says *what* you bought and *when*. It never says when anything goes off, so
the date has to be inferred. Four sources, in order of trust:

1. **What you corrected before.** Once you have said that Vollmilch lasts five days,
   every future receipt line with that name gets five days. Keyed by the printed line,
   because a receipt has no barcode.
2. **The shelf-life table** (`js/shelflife.js`): about 50 food categories, each with a
   typical life in the fridge, the cupboard and the freezer, matched by German, French
   and English keywords as they appear on Swiss receipts. Counted from the purchase
   date on the receipt, not from today.
3. **Nothing.** A line the table does not recognise is added with *no* date and sits in
   the "No date" group. A wrong date is worse than an honest blank.
4. **You, in the review screen.** Every line is editable before anything is saved, and
   editing one is what feeds rule 1.

Non-food lines (bags, cleaning products, toiletries) are detected and unticked, but
still shown, so nothing disappears silently.

The numbers are deliberately conservative for fresh food and deliberately vague for dry
goods, where the printed pack date is far better than any guess. Rename a line in the
review screen and it re-categorises itself as you type.

### The OCR

`tesseract.js` runs Tesseract as WebAssembly in a worker on the device — the photo is
never uploaded. The first receipt downloads about 12 MB of engine and language data,
which the browser then caches. Before recognition the image is downscaled, converted to
greyscale and contrast-stretched between the 5th and 95th percentile, so one dark fold
does not flatten the whole receipt.

**What a real receipt taught it.** The rules were fitted to an actual photographed Coop
receipt (`photos/`), and two things came out of that:

- Coop prints four numeric columns — *Artikel | Menge | Preis | Aktion | Total* — so
  after the total is taken off the end there is still a unit price, sometimes a
  promotion, and a quantity clinging to the product name. Those are stripped, but only
  when an extra price was actually found, which is what stops "M-Classic Vollmilch 1L"
  from losing its "1L" on a single-price Migros line.
- **Image size matters more than anything else.** At 675px on the long side, Tesseract
  read the Menge and Preis columns as "ih te". The same photo scaled up to 2000px read
  "1 11.00 11.00 1\*". `prepareImage` therefore scales *toward* 2000px in both
  directions rather than only shrinking large photos.

The verbatim OCR output of that receipt — smudges, "Sannelsack" for "Sammelsack" and
all — is a regression test, so the parser is measured against what OCR really produces
rather than a tidy hand-written fixture.

Thermal receipt printing is close to the worst case for OCR, so expect to correct a few
lines every time. Photograph the receipt flat and filling the frame; a receipt held up
against a busy background is what produced the "ih te" above. "Paste text instead" takes text from a digital receipt and skips OCR
entirely, and "What the reader saw" in the review screen shows the raw recognised text
when a line comes out wrong.

## Running it

The camera needs a secure context, so `file://` will not do — serve it over
`http://localhost` or real HTTPS.

```bash
# any static server works
npx serve .
# or
python -m http.server 8000
```

Then open `http://localhost:8000`. To test on your phone, put the folder on any static
host (GitHub Pages, Netlify, Cloudflare Pages) — no build step, no backend.

There is also a single-file build for hosting or sharing:

```bash
node build.mjs      # writes dist/freshtrack.html and dist/artifact.html
```

## Tests

```bash
node --test tests/*.mjs
```

32 cases. The GS1 half covers Digital Link paths and qualifiers, element strings with
and without separators, end-of-month dates, the century pivot, check digits and
malformed input. The receipt half covers Migros, Coop and Lidl layouts, weight and
quantity lines, discount and total filtering, umlaut spellings ("Rüebli" / "Rueebli" /
"Ruebli" are one word), false friends (Milchschokolade is not milk, Apfelsaft is not an
apple), and the rule that an unrecognised line gets no date.

## Layout

```
index.html            app shell
css/styles.css        all styling, light and dark
js/gs1.js             GS1 parsing — the interesting part, no dependencies
js/shelflife.js       food categories, keywords and typical storage life
js/receipt.js         receipt text -> line items -> dated drafts
js/ocr.js             tesseract.js wrapper and image preprocessing
js/store.js           local storage, learned shelf life, waste log
js/off.js             Open Food Facts lookup + category shelf-life guesses
js/scanner.js         camera, BarcodeDetector with a zxing-wasm fallback
js/app.js             UI
sw.js                 offline cache
build.mjs             single-file build (own 50-line bundler, no toolchain)
tests/                parser tests
```

## Scanning support, honestly

| Browser | Decoder | Notes |
|---|---|---|
| Chrome / Edge on Android | built-in `BarcodeDetector` | fastest path, includes Data Matrix |
| Chrome / Edge on desktop | built-in `BarcodeDetector` | good for testing with a webcam |
| Safari on iOS | zxing-wasm from a CDN | WebKit still has no Shape Detection API (bug 281848), so the app downloads a WebAssembly decoder on first use |
| anything else | "Type a code" / "Decode a photo" | always available |

## Testing without a real 2D code

Most packs in the shops still carry a plain EAN-13, so there is nothing to read a date
from yet. Two ways to try the real path:

1. **Decode tab → the sample buttons.** They contain a real Digital Link and a real
   GS1 DataMatrix payload.
2. **Make your own code.** Paste a Digital Link like
   `https://id.gs1.org/01/09506000134352/10/ABC-123?17=270131` into any QR generator,
   print or show it on a second screen, and scan it.

## Ideas for next

- Local notifications a few days before something expires (needs the notification
  permission plus a periodic background sync, or a small scheduled push service).
- More real receipts. Coop is fitted to a real one; Migros, Aldi, Lidl and Denner are
  still reconstructed. Drop photos in `photos/` and the rules can be fitted to them.
- Recipe suggestions built from what is about to expire.
- A shared household inventory — this needs a backend and is deliberately out of scope
  for the local-first version.
