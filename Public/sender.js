// ==========================
// WebRTC + File Transfer
// ==========================
let pc;
let dataChannel;
let selectedFile = null;
let socket = io();
let currentPIN = null;

// ==========================
// UI Helpers
// ==========================
function showStatus(message, type) {
  const el = document.getElementById('senderStatus');
  el.textContent = message;
  el.className = `status show ${type}`;
}

function handleFileSelect() {
  const input = document.getElementById('fileInput');
  selectedFile = input.files[0];

  if (selectedFile) {
    const fileInfo = document.getElementById('fileInfo');
    const sizeMB = (selectedFile.size / (1024 * 1024)).toFixed(2);
    const sizeGB = (selectedFile.size / (1024 * 1024 * 1024)).toFixed(2);
    const displaySize = selectedFile.size > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;

    fileInfo.innerHTML = `<strong>${selectedFile.name}</strong><br>Size: ${displaySize}`;
    fileInfo.classList.add('show');  // Ensure it's displayed

    // Enable the send button when the file is selected
    if (dataChannel && dataChannel.readyState === 'open') {
      document.getElementById('sendBtn').disabled = false;
    }

    // Ensure the progress bar is shown
    document.getElementById('sendProgress').classList.add('show');
  }
}

// ==========================
// PIN GENERATION
// ==========================
async function generatePIN() {
  try {
    showStatus('Generating PIN...', 'info');

    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForICE(pc);

    socket.emit('create-room', pc.localDescription, (res) => {
      if (!res.success) {
        showStatus(res.message, 'error');
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
    showStatus(err.message, 'error');
  }
}

async function applyAnswer(answer) {
  await pc.setRemoteDescription(answer);
  showStatus('Connected! Ready to send file.', 'success');
}

// ==========================
// DATA CHANNEL (SENDER)
// ==========================
function setupDataChannel() {
  dataChannel = pc.createDataChannel('file');
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    showStatus('Data channel open', 'success');
    if (selectedFile) document.getElementById('sendBtn').disabled = false;
  };

  dataChannel.onclose = () => showStatus('Connection closed', 'info');
  dataChannel.onerror = () => showStatus('Data channel error', 'error');
}

// ==========================
// FILE TRANSFER (ROBUST)
// ==========================
// File Transfer with Proper Flow Control for Large Files
function sendFile() {
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
    showStatus('Error starting transfer: ' + error.message, 'error');
    document.getElementById('sendBtn').disabled = false;
    return;
  }

  const reader = new FileReader();

  function sendChunk() {
    if (offset >= file.size) {
      dataChannel.send('EOF');
      showStatus('✓ File sent successfully!', 'success');
      document.getElementById('sendBtn').disabled = false;
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
      sendChunk();
    } catch (err) {
      console.error('Send error:', err);
      showStatus('Error sending file: ' + err.message, 'error');
      document.getElementById('sendBtn').disabled = false;
    }
  };

  reader.onerror = () => {
    showStatus('Error reading file!', 'error');
    document.getElementById('sendBtn').disabled = false;
  };

  // Backpressure handler
  dataChannel.onbufferedamountlow = () => {
    sendChunk();
  };
  dataChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4MB threshold

  // Start sending
  sendChunk();
}


// ==========================
// ICE HELPER
// ==========================
function waitForICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') resolve();
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
  });
}

async function applyAnswerFromServer(answer) {
  try {
    await pc.setRemoteDescription(answer);

    // ✅ Show file transfer UI
    document.getElementById('fileTransferSection').style.display = 'block';

    // Update connection UI
    document.querySelector('#connectionStatus .spinner').style.display = 'none';
    document.getElementById('statusText').textContent = '✓ Connected!';
    showStatus('✓ Connected via PIN!', 'success');

    // Enable send button if file already selected
    if (selectedFile && dataChannel && dataChannel.readyState === 'open') {
      document.getElementById('sendBtn').disabled = false;
    }
  } catch (err) {
    console.error('Error applying answer:', err);
    showStatus('Connection error: ' + err.message, 'error');
  }
}

