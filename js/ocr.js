/**
 * ocr.js - reading a photographed receipt on the device.
 *
 * tesseract.js runs Tesseract as WebAssembly in a worker, so the photo never
 * leaves the phone. The trade is accuracy: till printers use thin dot-matrix
 * type on curled thermal paper, which is close to the worst case for OCR.
 * Everything downstream therefore assumes the text is wrong somewhere, and
 * the user reviews it before anything is saved.
 *
 * First run downloads roughly 12 MB (engine plus language data) and the
 * browser caches it; later scans are offline.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js';

export const LANGUAGES = {
  deu: 'German', fra: 'French', ita: 'Italian', eng: 'English',
};

let libraryPromise = null;
let worker = null;
let workerLang = null;

function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const script = document.createElement('script');
    script.src = CDN;
    script.async = true;
    script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR engine loaded but exported nothing')));
    script.onerror = () => reject(new Error('Could not download the OCR engine. It needs the network the first time; after that it is cached.'));
    document.head.appendChild(script);
  });
  return libraryPromise;
}

/**
 * Straighten out what we can before Tesseract sees it: bring the long side to
 * roughly 2000px - down for a full-resolution phone photo, and *up* for an
 * already-shrunk one, because Tesseract needs a certain letter height and a
 * small crop of a receipt falls below it - then greyscale and stretch the
 * contrast so faint thermal print separates from the paper.
 *
 * Measured on a real Coop receipt: at 675px the Menge and Preis columns came
 * out as "ih te"; upscaled to 2000px the same photo read "1 11.00 11.00 1*".
 */
export async function prepareImage(file, targetSide = 2000) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(3, targetSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;

  // Greyscale, and collect a histogram in the same pass.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const grey = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = grey;
    histogram[grey]++;
  }

  // Stretch between the 5th and 95th percentile rather than min/max, so one
  // dark fold or a blown highlight does not flatten the whole receipt.
  const total = w * h;
  let low = 0, high = 255, seen = 0;
  for (let v = 0; v < 256; v++) { seen += histogram[v]; if (seen > total * 0.05) { low = v; break; } }
  seen = 0;
  for (let v = 255; v >= 0; v--) { seen += histogram[v]; if (seen > total * 0.05) { high = v; break; } }
  const span = Math.max(high - low, 1);

  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((px[i] - low) * 255) / span));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}

/**
 * @param {File|Blob} file
 * @param {{lang?: string, onProgress?: (fraction:number, label:string)=>void}} options
 * @returns {Promise<string>} the recognised text
 */
export async function readReceipt(file, { lang = 'deu', onProgress = () => {} } = {}) {
  onProgress(0.02, 'Preparing the photo');
  const canvas = await prepareImage(file);

  onProgress(0.06, 'Loading the OCR engine');
  const Tesseract = await loadLibrary();

  if (!worker || workerLang !== lang) {
    if (worker) { await worker.terminate().catch(() => {}); worker = null; }
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress(0.2 + m.progress * 0.75, 'Reading the receipt');
        else if (m.progress) onProgress(0.06 + m.progress * 0.14, 'Loading language data');
      },
    });
    workerLang = lang;
    // 4 = a single column of text of variable sizes, which is what a receipt is.
    await worker.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
  }

  const { data } = await worker.recognize(canvas);
  onProgress(1, 'Done');
  return data.text || '';
}

export async function release() {
  if (worker) { await worker.terminate().catch(() => {}); worker = null; workerLang = null; }
}
