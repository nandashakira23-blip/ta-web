/**
 * Face Recognition berbasis CNN (Convolutional Neural Network).
 *
 * Menggunakan @vladmandic/face-api:
 *   - SSD MobileNet v1  -> deteksi wajah
 *   - Face Landmark 68  -> penyelarasan (alignment) wajah
 *   - Face Recognition Net (CNN, arsitektur ResNet/FaceNet-style) -> menghasilkan
 *     face descriptor / embedding berdimensi 128.
 *
 * Pencocokan dilakukan dengan menghitung jarak Euclidean antar embedding 128-d
 * (semakin kecil jarak, semakin mirip). Backend TensorFlow.js memakai WASM (tanpa
 * kompilasi native, kompatibel server biasa maupun serverless).
 *
 * CATATAN: model weights sudah tersedia bawaan paket @vladmandic/face-api
 * (folder node_modules/@vladmandic/face-api/model), jadi tidak perlu diunduh manual.
 */

const path = require('path');
const sharp = require('sharp');
const canvas = require('canvas');
const { Canvas, Image, ImageData, loadImage, createCanvas } = canvas;
const wasmBackend = require('@tensorflow/tfjs-backend-wasm');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');

// Sediakan implementasi Canvas/Image untuk lingkungan Node
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Ambang jarak Euclidean antar descriptor 128-d.
// Default face-api 0.6 (semakin kecil = semakin ketat). Bisa di-override via env.
const MATCH_DISTANCE_THRESHOLD = (() => {
  const v = Number(process.env.FACE_MATCH_DISTANCE);
  return Number.isFinite(v) && v > 0 ? v : 0.6;
})();

// Confidence minimum deteksi wajah SSD MobileNet v1
const DETECTION_MIN_CONFIDENCE = (() => {
  const v = Number(process.env.FACE_DETECTION_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5;
})();

let initialized = false;
let initPromise = null;

function getModelsPath() {
  if (process.env.FACE_MODELS_PATH) return process.env.FACE_MODELS_PATH;
  const pkgDir = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
  return path.join(pkgDir, 'model');
}

function getWasmPath() {
  const distDir = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json'));
  return path.join(distDir, 'dist') + path.sep;
}

async function initialize() {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.log('Initializing CNN face recognition (face-api)...');
    wasmBackend.setWasmPaths(getWasmPath());
    await faceapi.tf.setBackend('wasm');
    await faceapi.tf.ready();

    const modelsPath = getModelsPath();
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);

    initialized = true;
    console.log(`Face recognition (CNN) ready — backend: ${faceapi.tf.getBackend()}, models: ${modelsPath}`);
  })();

  try {
    await initPromise;
  } catch (error) {
    initPromise = null; // izinkan retry pada panggilan berikutnya
    console.error('Error initializing face recognition:', error);
    throw error;
  }
}

// Nama lama dipertahankan demi kompatibilitas pemanggil.
async function initializeDetector() {
  await initialize();
  return faceapi;
}

/**
 * Deteksi wajah + ekstraksi embedding 128 dimensi.
 * @param {string} imagePath path file gambar
 * @returns {Promise<Array<{id:number, box:object, descriptor:number[], confidence:number}>>}
 */
// Load an image and auto-correct orientation. node-canvas does NOT honor EXIF orientation,
// so a phone (front-camera) selfie saved with an EXIF rotation tag would be processed sideways,
// which wrecks detection/embedding accuracy. sharp().rotate() applies the EXIF orientation.
async function loadOrientedImage(imagePath) {
  try {
    const buf = await sharp(imagePath).rotate().jpeg({ quality: 95 }).toBuffer();
    return await loadImage(buf);
  } catch (error) {
    console.warn('sharp auto-orient failed, using raw image:', error.message);
    return loadImage(imagePath);
  }
}

// Rotate an image onto a new canvas (90/180/270) for the no-EXIF rotation fallback.
function rotateToCanvas(img, deg) {
  const rad = (deg * Math.PI) / 180;
  const swap = deg === 90 || deg === 270;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return cv;
}

async function detectOnInput(input) {
  return faceapi
    .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: DETECTION_MIN_CONFIDENCE }))
    .withFaceLandmarks()
    .withFaceDescriptors();
}

