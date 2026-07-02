// Global variables
let referenceFile = null;
let matchFile = null;
let testId = null;
let selectedEmployeeId = null;
let testMode = 'match'; // match, checkin, checkout
let cameraStreams = {
    reference: null,
    match: null,
    realtime: null
};
let realtimeInterval = null;
let isRealtimeRunning = false;

// Load employees on page load
document.addEventListener('DOMContentLoaded', function() {
    loadEmployees();
});

// Tab switching
function switchTab(section, tab) {
    // Hide all tabs in section
    const employeeTab = document.getElementById(`${section}-employee-tab`);
    const uploadTab = document.getElementById(`${section}-upload-tab`);
    const cameraTab = document.getElementById(`${section}-camera-tab`);
    const realtimeTab = document.getElementById(`${section}-realtime-tab`);
    
    // Hide all
    if (employeeTab) employeeTab.classList.add('hidden');
    if (uploadTab) uploadTab.classList.add('hidden');
    if (cameraTab) cameraTab.classList.add('hidden');
    if (realtimeTab) realtimeTab.classList.add('hidden');
    
    // Show selected
    if (tab === 'employee' && employeeTab) {
        employeeTab.classList.remove('hidden');
    } else if (tab === 'upload' && uploadTab) {
        uploadTab.classList.remove('hidden');
    } else if (tab === 'camera' && cameraTab) {
        cameraTab.classList.remove('hidden');
    } else if (tab === 'realtime' && realtimeTab) {
        realtimeTab.classList.remove('hidden');
    }
    
    // Update button styles
    const buttons = event.target.parentElement.querySelectorAll('button');
    buttons.forEach(btn => {
        btn.classList.remove('border-b-2', 'border-brown-600', 'font-medium');
        btn.classList.add('hover:text-white');
    });
    
    event.target.classList.add('border-b-2', 'border-brown-600', 'font-medium');
    event.target.classList.remove('hover:text-white');
}

// Load employees list
async function loadEmployees() {
    try {
        const response = await fetch('/admin/api/karyawan/list');
        const data = await response.json();
        
        if (data.success) {
            const select = document.getElementById('employeeSelect');
            select.innerHTML = '<option value="">-- Pilih Karyawan --</option>';
            
            data.data.forEach(emp => {
                const option = document.createElement('option');
                option.value = emp.id;
                option.textContent = `${emp.nama} (${emp.nik})`;
                option.dataset.employee = JSON.stringify(emp);
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading employees:', error);
        showAlert('danger', 'Gagal memuat daftar karyawan');
    }
}

// Load employee reference
async function loadEmployeeReference() {
    const select = document.getElementById('employeeSelect');
    const selectedOption = select.options[select.selectedIndex];
    
    if (!selectedOption.value) {
        document.getElementById('employeeReferenceInfo').classList.add('hidden');
        document.getElementById('modeSelection').classList.add('hidden');
        selectedEmployeeId = null;
        testId = null;
        return;
    }
    
    selectedEmployeeId = selectedOption.value;
    const employee = JSON.parse(selectedOption.dataset.employee);
    
    try {
        // Get employee face reference
        const response = await fetch(`/admin/api/karyawan/${selectedEmployeeId}/face-reference`);
        const data = await response.json();
        
        if (data.success && data.data) {
            // Generate test token for this employee
            const tokenResponse = await fetch('/admin/api/karyawan/generate-test-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ employeeId: selectedEmployeeId })
            });
            
            const tokenData = await tokenResponse.json();
            
            if (!tokenData.success) {
                showAlert('danger', 'Gagal generate token untuk testing');
                return;
            }
            
            testId = `employee_${selectedEmployeeId}_${Date.now()}`;
            
            // Store employee reference and token globally for testing
            global.testReferences = global.testReferences || {};
            global.testReferences[testId] = {
                employeeId: selectedEmployeeId,
                employeeName: employee.nama,
                employeeNik: employee.nik,
                testToken: tokenData.data.token,
                faces: JSON.parse(data.data.faces_data),
                uploadTime: data.data.upload_time,
                isEmployee: true
            };
            
            // Show reference info
            document.getElementById('employeeReferenceDetails').innerHTML = `
                <p><strong class="text-white">Nama:</strong> ${employee.nama}</p>
                <p><strong class="text-white">NIK:</strong> ${employee.nik}</p>
                <p><strong class="text-white">Wajah Terdeteksi:</strong> ${JSON.parse(data.data.faces_data).length}</p>
                <p><strong class="text-white">Upload:</strong> ${new Date(data.data.upload_time).toLocaleString('id-ID')}</p>
                <p><strong class="text-white">Test Token:</strong> <span class="text-xs text-brown-400">Generated</span></p>
            `;
            document.getElementById('employeeReferenceInfo').classList.remove('hidden');
            
            // Show mode selection
            document.getElementById('modeSelection').classList.remove('hidden');
            
            // Update status
            document.getElementById('referenceStatus').innerHTML = `
                <div class="mb-4 p-4 bg-green-900/30 border border-green-600/50 rounded-lg">
                    <i class="fas fa-check-circle text-green-500 mr-2"></i> 
                    <span class="text-green-300">Referensi karyawan ${employee.nama} berhasil dimuat dengan test token</span>
                </div>
            `;
            
            showAlert('success', `Referensi karyawan ${employee.nama} berhasil dimuat`);
        } else {
            showAlert('danger', 'Karyawan belum memiliki foto referensi');
            document.getElementById('employeeReferenceInfo').classList.add('hidden');
            document.getElementById('modeSelection').classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading employee reference:', error);
        showAlert('danger', 'Gagal memuat referensi karyawan');
    }
}

// Change test mode
function changeTestMode(mode) {
    testMode = mode;
    
    const titles = {
        match: 'Cocokkan Wajah',
        checkin: 'Simulasi Clock In',
        checkout: 'Simulasi Clock Out'
    };
    
    const descriptions = {
        match: 'Upload foto untuk dicocokkan dengan foto referensi karyawan',
        checkin: 'Simulasi proses clock in dengan validasi wajah dan lokasi',
        checkout: 'Simulasi proses clock out dengan validasi wajah dan lokasi'
    };
    
    document.getElementById('matchTitle').textContent = titles[mode];
    document.getElementById('matchDescription').textContent = descriptions[mode];
}

// File input handlers
document.getElementById('referenceInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        referenceFile = file;
        showPreview('reference', file);
    }
});

document.getElementById('matchInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        matchFile = file;
        showPreview('match', file);
    }
});

