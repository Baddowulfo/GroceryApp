/**
 * scanner.js - camera scanning.
 *
 * Two decoders, picked at runtime:
 *
 *   1. The built-in BarcodeDetector API (Chrome, Edge, Android WebView).
 *      Fast, no download, hardware accelerated.
 *   2. zxing-wasm, loaded from a CDN, for browsers without it - most
 *      importantly Safari on iOS, which still does not ship the Shape
 *      Detection API (WebKit bug 281848).
 *
 * If neither is available the app still works: paste or type the code, or
 * add the item by hand.
 */

const FORMATS_NATIVE = ['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf', 'aztec', 'pdf417'];
const FORMATS_ZXING = ['QRCode', 'DataMatrix', 'EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'ITF', 'DataBar', 'DataBarExpanded'];
const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3/dist/iife/full/index.js';

let zxingPromise = null;

function loadZxing() {
  if (zxingPromise) return zxingPromise;
  zxingPromise = new Promise((resolve, reject) => {
    if (window.ZXingWASM) return resolve(window.ZXingWASM);
    const script = document.createElement('script');
    script.src = ZXING_CDN;
    script.async = true;
    script.onload = () => (window.ZXingWASM ? resolve(window.ZXingWASM) : reject(new Error('zxing loaded but exported nothing')));
    script.onerror = () => reject(new Error('could not load the fallback decoder'));
    document.head.appendChild(script);
  });
  return zxingPromise;
}

async function makeDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS_NATIVE.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return {
          name: 'BarcodeDetector',
          canDataMatrix: formats.includes('data_matrix'),
          detect: async (source) => {
            const found = await detector.detect(source);
            return found.map((b) => ({ text: b.rawValue, format: b.format }));
          },
        };
      }
    } catch { /* fall through to zxing */ }
  }

  const zxing = await loadZxing();
  await zxing.prepareZXingModule?.({ fireImmediately: true });
  return {
    name: 'zxing-wasm',
    canDataMatrix: true,
    detect: async (source) => {
      const results = await zxing.readBarcodes(source, {
        formats: FORMATS_ZXING, tryHarder: true, maxNumberOfSymbols: 1,
      });
      return results.map((r) => ({ text: r.text, format: r.format }));
    },
  };
}

export class Scanner {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.decoder = null;
    this.running = false;
    this.lastText = '';
    this.lastAt = 0;
    this.facingMode = 'environment';
  }

  get decoderName() { return this.decoder ? this.decoder.name : null; }

  /** @param {(code:string, format:string)=>void} onResult */
  async start(onResult, onStatus = () => {}) {
    this.onResult = onResult;
    this.onStatus = onStatus;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser will not give a web page camera access. Open the app over https, or use "Type a code".');
    }

    onStatus('Preparing the decoder...');
    this.decoder = await makeDecoder();

    onStatus('Asking for the camera...');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: 1280 }, height: { ideal: 720 },
        focusMode: 'continuous',
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.running = true;
    onStatus('');
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async flip() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    const { onResult, onStatus } = this;
    this.stop();
    await this.start(onResult, onStatus);
  }

  /** Torch is only exposed on some Android devices. */
  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = track.getCapabilities?.() || {};
    if (!caps.torch) return false;
    this.torchOn = !this.torchOn;
    await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
    return this.torchOn;
  }

  async _loop() {
    if (!this.running) return;
    try {
      const source = await this._frame();
      if (source) {
        const results = await this.decoder.detect(source);
        if (results.length) this._emit(results[0]);
      }
    } catch (err) {
      if (this.running) console.debug('scan frame failed', err);
    }
    // ~8 frames a second is plenty and keeps the phone cool.
    this.timer = setTimeout(() => { this.raf = requestAnimationFrame(() => this._loop()); }, 120);
  }

  async _frame() {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h) return null;
    if (this.decoder.name === 'BarcodeDetector') return this.video;
    // zxing wants pixels
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  _emit({ text, format }) {
    if (!text) return;
    const now = Date.now();
    if (text === this.lastText && now - this.lastAt < 2500) return;   // one beep per code
    this.lastText = text;
    this.lastAt = now;
    this.onResult(text, format);
  }
}

/** Decode a still image (photo library, or a screenshot of a code). */
export async function decodeImageFile(file) {
  const decoder = await makeDecoder();
  const bitmap = await createImageBitmap(file);
  let source = bitmap;
  if (decoder.name !== 'BarcodeDetector') {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    source = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  const results = await decoder.detect(source);
  bitmap.close?.();
  return results.length ? results[0].text : null;
}

/** Short vibration + click so a scan is felt, not just seen. */
export function feedback(ok = true) {
  try { navigator.vibrate?.(ok ? 40 : [30, 60, 30]); } catch { /* not supported */ }
}
