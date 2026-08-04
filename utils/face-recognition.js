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
 * Gambar 68 titik landmark wajah (mata, hidung, mulut, kontur) di atas gambar.
 * Dipakai untuk visualisasi "Face Alignment" di halaman pengujian.
 * @param {string} imagePath path file gambar
 * @returns {Promise<Buffer>} buffer JPEG hasil overlay landmark
 */
async function drawFaceLandmarks(imagePath) {
  await initialize();
  const img = await loadOrientedImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const detections = await faceapi
    .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: DETECTION_MIN_CONFIDENCE }))
    .withFaceLandmarks();

  if (!detections || !detections.landmarks) {
    // Fallback: gambar apa adanya + teks "tidak terdeteksi"
    ctx.fillStyle = 'rgba(239,68,68,0.8)';
    ctx.font = `${Math.max(16, Math.round(img.width * 0.035))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Landmark tidak terdeteksi', img.width / 2, img.height / 2);
    return canvas.toBuffer('image/jpeg', { quality: 0.92 });
  }

  const { positions } = detections.landmarks;
  // 68 titik landmark face-api: 0-16 kontur rahang, 17-21 alis kanan, 22-26 alis kiri,
  // 27-30 hidung bridge, 31-35 hidung bawah, 36-41 mata kanan, 42-47 mata kiri,
  // 48-59 bibir luar, 60-67 bibir dalam
  const dotRadius = Math.max(2, Math.round(img.width * 0.004));
  const lineWidth = Math.max(1, Math.round(img.width * 0.0015));

  // Gambar titik landmark
  positions.forEach((pt, i) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, dotRadius, 0, 2 * Math.PI);
    ctx.fillStyle = '#3b82f6'; // biru
    ctx.fill();
    // Label nomor titik di landmark utama (kelipatan 5 + titik kunci)
    if (i % 5 === 0 || [0, 16, 21, 22, 26, 27, 30, 35, 36, 41, 42, 47, 48, 59, 67].includes(i)) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(8, Math.round(img.width * 0.018))}px monospace`;
      ctx.fillText(i, pt.x + dotRadius + 2, pt.y - dotRadius);
    }
  });

  // Gambar garis kontur
  function drawPolyline(indices, color, width) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || lineWidth;
    for (let i = 0; i < indices.length; i++) {
      const pt = positions[indices[i]];
      if (!pt) continue;
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  // Kontur rahang (oranye)
  drawPolyline([...Array(17).keys()], '#f97316', lineWidth * 1.5);
  // Alis kanan + kiri (kuning)
  drawPolyline([17, 18, 19, 20, 21], '#eab308', lineWidth);
  drawPolyline([22, 23, 24, 25, 26], '#eab308', lineWidth);
  // Hidung bridge + bawah (ungu)
  drawPolyline([27, 28, 29, 30], '#a855f7', lineWidth);
  drawPolyline([31, 32, 33, 34, 35], '#a855f7', lineWidth);
  // Mata kanan + kiri (hijau)
  drawPolyline([36, 37, 38, 39, 40, 41, 36], '#22c55e', lineWidth);
  drawPolyline([42, 43, 44, 45, 46, 47, 42], '#22c55e', lineWidth);
  // Bibir luar + dalam (merah)
  drawPolyline([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 48], '#ef4444', lineWidth * 1.3);
  drawPolyline([60, 61, 62, 63, 64, 65, 66, 67, 60], '#ef4444', lineWidth * 0.8);

  // Legend
  const legendY = img.height - 16;
  const legendFont = `${Math.max(10, Math.round(img.width * 0.022))}px sans-serif`;
  const items = [
    { color: '#f97316', label: 'Rahang' },
    { color: '#eab308', label: 'Alis' },
    { color: '#a855f7', label: 'Hidung' },
    { color: '#22c55e', label: 'Mata' },
    { color: '#ef4444', label: 'Bibir' }
  ];
  ctx.font = legendFont;
  ctx.textAlign = 'left';
  let lx = 8;
  items.forEach(({ color, label }) => {
    const tw = ctx.measureText(label).width + 18;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(lx, legendY - 14, tw, 20);
    ctx.fillStyle = color;
    ctx.fillRect(lx + 2, legendY - 9, 10, 10);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 15, legendY);
    lx += tw + 4;
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

/**
 * Visualisasi face encoding 128 dimensi sebagai bar chart.
 * Dipakai untuk visualisasi "Ekstraksi Encoding" di halaman pengujian.
 * @param {number[]} descriptor array 128 dimensi
 * @returns {Promise<Buffer>} buffer JPEG hasil bar chart
 */
async function generateEncodingChart(descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    const cv = createCanvas(400, 200);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ef4444';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Descriptor tidak valid (butuh 128 dimensi)', 200, 100);
    return cv.toBuffer('image/jpeg', { quality: 0.9 });
  }

  const W = 900;
  const H = 380;
  const pad = { top: 30, right: 20, bottom: 50, left: 50 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');

  // Background putih
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const barW = Math.max(1, Math.floor(chartW / 128));
  const gap = Math.max(0, barW > 3 ? 1 : 0);
  const step = barW + gap;

  // Cari min/max
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < 128; i++) {
    if (descriptor[i] < minVal) minVal = descriptor[i];
    if (descriptor[i] > maxVal) maxVal = descriptor[i];
  }
  const range = maxVal - minVal || 1;

  // Grid horizontal
  ctx.strokeStyle = '#e5e5e5';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    const val = maxVal - (range * i / 4);
    ctx.fillText(val.toFixed(2), pad.left - 6, y + 4);
  }

  // Garis nol
  const zeroY = pad.top + chartH * (maxVal / range);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();

  // Bar
  for (let i = 0; i < 128; i++) {
    const h = chartH * (Math.abs(descriptor[i]) / range);
    const x = pad.left + i * step;
    const y = descriptor[i] >= 0 ? zeroY - h : zeroY;
    const hue = (i / 128) * 280; // warna gradasi ungu ke biru
    ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
    ctx.fillRect(x, y, barW, Math.max(1, h));
  }

  // Label sumbu
  ctx.fillStyle = '#333';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Face Encoding 128 Dimensi (CNN Embedding Vector)', W / 2, H - 6);
  ctx.textAlign = 'left';
  ctx.fillText('Dimensi ke-', pad.left, H - 34);
  for (let i = 0; i <= 128; i += 32) {
    ctx.fillText(i.toString(), pad.left + i * step - 10, pad.top + chartH + 16);
  }

  return cv.toBuffer('image/jpeg', { quality: 0.92 });
}

module.exports = {
  detectFaces,
  getProbeFaces,
  compareFaces,
  drawFaceLandmarks,
  generateEncodingChart,
  initialize,
  initializeDetector
};
