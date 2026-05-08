// ==========================
// WebRTC + File Transfer
// ==========================
let pc;
let dataChannel;
let selectedFile = null;
let socket = io('https://swyft-q8lf.onrender.com');
socket.on('connect', () => {
  console.log('✅ Connected to signaling server:', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('❌ Socket connection error:', err.message);
});

let currentPIN = null;
let isPaused = false;
let isCancelled = false;
let reader = null;
let isConnected = false;
let isTransferring = false;
let sendChunkFn = null;

// ==========================
// STEP NAVIGATION (#10)
// ==========================
function showStep(stepId) {
  document.querySelectorAll('.step-page').forEach(el => {
    el.classList.remove('step-active');
    el.classList.add('step-hidden');
  });
  const target = document.getElementById(stepId);
  if (target) {
    target.classList.remove('step-hidden');
    target.classList.add('step-active');
  }
}

// ==========================
// UI Helpers
// ==========================
function showStatus(message, type) {
  const el = document.getElementById('senderStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `status show ${type}`;
}

function handleFileSelect(isFolder) {
  const input = isFolder
    ? document.getElementById('folderInput')
    : document.getElementById('fileInput');

  const files = Array.from(input.files);
  if (!files.length) return;

  if (isFolder) {
    zipFolder(files);
    return;
  }

  if (files.length > 1) {
    zipFolder(files);
    return;
  }

  selectedFile = files[0];
  updateFileInfo([selectedFile]);
  updateSendButtonState();

  document.getElementById('sendProgress').classList.add('show');
}

// FIX #2 — Use event delegation instead of querySelector at parse time
// (the .file-label element is inside a hidden step when the script first runs)
document.addEventListener('dragover', e => {
  if (!e.target.closest('.file-label')) return;
  e.preventDefault();
  e.target.closest('.file-label').classList.add('drag-over');
});

document.addEventListener('dragleave', e => {
  if (!e.target.closest('.file-label')) return;
  e.target.closest('.file-label').classList.remove('drag-over');
});

document.addEventListener('drop', async e => {
  if (!e.target.closest('.file-label')) return;
  e.preventDefault();
  e.target.closest('.file-label').classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;

  if (files.length === 1 && files[0].size === 0) {
    showStatus('⚠️ Folder drag not supported. Use "Select Folder" button.', 'error');
    return;
  }

  if (files.length > 1) {
    await zipFolder(files);
    return;
  }

  selectedFile = files[0];
  updateFileInfo([selectedFile]);
  updateSendButtonState();
});

function updateSendButtonState() {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  
  const channelReady = dataChannel && dataChannel.readyState === 'open';
  const fileReady = selectedFile !== null;
  
  btn.disabled = !(channelReady && fileReady);
  
  // Debug log
  console.log('Button state:', { channelReady, fileReady, disabled: btn.disabled });
}

// ==========================
// ZIP FOLDER
// ==========================
async function zipFolder(files) {
  showStatus('Zipping files...', 'info');

  const zip = new JSZip();

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    zip.file(path, file);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });

  const zipFile = new File(
    [zipBlob],
    'archive.zip',
    { type: 'application/zip' }
  );

  selectedFile = zipFile;
  updateFileInfo([zipFile]);
  updateSendButtonState();
  showStatus('ZIP ready to send', 'success');
}

// ==========================
// PIN GENERATION
// ==========================
async function generatePIN() {
  try {
    // FIX #2 — Reset all stale state from any previous session
    isConnected = false;
    isTransferring = false;
    isPaused = false;
    isCancelled = false;
    selectedFile = null;
    dataChannel = null;
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }

    showStatus('Generating PIN...', 'info');

    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:openrelay.metered.ca:80' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelay',
          credential: 'openrelay'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelay',
          credential: 'openrelay'
        }
      ],
    });

    setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    pc.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit('ice-candidate', { pin: currentPIN, candidate: event.candidate });
  }
};

socket.on('ice-candidate', async ({ candidate }) => {
  try {
    if (candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Error adding received ICE candidate:', err);
  }
});

    if (!socket.connected) {
      showStatus('Connecting to server...', 'info');
      await new Promise((resolve) => {
        socket.once('connect', resolve);
      });
    }

    socket.emit('create-room', pc.localDescription, (res) => {
      if (!res || !res.success) {
        showStatus(res?.message || 'Server error', 'error');
        return;
      }

      currentPIN = res.pin;
      document.getElementById('pinCode').textContent = res.pin;
      document.getElementById('pinDisplay').style.display = 'block';
      showStatus(`PIN generated: ${res.pin}`, 'success');

      showStep('step-waiting');

      socket.on('answer-ready', (data) => {
        if (data.pin === currentPIN) {
          applyAnswerFromServer(data.answer);
        }
      });
    });

  } catch (err) {
    isTransferring = false;
    showStatus(err.message, 'error');
  }
}

