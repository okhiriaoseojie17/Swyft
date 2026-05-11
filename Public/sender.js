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
// STEP NAVIGATION
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
    isConnected = false;
    isTransferring = false;
    isPaused = false;
    isCancelled = false;
    dataChannel = null;
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }

    socket.off('answer-ready');
    socket.off('ice-candidate');

    showStatus('Generating PIN...', 'info');

    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const iceRes = await fetch('https://swyft-q8lf.onrender.com/ice-servers');
      iceServers = await iceRes.json();
      console.log('ICE servers loaded:', iceServers.length, 'entries');
    } catch (e) {
      console.warn('Could not fetch ICE servers, using STUN only:', e.message);
    }

    pc = new RTCPeerConnection({ iceServers });

    // Log connection state changes so we can see what's happening
    pc.onconnectionstatechange = () => {
      console.log('pc.connectionState:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        showStatus('✓ Connected! Select a file to send.', 'success');
        updateSendButtonState();
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log('pc.iceConnectionState:', pc.iceConnectionState);
    };

    setupDataChannel();

    // Trickle ICE: send candidates to the server as they arrive,
    // but only after we have a PIN to tag them with
    pc.onicecandidate = (event) => {
      if (event.candidate && currentPIN) {
        socket.emit('ice-candidate', { pin: currentPIN, candidate: event.candidate });
      }
    };

    socket.on('ice-candidate', async ({ candidate }) => {
      try {
        if (candidate && pc) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // KEY FIX: wait for ICE gathering to complete before sending the offer.
    // Without this the offer has no candidates and the connection never opens.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        pc.onicegatheringstatechange = () => {
          console.log('iceGatheringState:', pc.iceGatheringState);
          if (pc.iceGatheringState === 'complete') resolve();
        };
        // Safety timeout: if gathering stalls after 5s, send whatever we have
        setTimeout(resolve, 5000);
      }
    });

    if (!socket.connected) {
      showStatus('Connecting to server...', 'info');
      await new Promise((resolve) => socket.once('connect', resolve));
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
    isConnected = true;
    showStatus('✓ Connected! Select a file to send.', 'success');
    // FIX: Now that channel is open, re-check button state —
    // selectedFile may already be set if user picked before connecting
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
 
    // Handle receiver-initiated disconnect
    if (typeof e.data === 'string' && e.data === 'DISCONNECT') {
      handleRemoteDisconnect();
    }
  };
}
 
// ==========================
// REMOTE DISCONNECT HANDLER
// ==========================
function handleRemoteDisconnect() {
  isConnected = false;
  isTransferring = false;
  isPaused = false;
  isCancelled = true;
 
  if (reader && reader.readyState === FileReader.LOADING) {
    reader.abort();
  }
 
  try { if (dataChannel) dataChannel.close(); } catch (_) {}
  try { if (pc) pc.close(); } catch (_) {}
 
  selectedFile = null;
  currentPIN = null;
  dataChannel = null;
  pc = null;
 
  socket.off('answer-ready');
  socket.off('ice-candidate');
 
  document.getElementById('pinCode').textContent = '------';
  showStep('step-pin');
  showStatus('Receiver ended the connection', 'info');
}
 
// ==========================
// FILE TRANSFER
// ==========================
function sendFile() {
  isPaused = false;
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
 
  const chunkSize = 256 * 1024;
  const maxBuffer = 16 * 1024 * 1024;
  const lowWater  = 4 * 1024 * 1024;
  const file = selectedFile;
  let offset = 0;
  const startTime = Date.now();
  let isReading = false;
 
  document.getElementById('sendProgress').classList.add('show');
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('pauseBtn').style.display = 'inline-block';
  document.getElementById('cancelBtn').style.display = 'inline-block';
 
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
    if (isReading) return;
 
    if (offset >= file.size) {
      try { dataChannel.send('EOF'); } catch (_) {}
      isTransferring = false;
      showStatus('✓ File sent successfully!', 'success');
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('cancelBtn').style.display = 'none';
      return;
    }
 
    if (dataChannel.bufferedAmount > maxBuffer) return;
 
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
 
async function applyAnswerFromServer(answer) {
  try {
    await pc.setRemoteDescription(answer);
    isConnected = true;
 
    showStep('step-transfer');
    showStatus('✓ Connected! Select a file to send.', 'success');
    // FIX: dataChannel.onopen fires after ICE + DTLS complete, which happens
    // after setRemoteDescription. Don't call updateSendButtonState() here
    // because the channel isn't open yet — onopen will call it when ready.
 
  } catch (err) {
    isTransferring = false;
    console.error('Error applying answer:', err);
    showStatus('Connection error: ' + err.message, 'error');
  }
}
 
// ==========================
// BACK BUTTON
// ==========================
function goBack() {
  if (isTransferring) {
    showStatus('❌ Cannot leave while file transfer is in progress!', 'error');
    return;
  }
 
  try {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send('DISCONNECT');
      // FIX: Delay closing so the DISCONNECT message transmits before teardown
      setTimeout(() => {
        try { dataChannel.close(); } catch (_) {}
        try { if (pc) pc.close(); } catch (_) {}
      }, 300);
    } else {
      if (pc) pc.close();
    }
  } catch (e) {
    console.log('Cleanup error on back:', e);
  }
 
  setTimeout(() => { window.location.href = 'index.html'; }, 350);
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
 
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('folderInput').value = '';
  document.getElementById('fileInfo').classList.remove('show');
  document.getElementById('fileInfo').innerHTML = '';
 
  document.getElementById('sendProgress').classList.remove('show');
  document.getElementById('sendProgressFill').style.width = '0%';
  document.getElementById('sendProgressFill').textContent = '0%';
  document.getElementById('sendStatus').textContent = '';
 
  document.getElementById('sendBtn').disabled = true;
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
 
// ==========================
// END CONNECTION
// ==========================
function endConnection() {
  if (isTransferring) {
    if (!confirm('A transfer is in progress. End connection anyway?')) return;
  }

  // FIX: Send DISCONNECT first, then delay teardown so the message
  // has time to reach the receiver before the channel/PC closes
  try {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send('DISCONNECT');
      setTimeout(() => {
        try { dataChannel.close(); } catch (_) {}
        try { if (pc) pc.close(); } catch (_) {}
      }, 300);
    } else {
      try { if (pc) pc.close(); } catch (_) {}
    }
  } catch (e) {
    console.log('Error closing connection:', e);
  }
 
  // Remove socket listeners to avoid stale handlers on reconnect
  socket.off('answer-ready');
  socket.off('ice-candidate');
 
  // Reset all state
  isConnected = false;
  isTransferring = false;
  isPaused = false;
  isCancelled = false;
  selectedFile = null;
  currentPIN = null;
  dataChannel = null;
  pc = null;
 
  // Reset UI
  document.getElementById('pinCode').textContent = '------';
  showStep('step-pin');
  showStatus('Connection ended', 'info');
}