// Show image preview
function showPreview(type, file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const previewDiv = document.getElementById(`${type}Preview`);
        previewDiv.innerHTML = `
            <div class="mt-4 p-4 bg-dark-700 rounded-lg border border-brown-600/30">
                <h5 class="text-white font-medium mb-3">Preview:</h5>
                <img src="${e.target.result}" class="w-full max-w-md rounded-lg border-2 border-brown-600 mx-auto" alt="Preview">
            </div>
        `;
    };
    reader.readAsDataURL(file);
}

// Camera functions
async function startCamera(type) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 }
            } 
        });
        
        const video = document.getElementById(`${type}Video`);
        video.srcObject = stream;
        cameraStreams[type] = stream;
        
        // Show/hide buttons
        document.getElementById(`${type}CaptureBtn`).classList.remove('hidden');
        document.getElementById(`${type}StopBtn`).classList.remove('hidden');
        
        showAlert('success', 'Kamera berhasil dibuka');
    } catch (error) {
        console.error('Error accessing camera:', error);
        showAlert('danger', 'Gagal mengakses kamera: ' + error.message);
    }
}

function stopCamera(type) {
    if (cameraStreams[type]) {
        cameraStreams[type].getTracks().forEach(track => track.stop());
        cameraStreams[type] = null;
        
        const video = document.getElementById(`${type}Video`);
        video.srcObject = null;
        
        // Hide buttons
        document.getElementById(`${type}CaptureBtn`).classList.add('hidden');
        document.getElementById(`${type}StopBtn`).classList.add('hidden');
        
        showAlert('info', 'Kamera ditutup');
    }
}

function capturePhoto(type) {
    const video = document.getElementById(`${type}Video`);
    const canvas = document.getElementById(`${type}Canvas`);
    const context = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0);
    
    // Show canvas
    canvas.classList.remove('hidden');
    
    // Convert to blob
    canvas.toBlob(function(blob) {
        const file = new File([blob], `captured-${type}-${Date.now()}.jpg`, { type: 'image/jpeg' });
        
        if (type === 'reference') {
            referenceFile = file;
        } else {
            matchFile = file;
        }
        
        showPreview(type, file);
        showAlert('success', 'Foto berhasil diambil');
    }, 'image/jpeg', 0.95);
}

