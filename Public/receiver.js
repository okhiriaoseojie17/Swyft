// ==========================
// WebRTC + Socket
// ==========================
let pc;
let socket = io('https://swyft-q8lf.onrender.com');

socket.on('connect', () => {
  console.log('✅ Receiver connected:', socket.id);
});

socket.on('connect_error', err => {
  console.error('❌ Receiver socket error:', err.message);
});

let isConnected = false;
let isReceiving = false;
let receiveChannel = null;

document.addEventListener('DOMContentLoaded', () => {
  const downloadArea = document.getElementById('downloadArea');
  if (downloadArea) {
    downloadArea.classList.remove('show');
    downloadArea.innerHTML = '';
  }
});

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
// UI Helper
// ==========================
function showStatus(message, type) {
  const el = document.getElementById('receiverStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `status show ${type}`;
}

// ==========================
// CONNECT WITH PIN
// ==========================
async function connectWithPIN() {
  try {
    const pin = document.getElementById('pinInput').value.trim();
    if (!pin || !/^\d{6}$/.test(pin)) {
      showStatus('❌ Enter a valid 6-digit PIN', 'error');
      return;
    }
    showStatus('Connecting...', 'info');

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

    socket.emit('join-room', pin, async (response) => {
      if (!response.success) {
        showStatus('❌ ' + response.message, 'error');
        return;
      }

      await pc.setRemoteDescription(response.offer);

       pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { pin, candidate: event.candidate });
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

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

    

      socket.emit('send-answer', { pin, answer: pc.localDescription }, (res) => {
        if (res.success) {
          // Move to receiving step (#10)
          showStep('step-receive');

          const downloadArea = document.getElementById('downloadArea');
          if (downloadArea) {
            downloadArea.classList.remove('show');
            downloadArea.innerHTML = '';
          }

          showStatus('✓ Paired. Waiting for sender to send a file…', 'info');
        } else {
          showStatus('Error sending answer: ' + res.message, 'error');
        }
      });
    });
  } catch (err) {
    showStatus('Connection error: ' + err.message, 'error');
  }
}

// After setting remote description and creating answer:
pc.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit('ice-candidate', { pin: currentPIN, candidate: event.candidate });
  }
};

const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);
socket.emit('answer', { pin: currentPIN, sdp: pc.localDescription });


