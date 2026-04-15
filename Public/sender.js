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

const dropZone = document.querySelector('.file-label');

if (dropZone) {
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

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
}

// FIX #3: Only check readyState — no setTimeout guessing
function updateSendButtonState() {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  const channelReady = dataChannel && dataChannel.readyState === 'open';
  const fileReady = !!selectedFile;
  btn.disabled = !(channelReady && fileReady);
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
    showStatus('Generating PIN...', 'info');

    pc = new RTCPeerConnection({
      iceServers: [
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
      ]
    });

    setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForICE(pc);

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

      // Move to waiting step
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

  // FIX #3: This is the ONLY place we enable the send button.
  // No setTimeout, no guessing — we wait for the real open event.
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
// FILE TRANSFER — FIX #12 (Backpressure)
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

  const chunkSize = 64 * 1024;         // 64 KB per chunk
  const maxBuffer = 8 * 1024 * 1024;   // 8 MB high-water mark
  const lowWater  = 2 * 1024 * 1024;   // 2 MB low-water mark (when to resume)
  const file = selectedFile;
  let offset = 0;
  const startTime = Date.now();
  let stallGuardTimer = null;           // FIX #12: safety restart timer

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

  // Set bufferedAmountLowThreshold BEFORE sending starts
  dataChannel.bufferedAmountLowThreshold = lowWater;

  // onbufferedamountlow restarts the loop when the buffer drains
  dataChannel.onbufferedamountlow = () => {
    if (stallGuardTimer) {
      clearTimeout(stallGuardTimer);
      stallGuardTimer = null;
    }
    if (!isPaused && !isCancelled) {
      sendChunkFn();
    }
  };

  // Handlers defined once, reused by each fresh FileReader
  function onChunkLoad(e) {
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

      document.getElementById('sendStatus').textContent =
        `Sent: ${sentMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;

      sendChunkFn();
    } catch (err) {
      isTransferring = false;
      if (dataChannel.readyState !== 'open') return;
      console.error('Send error:', err);
      showStatus('Error sending file: ' + err.message, 'error');
      document.getElementById('sendBtn').disabled = false;
    }
  }

  function onChunkError() {
    showStatus('Error reading file!', 'error');
    document.getElementById('sendBtn').disabled = false;
  }

  sendChunkFn = function sendChunk() {
    if (isCancelled) return;
    if (isPaused) return;

    if (offset >= file.size) {
      try { dataChannel.send('EOF'); } catch (_) {}
      isTransferring = false;
      showStatus('✓ File sent successfully!', 'success');
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
      if (stallGuardTimer) clearTimeout(stallGuardTimer);
      return;
    }

    // Backpressure check
    if (dataChannel.bufferedAmount > maxBuffer) {
      if (!stallGuardTimer) {
        stallGuardTimer = setTimeout(() => {
          stallGuardTimer = null;
          if (!isPaused && !isCancelled && dataChannel.readyState === 'open') {
            sendChunkFn();
          }
        }, 500);
      }
      return;
    }

    // ✅ Fresh FileReader every chunk — fixes the InvalidStateError stall
    reader = new FileReader();
    reader.onload = onChunkLoad;
    reader.onerror = onChunkError;
    const slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  };

  // Kick off
  sendChunkFn();
}

// ==========================
// ICE HELPER
// ==========================
function waitForICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    const timeout = setTimeout(() => resolve(), 2000);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    };
  });
}

async function applyAnswerFromServer(answer) {
  try {
    await pc.setRemoteDescription(answer);
    isConnected = true;

    // Move to file selection step (#10)
    showStep('step-transfer');

    showStatus('✓ Connected! Select a file to send.', 'success');

    // FIX #3: Don't call updateSendButtonState here — dataChannel.onopen
    // will do it when the channel is actually ready.

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
    if (sendChunkFn) sendChunkFn();
  }
}

function cancelTransfer() {
  if (confirm('Are you sure you want to cancel this transfer?')) {
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

    document.getElementById('sendProgressFill').style.width = '0%';
    document.getElementById('sendProgressFill').textContent = '0%';
    document.getElementById('sendStatus').textContent = '';
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('pauseBtn').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'none';

    showStatus('Transfer cancelled', 'info');
  }
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