// Upload reference
async function uploadReference() {
    if (!referenceFile) {
        showAlert('danger', 'Pilih foto referensi terlebih dahulu');
        return;
    }
    
    const formData = new FormData();
    formData.append('reference', referenceFile);
    
    showLoading(true);
    
    try {
        const response = await fetch('/admin/api/test/upload-reference', {
            method: 'POST',
            body: formData
        });
        
        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Server tidak mengembalikan JSON. Mungkin session expired.');
        }
        
        const data = await response.json();
        
        if (data.success) {
            testId = data.data.testId;
            
            document.getElementById('referenceResult').innerHTML = `
                <div class="mt-4 p-4 bg-dark-700 rounded-lg border border-brown-600/30">
                    <h5 class="text-white font-medium mb-3"><i class="fas fa-check-circle text-green-500 mr-2"></i> Upload Berhasil!</h5>
                    <div class="text-brown-300 space-y-2">
                        <p><strong class="text-white">Test ID:</strong> ${data.data.testId}</p>
                        <p><strong class="text-white">Wajah Terdeteksi:</strong> ${data.data.facesDetected}</p>
                    </div>
                    ${renderFaces(data.data.faces)}
                </div>
            `;
            
            document.getElementById('referenceStatus').innerHTML = `
                <div class="mb-4 p-4 bg-green-900/30 border border-green-600/50 rounded-lg">
                    <i class="fas fa-check-circle text-green-500 mr-2"></i> 
                    <span class="text-green-300">Foto referensi sudah diupload. Anda bisa melakukan pencocokan wajah.</span>
                </div>
            `;
            
            showAlert('success', 'Foto referensi berhasil diupload!');
        } else {
            showAlert('danger', data.message || 'Gagal upload foto referensi');
        }
    } catch (error) {
        console.error('Error:', error);
        if (error.message.includes('session expired')) {
            showAlert('danger', 'Session expired. Silakan refresh halaman.');
        } else {
            showAlert('danger', 'Terjadi kesalahan: ' + error.message);
        }
    } finally {
        showLoading(false);
    }
}