// ==========================
// DATA CHANNEL (SENDER)
// ==========================
function setupDataChannel() {
  dataChannel = pc.createDataChannel('file');
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    showStatus('✓ Connected! Select a file to send.', 'success');
    updateSendButtonState();
  };

  dataChannel.onclose = () => showStatus('Connection closed', 'info');
  dataChannel.onerror = () => showStatus('Data channel error', 'error');

  dataChannel.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data === 'CANCEL') {
      isCancelled = true;
      isTransferring = false;

      if (reader && reader.readyState === FileReader.LOADING) {
        reader.abort();
      }

      showStatus('❌ Receiver cancelled the transfer', 'error');

      document.getElementById('sendProgressFill').style.width = '0%';
      document.getElementById('sendProgressFill').textContent = '0%';
      document.getElementById('sendStatus').textContent = 'Cancelled by peer';
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
    }
  };
}

// ==========================
// FILE TRANSFER
// ==========================
function sendFile() {
  isCancelled = false;
  isTransferring = true;

  if (!dataChannel || dataChannel.readyState !== 'open') {
    showStatus('❌ Connection not ready!', 'error');
    return;
  }

  if (!selectedFile) {
    showStatus('❌ No file selected!', 'error');
    return;
  }

  const chunkSize = 256 * 1024;        // 64 KB per chunk
  const maxBuffer = 16 * 1024 * 1024;  // 8 MB high-water mark
  const lowWater  = 4 * 1024 * 1024;  // 2 MB low-water mark
  const file = selectedFile;
  let offset = 0;
  const startTime = Date.now();
  let isReading = false;

  // UI setup
  document.getElementById('sendProgress').classList.add('show');
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('pauseBtn').style.display = 'inline-block';
  document.getElementById('cancelBtn').style.display = 'inline-block';

  // Send metadata
  const metadata = {
    type: 'metadata',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  };

  try {
    dataChannel.send(JSON.stringify(metadata));
  } catch (error) {
    isTransferring = false;
    showStatus('Error starting transfer: ' + error.message, 'error');
    document.getElementById('sendBtn').disabled = false;
    return;
  }

  reader = new FileReader();

  dataChannel.bufferedAmountLowThreshold = lowWater;

  dataChannel.onbufferedamountlow = () => {
    if (!isPaused && !isCancelled && !isReading) {
      sendChunkFn();
    }
  };

  sendChunkFn = function sendChunk() {
    if (isCancelled || isPaused) return;
    if (isReading) return; // ← critical: don't re-enter while reading
    
    if (offset >= file.size) {
      try { dataChannel.send('EOF'); } catch (_) {}
      isTransferring = false;
      showStatus('✓ File sent successfully!', 'success');
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
      return;
    }

    // If buffer full, wait for onbufferedamountlow to re-trigger us
    if (dataChannel.bufferedAmount > maxBuffer) {
      return; // onbufferedamountlow will call us again
    }

    isReading = true;
    const slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  };

  reader.onload = e => {
    isReading = false;
    if (isCancelled) return;

    try {
      dataChannel.send(e.target.result);
      offset += e.target.result.byteLength;

       const percent = Math.round((offset / file.size) * 100);
      document.getElementById('sendProgressFill').style.width = percent + '%';
      document.getElementById('sendProgressFill').textContent = percent + '%';

      const sentMB = (offset / (1024 * 1024)).toFixed(2);
      const totalMB = (file.size / (1024 * 1024)).toFixed(2);
      const elapsedTime = (Date.now() - startTime) / 1000;
      const speed = elapsedTime > 0 ? (offset / (1024 * 1024)) / elapsedTime : 0;
      const etaSec = speed > 0 ? ((file.size - offset) / (1024 * 1024)) / speed : 0;

     document.getElementById('sendStatus').textContent =
        `${sentMB} / ${totalMB} MB @ ${speed.toFixed(2)} MB/s · ETA ${Math.round(etaSec)}s`;

      if (dataChannel.bufferedAmount <= maxBuffer) {
        Promise.resolve().then(sendChunkFn);
      }

    } catch (err) {
      isTransferring = false;
      if (dataChannel.readyState !== 'open') return;
      console.error('Send error:', err);
      showStatus('Error sending file: ' + err.message, 'error');
      document.getElementById('sendBtn').disabled = false;
    }
  };

  reader.onerror = () => {
    isReading = false;
    showStatus('Error reading file!', 'error');
    document.getElementById('sendBtn').disabled = false;
  };

  sendChunkFn();
}