// ==========================
// DATA CHANNEL (RECEIVER)
// ==========================
function setupDataChannel() {
  pc.ondatachannel = event => {
    receiveChannel = event.channel;
    receiveChannel.binaryType = 'arraybuffer';

    let fileMetadata = null;
    let expectedSize = 0;
    let receivedSize = 0;
    let startTime = null;
    let currentBuffers = [];

    const progressFill    = document.getElementById('receiveProgressFill');
    const statusText      = document.getElementById('receiveStatus');
    const downloadContainer = document.getElementById('downloadArea');
    const cancelBtn       = document.getElementById('receiverCancelBtn');
    const progressWrap    = document.getElementById('receiveProgress');

    receiveChannel.onopen = () => {
      isConnected = true;
      showStatus('✓ Connected! Waiting for file...', 'success');
    };

    receiveChannel.onclose = () => showStatus('Connection closed', 'info');

    receiveChannel.onmessage = async e => {

      // ── Text messages ──────────────────────────────
      if (typeof e.data === 'string') {

        // CANCELLED by sender
        if (e.data === 'CANCEL') {
          isReceiving = false;
          showStatus('❌ Sender cancelled transfer', 'error');
          currentBuffers = [];
          if (progressFill) { progressFill.style.width = '0%'; progressFill.textContent = '0%'; }
          if (statusText) statusText.textContent = 'Cancelled';
          if (cancelBtn) cancelBtn.style.display = 'none';
          return;
        }

        // EOF — transfer complete
        if (e.data === 'EOF') {
          isReceiving = false;

          if (expectedSize > 0 && receivedSize === 0) {
           showStatus('❌ Transfer failed: no data received', 'error');
           if (cancelBtn) cancelBtn.style.display = 'none';
           return;
        }
  
          if (!fileMetadata) {
           console.warn('Received EOF without metadata — ignoring stale signal');
           return;
          }

          const blob = new Blob(currentBuffers, {
            type: fileMetadata?.mimeType || 'application/octet-stream'
          });

          if (progressFill) { progressFill.style.width = '0%'; progressFill.textContent = '0%'; }
          if (statusText) statusText.textContent = 'Transfer Complete';
          if (cancelBtn) cancelBtn.style.display = 'none';

          if (downloadContainer) downloadContainer.innerHTML = '';

          if (fileMetadata?.name.endsWith('.zip')) {
            showStatus('✓ Bundle received', 'success');
            createMainButton(downloadContainer, blob, fileMetadata.name, '📦 Download as ZIP');

            const extractBtn = document.createElement('button');
            extractBtn.textContent = '📂 View / Extract Files';
            extractBtn.className = 'action-btn';
            extractBtn.onclick = async () => {
              extractBtn.disabled = true;
              extractBtn.textContent = 'Extracting...';
              await extractZipAndShowFiles(blob, downloadContainer);
              extractBtn.style.display = 'none';
            };
            downloadContainer.appendChild(extractBtn);
          } else {
            showStatus('✓ File received!', 'success');
            createMainButton(downloadContainer, blob, fileMetadata.name, `⬇️ Download ${fileMetadata.name}`);
          }

          if (downloadContainer) downloadContainer.classList.add('show');
          currentBuffers = [];
          return;
        }

        // Metadata (start of transfer)
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'metadata') {
            fileMetadata = data;
            expectedSize = data.size;
            receivedSize = 0;
            startTime = Date.now();
            currentBuffers = [];
            isReceiving = true;

            if (cancelBtn) cancelBtn.style.display = 'inline-block';
            if (progressFill) { progressFill.style.width = '0%'; }
            if (progressWrap) progressWrap.classList.add('show');
            showStatus(`Receiving: ${data.name}`, 'info');
          }
        } catch (_) {}

      // ── Binary data (chunks) ───────────────────────
      } else {
        currentBuffers.push(e.data);
        receivedSize += e.data.byteLength;

        if (expectedSize > 0) {
          const percent = Math.round((receivedSize / expectedSize) * 100);
          if (progressFill) {
            progressFill.style.width = percent + '%';
            progressFill.textContent = percent + '%';
          }

          const elapsedTime = (Date.now() - startTime) / 1000;
          const speed = elapsedTime > 0 ? ((receivedSize / (1024 * 1024)) / elapsedTime) : 0;
          const sentMB  = (receivedSize / (1024 * 1024)).toFixed(2);
          const totalMB = (expectedSize / (1024 * 1024)).toFixed(2);

          if (statusText) {
            statusText.textContent = `${sentMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;
          }
        }
      }
    };
  };
}

// ==========================
// HELPER FUNCTIONS
// ==========================
function createMainButton(container, blob, filename, label) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = label;
  a.className = 'download-btn primary';
  container.appendChild(a);
}

async function extractZipAndShowFiles(blob, container) {
  try {
    const zip = await JSZip.loadAsync(blob);

    const fileList = document.createElement('div');
    fileList.className = 'extracted-files-list';

    const header = document.createElement('h4');
    header.textContent = 'Files (download individually):';
    fileList.appendChild(header);

    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) continue;

      const content = await file.async('blob');
      const url = URL.createObjectURL(content);

      const row = document.createElement('div');
      row.className = 'file-row';

      const link = document.createElement('a');
      link.href = url;
      link.download = relativePath.replace(/\//g, '_');
      link.textContent = `📄 ${relativePath}`;
      link.className = 'file-link';

      row.appendChild(link);
      fileList.appendChild(row);
    }

    container.appendChild(fileList);
  } catch (err) {
    alert('Error extracting zip: ' + err.message);
  }
}

function goBack() {
  if (isReceiving) {
    showStatus('❌ Cannot leave while receiving file!', 'error');
    return;
  }
  if (isConnected && pc && pc.connectionState === 'connected') {
    showStatus('❌ Connection is still active. Wait for transfer to complete.', 'error');
    return;
  }
  window.location.href = 'index.html';
}

function cancelReceive() {
  if (receiveChannel && receiveChannel.readyState === 'open') {
    try { receiveChannel.send('CANCEL'); } catch (_) {}
  }

  isReceiving = false;

  const progressFill    = document.getElementById('receiveProgressFill');
  const statusText      = document.getElementById('receiveStatus');
  const progressWrap    = document.getElementById('receiveProgress');
  const download        = document.getElementById('downloadArea');
  const cancelBtn       = document.getElementById('receiverCancelBtn');

  if (progressFill) { progressFill.style.width = '0%'; progressFill.textContent = '0%'; }
  if (statusText) statusText.textContent = 'Waiting for file...';
  if (progressWrap) progressWrap.classList.remove('show');
  if (download) { download.classList.remove('show'); download.innerHTML = ''; }
  if (cancelBtn) cancelBtn.style.display = 'none';

  showStatus('❌ Transfer cancelled', 'info');
}

if (e.data === 'DISCONNECT') {
  isConnected = false;
  isReceiving = false;
  showStatus('Sender ended the connection', 'info');
  setTimeout(() => showStep('step-pin'), 1500);
  return;
}