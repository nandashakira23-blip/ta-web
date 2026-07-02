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

module.exports = {
  detectFaces,
  getProbeFaces,
  compareFaces,
  initialize,
  initializeDetector
};