// Match face
async function matchFace() {
    if (!testId) {
        showAlert('danger', 'Upload foto referensi terlebih dahulu');
        return;
    }

    if (!matchFile) {
        showAlert('danger', 'Pilih foto untuk dicocokkan');
        return;
    }

    const formData = new FormData();
    formData.append('photo', matchFile);
    formData.append('testId', testId);

    // Check if using employee mode
    const testReference = global.testReferences ? global.testReferences[testId] : null;
    const isEmployeeMode = testReference && testReference.isEmployee;

    showLoading(true);

    try {
        let endpoint = '/admin/api/test/match-face';
        let headers = {};

        // If employee mode with clock in/out simulation
        if (isEmployeeMode && (testMode === 'checkin' || testMode === 'checkout')) {
            // Use actual attendance API with test token
            endpoint = testMode === 'checkin' ? '/api/attendance/checkin' : '/api/attendance/checkout';
            headers['Authorization'] = `Bearer ${testReference.testToken}`;
            
            // Add mock location (office location)
            formData.append('latitude', '-6.200000');
            formData.append('longitude', '106.816666');
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            if (testMode === 'checkin' || testMode === 'checkout') {
                // Display clock in/out result
                document.getElementById('matchResult').innerHTML = `
                    <div class="mt-4 p-4 bg-dark-700 rounded-lg border border-brown-600/30">
                        <h5 class="text-white font-medium mb-4">
                            <i class="fas ${testMode === 'checkin' ? 'fa-sign-in-alt' : 'fa-sign-out-alt'} text-green-500 mr-2"></i> 
                            ${testMode === 'checkin' ? 'Clock In' : 'Clock Out'} Berhasil!
                        </h5>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div class="text-brown-300">
                                <p><strong class="text-white">Karyawan:</strong> ${testReference.employeeName}</p>
                                <p><strong class="text-white">NIK:</strong> ${testReference.employeeNik}</p>
                                <p><strong class="text-white">Waktu:</strong> ${new Date(data.data.clockInTime || data.data.clockOutTime).toLocaleString('id-ID')}</p>
                                <p><strong class="text-white">Status:</strong> <span class="px-2 py-1 rounded text-xs ${data.data.status === 'on_time' ? 'bg-green-900/50 text-green-300' : 'bg-yellow-900/50 text-yellow-300'}">${data.data.status}</span></p>
                            </div>
                            <div class="text-brown-300">
                                <p><strong class="text-white">Face Match:</strong> ${data.data.faceMatch.isMatch ? 'Cocok' : 'Tidak Cocok'}</p>
                                <p><strong class="text-white">Similarity:</strong> ${(data.data.faceMatch.similarity * 100).toFixed(2)}%</p>
                                <p><strong class="text-white">Lokasi:</strong> ${data.data.location.isValid ? 'Valid' : 'Invalid'}</p>
                                <p><strong class="text-white">Jarak:</strong> ${data.data.location.distance}m</p>
                            </div>
                        </div>
                        ${testMode === 'checkout' && data.data.workDuration ? `
                            <div class="p-3 bg-dark-900 rounded-lg border border-brown-600/30">
                                <p class="text-brown-300"><strong class="text-white">Durasi Kerja:</strong> ${data.data.workDuration}</p>
                                ${data.data.overtimeMinutes > 0 ? `<p class="text-brown-300"><strong class="text-white">Overtime:</strong> ${data.data.overtimeMinutes} menit</p>` : ''}
                            </div>
                        ` : ''}
                    </div>
                `;
            } else {
                // Display regular match result
                document.getElementById('matchResult').innerHTML = `
                    <div class="mt-4 p-4 bg-dark-700 rounded-lg border border-brown-600/30">
                        <h5 class="text-white font-medium mb-4"><i class="fas fa-search text-brown-400 mr-2"></i> Hasil Pencocokan</h5>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div class="text-brown-300">
                                <p><strong class="text-white">Wajah Terdeteksi:</strong> ${data.data.facesDetected}</p>
                                <p><strong class="text-white">Wajah Cocok:</strong> ${data.data.summary.matchedFaces}</p>
                            </div>
                            <div class="text-brown-300">
                                <p><strong class="text-white">Rata-rata Similarity:</strong> ${(data.data.summary.averageSimilarity * 100).toFixed(2)}%</p>
                                <p><strong class="text-white">Similarity Tertinggi:</strong> ${(data.data.summary.highestSimilarity * 100).toFixed(2)}%</p>
                            </div>
                        </div>
                        ${renderMatchResults(data.data.matchResults)}
                    </div>
                `;
            }

            showAlert('success', testMode === 'match' ? 'Pencocokan wajah selesai!' : `${testMode === 'checkin' ? 'Clock in' : 'Clock out'} berhasil!`);
        } else {
            showAlert('danger', data.message || 'Gagal melakukan pencocokan');
        }
    } catch (error) {
        console.error('Error:', error);
        showAlert('danger', 'Terjadi kesalahan: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Render faces
function renderFaces(faces) {
    if (!faces || faces.length === 0) {
        return '<p class="text-brown-300">Tidak ada wajah terdeteksi</p>';
    }
    
    return faces.map((face, index) => `
        <div class="mt-3 p-3 bg-dark-900 rounded-lg border border-brown-600/20">
            <h6 class="text-white font-medium mb-2">Wajah #${index + 1}</h6>
            <div class="text-brown-300 text-sm space-y-1">
                <p><strong class="text-white">Confidence:</strong> ${(face.confidence * 100).toFixed(2)}%</p>
                <p><strong class="text-white">Bounding Box:</strong> 
                    x: ${face.box.xMin}, y: ${face.box.yMin}, 
                    width: ${face.box.width}, height: ${face.box.height}
                </p>
            </div>
        </div>
    `).join('');
}

// Render match results
function renderMatchResults(results) {
    if (!results || results.length === 0) {
        return '<p class="text-brown-300">Tidak ada hasil pencocokan</p>';
    }
    
    return results.map((result, index) => `
        <div class="mt-3 p-4 bg-dark-900 rounded-lg border ${result.isMatch ? 'border-green-600/50' : 'border-red-600/50'}">
            <div class="flex justify-between items-center mb-3">
                <h6 class="text-white font-medium">Wajah #${index + 1}</h6>
                <span class="px-3 py-1 rounded-full text-sm font-medium ${result.isMatch ? 'bg-green-900/50 text-green-300 border border-green-600/50' : 'bg-red-900/50 text-red-300 border border-red-600/50'}">
                    ${result.isMatch ? 'COCOK' : 'TIDAK COCOK'}
                </span>
            </div>
            <div class="text-brown-300 text-sm space-y-2">
                <p><strong class="text-white">Similarity:</strong> ${(result.similarity * 100).toFixed(2)}%</p>
                <p><strong class="text-white">Confidence:</strong> ${result.confidence}</p>
                <p><strong class="text-white">Threshold:</strong> ${(result.threshold * 100).toFixed(2)}%</p>
                <div class="mt-2 w-full bg-dark-700 rounded-full h-4 overflow-hidden">
                    <div class="h-full ${result.isMatch ? 'bg-green-600' : 'bg-red-600'} flex items-center justify-center text-white text-xs font-medium" 
                         style="width: ${(result.similarity * 100).toFixed(2)}%">
                        ${(result.similarity * 100).toFixed(2)}%
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Show loading
function showLoading(show) {
    const loading = document.getElementById('loading');
    if (show) {
        loading.classList.remove('hidden');
    } else {
        loading.classList.add('hidden');
    }
}

// Show alert
function showAlert(type, message) {
    const colors = {
        success: 'bg-green-900/30 border-green-600/50 text-green-300',
        danger: 'bg-red-900/30 border-red-600/50 text-red-300',
        info: 'bg-blue-900/30 border-blue-600/50 text-blue-300'
    };
    
    const icons = {
        success: 'fa-check-circle',
        danger: 'fa-exclamation-circle',
        info: 'fa-info-circle'
    };
    
    const alertDiv = document.createElement('div');
    alertDiv.className = `fixed top-20 right-4 z-50 p-4 rounded-lg border ${colors[type]} shadow-lg max-w-md fade-in`;
    alertDiv.innerHTML = `
        <div class="flex items-center justify-between">
            <div class="flex items-center">
                <i class="fas ${icons[type]} mr-3"></i>
                <span>${message}</span>
            </div>
            <button onclick="this.parentElement.parentElement.remove()" class="ml-4 text-white hover:text-brown-300">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    document.body.appendChild(alertDiv);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Drag and drop support
['referenceInput', 'matchInput'].forEach(inputId => {
    const input = document.getElementById(inputId);
    const uploadArea = input.parentElement;
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, () => {
            uploadArea.classList.add('border-brown-400', 'bg-dark-700');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, () => {
            uploadArea.classList.remove('border-brown-400', 'bg-dark-700');
        }, false);
    });
    
    uploadArea.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(files[0]);
            input.files = dataTransfer.files;
            input.dispatchEvent(new Event('change'));
        }
    }, false);
});


