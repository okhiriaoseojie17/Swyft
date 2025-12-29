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

// ==========================
// UI Helper
// ==========================
function showStatus(message, type) {
  const el = document.getElementById('receiverStatus');
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

    // Create PeerConnection first
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

    setupDataChannel(); // <-- MUST be here before setRemoteDescription

    socket.emit('join-room', pin, async (response) => {
      if (!response.success) {
        showStatus('❌ ' + response.message, 'error');
        return;
      }

      await pc.setRemoteDescription(response.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        else pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        });
      });

      socket.emit('send-answer', { pin, answer: pc.localDescription }, (res) => {
        if (res.success) {
          document.getElementById('pinWaitingSection').style.display = 'block';
          showStatus('✓ Connected!', 'success');
          document.getElementById('receiveFileSection').style.display = 'block';
        } else {
          showStatus('Error sending answer: ' + res.message, 'error');
        }
      });
    });
  } catch (err) {
    showStatus('Connection error: ' + err.message, 'error');
  }
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

// ==========================
// DATA CHANNEL (RECEIVER) - FIXED & NEW FEATURES
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

    // UI Elements
    const progressFill = document.getElementById('receiveProgressFill');
    const statusText = document.getElementById('receiveStatus');
    const downloadContainer = document.getElementById('downloadArea');
    const cancelBtn = document.getElementById('receiverCancelBtn');

    // Initial Reset
    document.getElementById('receiveProgress').classList.add('show');
    progressFill.style.width = '0%';
    progressFill.textContent = '0%';
    downloadContainer.classList.remove('show');
    downloadContainer.innerHTML = ''; // Clear previous buttons

    receiveChannel.onopen = () => showStatus('✓ Connected! Waiting for file...', 'success');
    receiveChannel.onclose = () => showStatus('Connection closed', 'info');

    receiveChannel.onmessage = async e => {
      // 1. Text Messages (Metadata, EOF, Cancel)
      if (typeof e.data === 'string') {
        
        // --- CANCELLED ---
        if (e.data === 'CANCEL') {
          showStatus('❌ Sender cancelled transfer', 'error');
          currentBuffers = [];
          progressFill.style.width = '0%';
          progressFill.textContent = '0%';
          statusText.textContent = 'Cancelled';
          cancelBtn.style.display = 'none';
          return;
        }

        // --- TRANSFER COMPLETE (EOF) ---
        if (e.data === 'EOF') {

          if (!currentBuffers.length || receivedSize === 0) {
    showStatus('Transfer cancelled before data arrived', 'info');
    cancelBtn.style.display = 'none';
    return;
  }

          const blob = new Blob(currentBuffers, { 
            type: fileMetadata?.mimeType || 'application/octet-stream' 
          });

          // 1. Force Reset Progress Bar immediately
          progressFill.style.width = '0%';
          progressFill.textContent = '0%';
          statusText.textContent = 'Transfer Complete';
          cancelBtn.style.display = 'none';

          // 2. Clear previous buttons to prevent duplicates
          downloadContainer.innerHTML = ''; 

          // 3. Handle Download Options
          if (fileMetadata?.name.endsWith('.zip')) {
            // === ZIP / FOLDER MODE ===
            showStatus('✓ Bundle received', 'success');

            // Option A: Download as ZIP (Button 1)
            createMainButton(downloadContainer, blob, fileMetadata.name, '📦 Download as ZIP');

            // Option B: Extract / View Folder (Button 2)
            const extractBtn = document.createElement('button');
            extractBtn.textContent = '📂 View / Extract Files';
            extractBtn.className = 'action-btn'; // We'll add CSS for this
            extractBtn.onclick = async () => {
                extractBtn.disabled = true;
                extractBtn.textContent = 'Extracting...';
                await extractZipAndShowFiles(blob, downloadContainer);
                extractBtn.style.display = 'none'; // Hide button after extracting
            };
            downloadContainer.appendChild(extractBtn);

          } else {
            // === SINGLE FILE MODE ===
            showStatus('✓ File received!', 'success');
            createMainButton(downloadContainer, blob, fileMetadata.name, `⬇️ Download ${fileMetadata.name}`);
          }

          downloadContainer.classList.add('show');
          currentBuffers = [];
          return;
        }

        // --- METADATA (START) ---
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'metadata') {
            fileMetadata = data;
            expectedSize = data.size;
            receivedSize = 0;
            startTime = Date.now();
            currentBuffers = [];

            // UI Reset for new transfer
            cancelBtn.style.display = 'inline-block';
            progressFill.style.width = '0%';
            document.getElementById('receiveProgress').classList.add('show');
            downloadContainer.classList.remove('show');
            downloadContainer.innerHTML = ''; // Ensure clean slate
            showStatus(`Receiving: ${data.name}`, 'info');
          }
        } catch {}
      } 
      
      // 2. Binary Data (Chunks)
      else {
        currentBuffers.push(e.data);
        receivedSize += e.data.byteLength;

        if (expectedSize > 0) {
          const percent = Math.round((receivedSize / expectedSize) * 100);
          progressFill.style.width = percent + '%';
          progressFill.textContent = percent + '%';

          // Calculate Speed
          const elapsedTime = (Date.now() - startTime) / 1000;
          const speed = elapsedTime > 0 ? ((receivedSize / (1024 * 1024)) / elapsedTime) : 0;
          const sentMB = (receivedSize / (1024 * 1024)).toFixed(2);
          const totalMB = (expectedSize / (1024 * 1024)).toFixed(2);

          statusText.textContent = `${sentMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;
        }
      }
    };
  };
}

// --- HELPER FUNCTIONS ---

// Creates the main "Download ZIP" or "Download File" button
function createMainButton(container, blob, filename, label) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = label;
  a.className = 'download-btn primary';
  container.appendChild(a);
}

// Extracts the ZIP and lists files individually (Simulating "Download Folder")
async function extractZipAndShowFiles(blob, container) {
  try {
    const zip = await JSZip.loadAsync(blob);
    
    const fileList = document.createElement('div');
    fileList.className = 'extracted-files-list';
    
    const header = document.createElement('h4');
    header.textContent = 'Files (download individually):';
    fileList.appendChild(header);

    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) continue; // Skip empty directory entries

      const content = await file.async('blob');
      const url = URL.createObjectURL(content);

      const row = document.createElement('div');
      row.className = 'file-row';

      const link = document.createElement('a');
      link.href = url;
      // Use the full path so files in subfolders don't clash
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

// Helper to create links dynamically
function createDownloadLink(container, blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = `⬇️ Download ${filename}`;
  
  // Style the link to look like a button or clean text
  a.style.display = 'block';
  a.style.padding = '10px';
  a.style.margin = '5px 0';
  a.style.background = '#f0f0f0';
  a.style.borderRadius = '5px';
  a.style.textDecoration = 'none';
  a.style.color = '#333';
  a.style.fontWeight = 'bold';

  container.appendChild(a);
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
  if (receiveChannel) receiveChannel.onmessage = receiveChannel.onmessage;

  // 1. Notify sender
  if (receiveChannel && receiveChannel.readyState === 'open') {
    try {
      receiveChannel.send('CANCEL');
    } catch (e) {}
  }

  // 2. HARD RESET receiver state
  isReceiving = false;

  // 3. Reset UI (MATCH sender behavior)
  const progress = document.getElementById('receiveProgress');
  const fill = document.getElementById('receiveProgressFill');
  const status = document.getElementById('receiveStatus');
  const download = document.getElementById('downloadArea');

  fill.style.width = '0%';
  fill.textContent = '0%';
  status.textContent = 'Waiting for file...';
  progress.classList.remove('show');

  download.classList.remove('show');
  download.innerHTML = '';

  document.getElementById('receiverCancelBtn').style.display = 'none';

  showStatus('❌ Transfer cancelled', 'info');
}