// After creating the offer and setting local description, send immediately:
pc.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit('ice-candidate', { pin: currentPIN, candidate: event.candidate });
  }
};

// Send offer right away — don't wait for ICE
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
socket.emit('offer', { pin: currentPIN, sdp: pc.localDescription });


async function applyAnswerFromServer(answer) {
  try {
    await pc.setRemoteDescription(answer);
    isConnected = true;

    showStep('step-transfer');
    showStatus('✓ Connected! Select a file to send.', 'success');
    updateSendButtonState();

  } catch (err) {
    isTransferring = false;
    console.error('Error applying answer:', err);
    showStatus('Connection error: ' + err.message, 'error');
  }
}

function goBack() {
  if (isTransferring) {
    showStatus('❌ Cannot leave while file transfer is in progress!', 'error');
    return;
  }
  if (isConnected && dataChannel && dataChannel.readyState === 'open') {
    showStatus('❌ Connection is still active. Close connection first.', 'error');
    return;
  }
  window.location.href = 'index.html';
}

function togglePause() {
  isPaused = !isPaused;
  const btn = document.getElementById('pauseBtn');
  if (isPaused) {
    btn.textContent = '▶️ Resume';
    btn.style.background = '#4caf50';
    showStatus('Transfer paused', 'info');
  } else {
    btn.textContent = '⏸️ Pause';
    btn.style.background = '#ff9800';
    showStatus('Resuming transfer...', 'info');
     if (sendChunkFn && !isCancelled && dataChannel && dataChannel.readyState === 'open') {
      setTimeout(() => sendChunkFn(), 0);
     }
  }
}

function cancelTransfer() {
  if (!confirm('Are you sure you want to cancel this transfer?')) return;
  
  isPaused = false;
  isCancelled = true;
  isTransferring = false;

  if (reader && reader.readyState === FileReader.LOADING) {
    reader.abort();
  }

  try {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send('CANCEL');
    }
  } catch (e) {
    console.log('Could not send cancel signal');
  }

  // Reset UI to file selection state
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('folderInput').value = '';
  document.getElementById('fileInfo').classList.remove('show');
  document.getElementById('fileInfo').innerHTML = '';
  
  document.getElementById('sendProgress').classList.remove('show');
  document.getElementById('sendProgressFill').style.width = '0%';
  document.getElementById('sendProgressFill').textContent = '0%';
  document.getElementById('sendStatus').textContent = '';
  
  document.getElementById('sendBtn').disabled = true; // no file selected now
  document.getElementById('pauseBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'none';

  showStatus('Transfer cancelled. Select another file to send.', 'info');
}

function copyPIN() {
  if (!currentPIN) return;
  navigator.clipboard.writeText(currentPIN);
  showStatus('PIN copied to clipboard', 'success');
}

function updateFileInfo(files) {
  const fileInfo = document.getElementById('fileInfo');
  if (!fileInfo) return;

  if (files.length === 1) {
    const f = files[0];
    const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
    const sizeGB = (f.size / (1024 * 1024 * 1024)).toFixed(2);
    const displaySize = f.size > 1024 ** 3 ? `${sizeGB} GB` : `${sizeMB} MB`;
    fileInfo.innerHTML = `<strong>${f.name}</strong><br>Size: ${displaySize}`;
  } else {
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    fileInfo.innerHTML = `<strong>${files.length} files</strong><br>Total: ${sizeMB} MB`;
  }

  fileInfo.classList.add('show');
}

function endConnection() {
  if (isTransferring) {
    if (!confirm('A transfer is in progress. End connection anyway?')) return;
  }
  
  try {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send('DISCONNECT');
      dataChannel.close();
    }
    if (pc) pc.close();
  } catch (e) {
    console.log('Error closing connection:', e);
  }
  
  // Reset all state
  isConnected = false;
  isTransferring = false;
  selectedFile = null;
  currentPIN = null;
  dataChannel = null;
  pc = null;
  
  // Reset UI
  document.getElementById('pinCode').textContent = '------';
  showStep('step-pin');
  showStatus('Connection ended', 'info');
}