// Real-time matching functions
async function startRealTimeMatching() {
    if (!testId) {
        showAlert('danger', 'Upload foto referensi terlebih dahulu');
        return;
    }
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 }
            } 
        });
        
        const video = document.getElementById('realtimeVideo');
        video.srcObject = stream;
        cameraStreams.realtime = stream;
        
        // Show/hide buttons
        document.getElementById('startRealtimeBtn').classList.add('hidden');
        document.getElementById('stopRealtimeBtn').classList.remove('hidden');
        
        isRealtimeRunning = true;
        
        // Update status
        document.getElementById('realtimeStatus').innerHTML = `
            <i class="fas fa-check-circle text-green-400 mr-2"></i>
            <span class="text-green-300">Real-time matching aktif - Wajah akan dicocokkan setiap 2 detik</span>
        `;
        
        // Start matching every 2 seconds
        realtimeInterval = setInterval(performRealtimeMatch, 2000);
        
        showAlert('success', 'Real-time matching dimulai');
    } catch (error) {
        console.error('Error accessing camera:', error);
        showAlert('danger', 'Gagal mengakses kamera: ' + error.message);
    }
}

function stopRealTimeMatching() {
    if (cameraStreams.realtime) {
        cameraStreams.realtime.getTracks().forEach(track => track.stop());
        cameraStreams.realtime = null;
        
        const video = document.getElementById('realtimeVideo');
        video.srcObject = null;
        
        // Clear interval
        if (realtimeInterval) {
            clearInterval(realtimeInterval);
            realtimeInterval = null;
        }
        
        isRealtimeRunning = false;
        
        // Show/hide buttons
        document.getElementById('startRealtimeBtn').classList.remove('hidden');
        document.getElementById('stopRealtimeBtn').classList.add('hidden');
        
        // Clear overlay
        document.getElementById('realtimeOverlay').innerHTML = '';
        
        // Update status
        document.getElementById('realtimeStatus').innerHTML = `
            <i class="fas fa-info-circle text-blue-400 mr-2"></i>
            <span class="text-blue-300">Real-time matching dihentikan</span>
        `;
        
        showAlert('info', 'Real-time matching dihentikan');
    }
}

