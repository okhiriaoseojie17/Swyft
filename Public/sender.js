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
// UI Helpers
// ==========================
function showStatus(message, type) {
  const el = document.getElementById('senderStatus');
  el.textContent = message;
  el.className = `status show ${type}`;
}

function handleFileSelect(isFolder) {
  const input = isFolder
    ? document.getElementById('folderInput')
    : document.getElementById('fileInput');

  const files = Array.from(input.files);
  if (!files.length) return;

  // Folder → zip
  if (isFolder) {
    zipFolder(files);
    return;
  } 

  // Multiple files → zip
  if (files.length > 1) {
     zipFolder(files);
     return;
   }

   // Single file
  selectedFile = files[0];
  updateFileInfo([selectedFile]);
  setTimeout(() => updateSendButtonState(), 300);

  const fileInfo = document.getElementById('fileInfo');
  
  if (files.length === 1) {
    // Single file
    const sizeMB = (files[0].size / (1024 * 1024)).toFixed(2);
    const sizeGB = (files[0].size / (1024 * 1024 * 1024)).toFixed(2);
    const displaySize = files[0].size > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;
    fileInfo.innerHTML = `<strong>${files[0].name}</strong><br>Size: ${displaySize}`;
  } else {
    // Multiple files
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
    const displaySize = totalSize > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;
    fileInfo.innerHTML = `<strong>${files.length} files selected</strong><br>Total size: ${displaySize}`;
  }
  
  fileInfo.classList.add('show');

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

    // Folder OR multiple files → ZIP
   if (files.length === 1 && files[0].size === 0) {
  showStatus(
    '⚠️ Folder drag not supported. Use "Select Folder" button.',
    'error'
  );
  return;
}

// Multiple files → ZIP
if (files.length > 1) {
  await zipFolder(files);
  return;
}

    // Single file
    selectedFile = files[0];
    updateFileInfo([selectedFile]);

    if (dataChannel && dataChannel.readyState === 'open') {
      document.getElementById('sendBtn').disabled = false;
    }
  });
}

function updateSendButtonState() {
  const btn = document.getElementById('sendBtn');
  btn.disabled = !(selectedFile && dataChannel && dataChannel.readyState === 'open');
}

// ==========================
// ZIP FOLDER (GLOBAL)
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

      // ⏳ Ensure socket is connected before emitting
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
// sender.js - Update inside setupDataChannel()
function setupDataChannel() {
  dataChannel = pc.createDataChannel('file');
  dataChannel.binaryType = 'arraybuffer';

 dataChannel.onopen = () => {
  showStatus('Data channel open', 'success');

  // 🔥 FORCE BUTTON CHECK AGAIN WHEN CHANNEL OPENS
  setTimeout(() => {
    updateSendButtonState();
  }, 300);
};

  dataChannel.onclose = () => showStatus('Connection closed', 'info');
  dataChannel.onerror = () => showStatus('Data channel error', 'error');

  // ✅ ADDED: Listen for messages from Receiver (specifically "CANCEL")
  dataChannel.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data === 'CANCEL') {
      isCancelled = true;
      isTransferring = false;
      
      // Abort file reading
      if (reader && reader.readyState === FileReader.LOADING) {
        reader.abort();
      }

      showStatus('❌ Receiver cancelled the transfer', 'error');
      
      // Reset UI
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
// FILE TRANSFER (ROBUST)
// ==========================
// File Transfer with Proper Flow Control for Large Files
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

  const chunkSize = 64 * 1024; // 64KB
  const maxBuffer = 16 * 1024 * 1024; // 16MB backpressure threshold
  const file = selectedFile;
  let offset = 0;
  const startTime = Date.now();

  // Prepare UI
  document.getElementById('sendProgress').classList.add('show');
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('pauseBtn').style.display = 'inline-block';
  document.getElementById('cancelBtn').style.display = 'inline-block';

  // Send file metadata first
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
    
    sendChunkFn = function sendChunk() {
    if (isCancelled) return;
    if (isPaused) return;
    if (offset >= file.size) {
      dataChannel.send('EOF');
      isTransferring = false;
      showStatus('✓ File sent successfully!', 'success');
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
      return;
    }

    // Check for backpressure
    if (dataChannel.bufferedAmount > maxBuffer) {
      // Wait for bufferedamountlow event
      return;
    }

    const slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  }

  reader.onload = e => {
    if (isCancelled) return;

    try {
      dataChannel.send(e.target.result);
      offset += e.target.result.byteLength;

      // Update progress
      const percent = Math.round((offset / file.size) * 100);
      document.getElementById('sendProgressFill').style.width = percent + '%';
      document.getElementById('sendProgressFill').textContent = percent + '%';

      const sentMB = (offset / (1024 * 1024)).toFixed(2);
      const totalMB = (file.size / (1024 * 1024)).toFixed(2);
      const elapsedTime = (Date.now() - startTime) / 1000;
      const speed = (offset / (1024 * 1024)) / elapsedTime;

      document.getElementById('sendStatus').textContent =
        `Sent: ${sentMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;

      // Send next chunk
      sendChunkFn();
    } catch (err) {
      isTransferring = false;
      if (dataChannel.readyState !== 'open') {
      console.error('Send error:', err);
      showStatus('Error sending file: ' + err.message, 'error');
      document.getElementById('sendBtn').disabled = false;
      }
    }
  };

  reader.onerror = () => {
    showStatus('Error reading file!', 'error');
    document.getElementById('sendBtn').disabled = false;
  };

  // Backpressure handler
  dataChannel.onbufferedamountlow = () => {
    if (!isPaused && !isCancelled && sendChunkFn) {
    sendChunkFn();
  }
  };
  dataChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4MB threshold

  // Start sending
  sendChunkFn();
}


// ==========================
// ICE HELPER (Updated for Speed)
// ==========================
function waitForICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    // specific check: wait for complete OR 2 seconds max
    const timeout = setTimeout(() => {
      resolve();
    }, 2000); 

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
    // ✅ Show file transfer UI
    document.getElementById('fileTransferSection').style.display = 'block';

    // Update connection UI
    document.querySelector('#connectionStatus .spinner').style.display = 'none';
    document.getElementById('statusText').textContent = '✓ Connected!';
    showStatus('✓ Connected via PIN!', 'success');

    // Enable send button if file already selected
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

    if (sendChunkFn) {
      setTimeout(() => sendChunkFn(), 0); // ✅ restart loop
    }
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

    // Send cancel signal
    try {
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send('CANCEL');
      }
    } catch (e) {
      console.log('Could not send cancel signal');
    }
    // Reset UI
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

function sendSingleFile(file, index, total) {
  const metadata = {
    type: 'metadata',
    name: file.name,
    size: file.size,
    path: file.webkitRelativePath || file.name,
    index,
    total
  };

  dataChannel.send(JSON.stringify(metadata));
  // ⬇️ keep your existing chunk logic here unchanged
}

function updateFileInfo(files) {
  const fileInfo = document.getElementById('fileInfo');

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