async function detectFaces(imagePath) {
  await initialize();

  const img = await loadOrientedImage(imagePath);
  let detections = await detectOnInput(img);

  // Fallback: if no face is found, the image may be rotated without (or with wrong) EXIF data.
  // Try the other 3 orientations and keep the first that yields a face.
  if (detections.length === 0) {
    for (const deg of [90, 180, 270]) {
      const rotated = rotateToCanvas(img, deg);
      const d = await detectOnInput(rotated);
      if (d.length > 0) {
        console.log(`Face detected after rotating ${deg}°`);
        detections = d;
        break;
      }
    }
  }

  const faces = detections.map((det, index) => {
    const box = det.detection.box;
    return {
      id: index,
      box: {
        xMin: Math.round(box.x),
        yMin: Math.round(box.y),
        xMax: Math.round(box.x + box.width),
        yMax: Math.round(box.y + box.height),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      // Embedding 128 dimensi (Array biasa agar JSON.stringify menghasilkan array, bukan objek)
      descriptor: Array.from(det.descriptor),
      confidence: typeof det.detection.score === 'number' ? det.detection.score : 0
    };
  });

  console.log(`Detected ${faces.length} face(s) with 128-d descriptor`);
  return faces;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Bandingkan wajah hasil deteksi dengan wajah referensi berdasarkan jarak embedding.
 * Mempertahankan bentuk hasil lama agar pemanggil tidak berubah.
 */
async function compareFaces(referenceFaces, detectedFaces) {
  const results = [];
  const distanceThreshold = MATCH_DISTANCE_THRESHOLD;
  const similarityThreshold = Math.max(0, Math.min(1, 1 - distanceThreshold));

  console.log(`Comparing ${detectedFaces.length} detected vs ${referenceFaces.length} reference (max distance: ${distanceThreshold})`);

  for (let i = 0; i < detectedFaces.length; i++) {
    const detected = detectedFaces[i];
    let bestDistance = Infinity;
    let bestIndex = -1;

    for (let j = 0; j < referenceFaces.length; j++) {
      const distance = euclideanDistance(referenceFaces[j].descriptor, detected.descriptor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = j;
      }
    }

    const hasDistance = Number.isFinite(bestDistance);
    const isMatch = hasDistance && bestDistance <= distanceThreshold;
    const similarity = hasDistance ? Math.max(0, Math.min(1, 1 - bestDistance)) : 0;

    console.log(`Face ${i}: best distance=${hasDistance ? bestDistance.toFixed(3) : 'n/a'}, similarity=${(similarity * 100).toFixed(1)}% ${isMatch ? 'MATCH' : 'no match'}`);

    results.push({
      faceIndex: i,
      isMatch,
      similarity,
      distance: hasDistance ? bestDistance : null,
      confidence: isMatch ? (bestDistance <= distanceThreshold * 0.75 ? 'high' : 'medium') : 'low',
      bestMatch: bestIndex >= 0 ? {
        referenceIndex: bestIndex,
        similarity,
        distance: hasDistance ? bestDistance : null
      } : null,
      face: detected,
      threshold: similarityThreshold
    });
  }

  return results;
}

/**
 * Probe faces for MATCHING with test-time augmentation (TTA).
 * Returns the real detected face(s) PLUS a horizontally-flipped variant of the largest face.
 * Matching takes the minimum distance over these variants -> more robust to slight pose/asymmetry,
 * without changing the CNN model. (Not used for enrollment, which requires exactly one face.)
 */
async function getProbeFaces(imagePath, options = {}) {
  const { tta = true } = options;
  await initialize();
  const faces = await detectFaces(imagePath); // rotation-robust + EXIF-oriented
  if (!tta || faces.length === 0) return faces;
  try {
    const flippedBuf = await sharp(imagePath).rotate().flop().jpeg({ quality: 95 }).toBuffer();
    const img = await loadImage(flippedBuf);
    const dets = await detectOnInput(img);
    if (dets.length) {
      const d = dets.sort((a, b) =>
        (b.detection.box.width * b.detection.box.height) - (a.detection.box.width * a.detection.box.height))[0];
      const box = d.detection.box;
      faces.push({
        id: faces.length,
        box: {
          xMin: Math.round(box.x), yMin: Math.round(box.y),
          xMax: Math.round(box.x + box.width), yMax: Math.round(box.y + box.height),
          width: Math.round(box.width), height: Math.round(box.height)
        },
        descriptor: Array.from(d.descriptor),
        confidence: typeof d.detection.score === 'number' ? d.detection.score : 0,
        variant: 'flip'
      });
    }
  } catch (error) {
    console.warn('flip-TTA failed, using original only:', error.message);
  }
  return faces;
}

/**
 * Gambar 68 titik landmark wajah + bounding box di atas crop wajah.
 * Menunjukkan progression: deteksi (bounding box) → alignment (landmark).
 * Dipakai untuk visualisasi "Face Alignment" di halaman pengujian.
 * @param {string} imagePath path file gambar
 * @param {{legend?: boolean}} [opts] legend=false untuk crop kecil di dalam diagram komposit
 *   (mis. generateEncodingDiagram) — legend penuh cuma relevan saat foto ditampilkan besar sendirian.
 * @returns {Promise<Buffer>} buffer JPEG hasil overlay landmark + bounding box
 */
async function drawFaceLandmarks(imagePath, opts = {}) {
  const { legend = true } = opts;
  await initialize();
  const img = await loadOrientedImage(imagePath);

  const detections = await faceapi
    .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: DETECTION_MIN_CONFIDENCE }))
    .withFaceLandmarks();

  if (!detections || !detections.landmarks) {
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = 'rgba(239,68,68,0.8)';
    ctx.font = `${Math.max(16, Math.round(img.width * 0.035))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Landmark tidak terdeteksi', img.width / 2, img.height / 2);
    return canvas.toBuffer('image/jpeg', { quality: 0.92 });
  }

  const box = detections.detection.box;
  const { positions } = detections.landmarks;

  // Crop persegi rapat ke wajah (sama seperti stage bbox) — semua koordinat relatif ke crop
  const cx = (box.x + box.width / 2), cy = (box.y + box.height / 2);
  let side = Math.round(Math.max(box.width, box.height) * 1.35);
  side = Math.max(1, Math.min(side, img.width, img.height));
  const left = Math.max(0, Math.min(Math.round(cx - side / 2), img.width - side));
  const top = Math.max(0, Math.min(Math.round(cy - side / 2), img.height - side));
  const offsetX = -left, offsetY = -top;

  const canvas = createCanvas(side, side);
  const ctx = canvas.getContext('2d');
  // Gambar crop wajah
  ctx.drawImage(img, left, top, side, side, 0, 0, side, side);

  // ── BOUNDING BOX (hijau, sama seperti stage bbox) ──
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = Math.max(3, Math.round(side * 0.012));
  ctx.strokeRect(box.x + offsetX, box.y + offsetY, box.width, box.height);

  // ── 68 TITIK LANDMARK + GARIS KONTUR ──
  const dotRadius = Math.max(2, Math.round(side * 0.006));
  const lineWidth = Math.max(1, Math.round(side * 0.002));

  // Gambar titik landmark (koordinat disesuaikan ke crop)
  positions.forEach((pt, i) => {
    const px = pt.x + offsetX, py = pt.y + offsetY;
    ctx.beginPath();
    ctx.arc(px, py, dotRadius, 0, 2 * Math.PI);
    ctx.fillStyle = '#3b82f6';
    ctx.fill();
    if (legend && (i % 5 === 0 || [0, 16, 21, 22, 26, 27, 30, 35, 36, 41, 42, 47, 48, 59, 67].includes(i))) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(7, Math.round(side * 0.024))}px monospace`;
      ctx.fillText(i, px + dotRadius + 2, py - dotRadius);
    }
  });

  function drawPolyline(indices, color, width) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || lineWidth;
    for (let i = 0; i < indices.length; i++) {
      const pt = positions[indices[i]];
      if (!pt) continue;
      const px = pt.x + offsetX, py = pt.y + offsetY;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  drawPolyline([...Array(17).keys()], '#f97316', lineWidth * 1.5);
  drawPolyline([17, 18, 19, 20, 21], '#eab308', lineWidth);
  drawPolyline([22, 23, 24, 25, 26], '#eab308', lineWidth);
  drawPolyline([27, 28, 29, 30], '#a855f7', lineWidth);
  drawPolyline([31, 32, 33, 34, 35], '#a855f7', lineWidth);
  drawPolyline([36, 37, 38, 39, 40, 41, 36], '#22c55e', lineWidth);
  drawPolyline([42, 43, 44, 45, 46, 47, 42], '#22c55e', lineWidth);
  drawPolyline([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 48], '#ef4444', lineWidth * 1.3);
  drawPolyline([60, 61, 62, 63, 64, 65, 66, 67, 60], '#ef4444', lineWidth * 0.8);

  // Legend — satu bar tipis merata di bawah (bukan beberapa "pil" terpisah yang berdempetan)
  if (legend) {
    const barH = Math.max(20, Math.round(side * 0.075));
    ctx.fillStyle = 'rgba(17, 24, 39, 0.72)'; // slate-900 translucent
    ctx.fillRect(0, side - barH, side, barH);

    const legendFont = `${Math.max(9, Math.round(side * 0.026))}px sans-serif`;
    const items = [
      { color: '#22c55e', label: 'Box' },
      { color: '#f97316', label: 'Rahang' },
      { color: '#eab308', label: 'Alis' },
      { color: '#a855f7', label: 'Hidung' },
      { color: '#3b82f6', label: 'Mata/Bibir' }
    ];
    ctx.font = legendFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rowY = side - barH / 2;
    let lx = 8;
    items.forEach(({ color, label }) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx + 4, rowY, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(label, lx + 13, rowY + 1);
      lx += ctx.measureText(label).width + 26;
    });
    ctx.textBaseline = 'alphabetic';
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Diagram alur proses ekstraksi face encoding 128 dimensi.
 * Layout 2 kolom: Wajah (bbox + landmark) → Encoding 128-D (nilai teks).
 * Cocok untuk dokumentasi skripsi/tesis.
 * @param {string} imagePath path file gambar
 * @param {number[]} descriptor array 128 dimensi (hasil ekstraksi)
 * @returns {Promise<Buffer>} buffer JPEG diagram alur
 */
async function generateEncodingDiagram(imagePath, descriptor) {
  await initialize();

  // Minimalis sengaja: 2 kotak bersudut siku + panah, persis diagram
  // "Wajah+BBox+Landmark -> Descriptor(128-D)" yang biasa dipakai di dokumentasi
  // face-api/FaceNet. Tanpa kartu berwarna, tanpa heatmap, tanpa caption custom —
  // supaya kelihatan hasil implementasi asli, bukan ilustrasi buatan.
  const INK = '#000000';
  const BORDER = '#333333';

  const pad = 20;
  const faceSz = 260;
  const boxPadR = 18;
  const arrowW = 50;
  const rightW = 300;
  const totalW = pad + faceSz + arrowW + rightW + pad;
  const boxH = faceSz + 8;
  const totalH = pad + boxH + pad;

  const cv = createCanvas(totalW, totalH);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // ── KOTAK KIRI: foto (bbox + landmark, hasil detectSingleFace().withFaceLandmarks()) ──
  const lx = pad, ly = pad;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(lx + 0.5, ly + 0.5, faceSz, boxH);

  let faceImg;
  try {
    const faceBuf = await drawFaceLandmarks(imagePath, { legend: false });
    faceImg = await loadImage(faceBuf);
  } catch (e) {
    const img = await loadOrientedImage(imagePath);
    const tmp = createCanvas(faceSz, faceSz);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, faceSz, faceSz);
    faceImg = await loadImage(tmp.toBuffer('image/jpeg', { quality: 0.9 }));
  }
  const fw = faceImg.width, fh = faceImg.height;
  const ratio = Math.min(faceSz / fw, faceSz / fh);
  const dw = Math.round(fw * ratio), dh = Math.round(fh * ratio);
  ctx.drawImage(faceImg, lx + (faceSz - dw) / 2, ly + 4, dw, dh);

  // ── PANAH POLOS ──
  const ax = lx + faceSz, ay = ly + boxH / 2;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ax + 6, ay);
  ctx.lineTo(ax + arrowW - 10, ay);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ax + arrowW - 10, ay - 5);
  ctx.lineTo(ax + arrowW, ay);
  ctx.lineTo(ax + arrowW - 10, ay + 5);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();

  // ── KOTAK KANAN: descriptor — dicetak persis format Node.js console.log(Float32Array) ──
  const rx = lx + faceSz + arrowW, ry = ly;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rx + 0.5, ry + 0.5, rightW, boxH);

  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('Descriptor (128-D)', rx + boxPadR, ry + 30);

  if (Array.isArray(descriptor) && descriptor.length === 128) {
    const shown = 8;
    ctx.font = '11px "Courier New", monospace';
    const colW = (rightW - boxPadR * 2) / 2;
    for (let i = 0; i < shown; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const isLast = i === shown - 1;
      const val = descriptor[i].toFixed(4) + (isLast ? '' : ',');
      ctx.fillText(val, rx + boxPadR + col * colW, ry + 56 + row * 20);
    }
    // Format persis Node.js util.inspect saat array terpotong: "... N more items"
    ctx.fillStyle = '#555555';
    ctx.fillText(`... ${128 - shown} more items`, rx + boxPadR, ry + 56 + 4 * 20);
  }

  return cv.toBuffer('image/jpeg', { quality: 0.94 });
}

/**
 * Deteksi wajah + landmark (tanpa descriptor, lebih ringan).
 * Return box + positions untuk drawing.
 */
async function detectFaceWithLandmarks(imagePath) {
  await initialize();
  const img = await loadOrientedImage(imagePath);
  const detection = await faceapi
    .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: DETECTION_MIN_CONFIDENCE }))
    .withFaceLandmarks();
  if (!detection) return null;
  return {
    box: detection.detection.box,
    positions: detection.landmarks ? detection.landmarks.positions : null
  };
}

module.exports = {
  detectFaces,
  getProbeFaces,
  compareFaces,
  drawFaceLandmarks,
  generateEncodingDiagram,
  generateEncodingChart: generateEncodingDiagram,
  detectFaceWithLandmarks,
  initialize,
  initializeDetector
};