async function performRealtimeMatch() {
    if (!isRealtimeRunning) return;
    
    const video = document.getElementById('realtimeVideo');
    const canvas = document.getElementById('realtimeCanvas');
    const context = canvas.getContext('2d');
    
    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw current frame
    context.drawImage(video, 0, 0);
    
    // Convert to blob
    canvas.toBlob(async function(blob) {
        const formData = new FormData();
        formData.append('photo', blob, 'realtime-frame.jpg');
        formData.append('testId', testId);
        
        try {
            const response = await fetch('/admin/api/test/match-face', {
                method: 'POST',
                body: formData
            });
            
            // Check if response is JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                console.error('Real-time match: Server returned non-JSON response');
                return;
            }
            
            const data = await response.json();
            
            if (data.success) {
                updateRealtimeResults(data.data);
                drawFaceBoxes(data.data.matchResults, video);
            }
        } catch (error) {
            console.error('Real-time match error:', error);
        }
    }, 'image/jpeg', 0.8);
}

function updateRealtimeResults(data) {
    const resultsDiv = document.getElementById('realtimeResults');
    
    if (data.facesDetected === 0) {
        resultsDiv.innerHTML = `
            <p class="text-brown-300">
                <i class="fas fa-search mr-2"></i> Tidak ada wajah terdeteksi
            </p>
        `;
        return;
    }
    
    const matchedCount = data.summary.matchedFaces;
    const avgSimilarity = (data.summary.averageSimilarity * 100).toFixed(2);
    const highestSimilarity = (data.summary.highestSimilarity * 100).toFixed(2);
    
    resultsDiv.innerHTML = `
        <div class="grid grid-cols-3 gap-4 text-center">
            <div class="p-3 bg-dark-900 rounded-lg border border-brown-600/30">
                <div class="text-2xl font-bold text-brown-400">${data.facesDetected}</div>
                <div class="text-xs text-brown-300 mt-1">Wajah Terdeteksi</div>
            </div>
            <div class="p-3 bg-dark-900 rounded-lg border ${matchedCount > 0 ? 'border-green-600/50' : 'border-red-600/50'}">
                <div class="text-2xl font-bold ${matchedCount > 0 ? 'text-green-400' : 'text-red-400'}">${matchedCount}</div>
                <div class="text-xs text-brown-300 mt-1">Wajah Cocok</div>
            </div>
            <div class="p-3 bg-dark-900 rounded-lg border border-brown-600/30">
                <div class="text-2xl font-bold text-brown-400">${highestSimilarity}%</div>
                <div class="text-xs text-brown-300 mt-1">Similarity Tertinggi</div>
            </div>
        </div>
    `;
}

function drawFaceBoxes(matchResults, video) {
    const overlay = document.getElementById('realtimeOverlay');
    overlay.innerHTML = '';
    
    if (!matchResults || matchResults.length === 0) return;
    
    const videoRect = video.getBoundingClientRect();
    const scaleX = videoRect.width / video.videoWidth;
    const scaleY = videoRect.height / video.videoHeight;
    
    matchResults.forEach((result, index) => {
        // Get box from result.face.box or result.box
        const faceBox = result.face?.box || result.box;
        if (!faceBox) {
            console.log('No box data for face', index, result);
            return;
        }
        
        const box = document.createElement('div');
        box.className = 'absolute border-4 rounded-lg pointer-events-none';
        box.style.left = (faceBox.xMin * scaleX) + 'px';
        box.style.top = (faceBox.yMin * scaleY) + 'px';
        box.style.width = (faceBox.width * scaleX) + 'px';
        box.style.height = (faceBox.height * scaleY) + 'px';
        
        if (result.isMatch) {
            box.style.borderColor = '#10b981';
            box.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
        } else {
            box.style.borderColor = '#ef4444';
            box.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        }
        
        // Add label
        const label = document.createElement('div');
        label.className = 'absolute -top-7 left-0 px-2 py-1 rounded text-xs font-medium text-white';
        label.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        label.textContent = result.isMatch 
            ? `${(result.similarity * 100).toFixed(1)}%` 
            : `${(result.similarity * 100).toFixed(1)}%`;
        
        box.appendChild(label);
        overlay.appendChild(box);
    });
}
