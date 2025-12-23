// ==========================
// WebRTC + Socket
// ==========================
let pc;
let socket = io();
let isConnected = false;
let isReceiving = false;

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
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
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
// DATA CHANNEL (RECEIVER)
// ==========================
function setupReceiverChannel() {
  isReceiving = true;
  isConnected = true;
  pc.ondatachannel = (e) => {
    const channel = e.channel;
    channel.binaryType = 'arraybuffer';

    let meta, received = 0;
    let buffers = [];

    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data === 'EOF') {
          const blob = new Blob(buffers, { type: meta.mime });
          const url = URL.createObjectURL(blob);
          const link = document.getElementById('downloadLink');
          link.href = url;
          link.download = meta.name;
          document.getElementById('downloadArea').style.display = 'block';
          showStatus('File received!', 'success');
        } else {
          meta = JSON.parse(ev.data);
        }
      } else {
        buffers.push(ev.data);
        received += ev.data.byteLength;
      }
    };

    isReceiving = false;

  };
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

function setupDataChannel() {
  pc.ondatachannel = event => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';

    let fileMetadata = null;
    let expectedSize = 0;
    let receivedSize = 0;
    let startTime = null;
    let currentBuffers = [];

    // Prepare UI
    document.getElementById('receiveProgress').classList.add('show');
    document.getElementById('receiveProgressFill').style.width = '0%';
    document.getElementById('receiveProgressFill').textContent = '0%';
    document.getElementById('downloadArea').classList.remove('show');

    channel.onmessage = async e => {
      if (typeof e.data === 'string') {
         if (e.data === 'CANCEL') {
          showStatus('❌ Transfer cancelled by sender', 'error');
          currentBuffers = [];
          document.getElementById('receiveProgressFill').style.width = '0%';
          document.getElementById('receiveProgressFill').textContent = '0%';
          document.getElementById('receiveStatus').textContent = 'Transfer cancelled';
          return;
        }
        if (e.data === 'EOF') {
          const blob = new Blob(currentBuffers, {
  type: fileMetadata?.mimeType || 'application/octet-stream'
});

if (fileMetadata?.name.endsWith('.zip')) {
  const zip = await JSZip.loadAsync(blob);
  const container = document.getElementById('downloadArea');
  container.innerHTML = '';

  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const content = await file.async('blob');
    const url = URL.createObjectURL(content);

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = `Download ${name}`;
    a.style.display = 'block';

    container.appendChild(a);
  }

  container.classList.add('show');
  showStatus('✓ ZIP extracted', 'success');
  return;
}

          const url = URL.createObjectURL(blob);
          const link = document.getElementById('downloadLink');
          link.href = url;
          link.download = fileMetadata?.name || 'received_file';
          document.getElementById('downloadArea').classList.add('show');

          const totalTime = (Date.now() - startTime) / 1000;
          const avgSpeed = (receivedSize / (1024 * 1024)) / totalTime;
          showStatus('✓ File received!', 'success');
          document.getElementById('receiveStatus').textContent =
            `Download ready! (${avgSpeed.toFixed(2)} MB/s)`;
          document.getElementById('receiverCancelBtn').style.display = 'none';
          currentBuffers = [];
          return;
        }

        try {
          const data = JSON.parse(e.data);
          if (data.type === 'metadata') {
            document.getElementById('receiverCancelBtn').style.display = 'inline-block';
            fileMetadata = data;
            expectedSize = data.size;
            receivedSize = 0;
            startTime = Date.now();
            currentBuffers = [];
            document.getElementById('receiverCancelBtn').style.display = 'block';
            document.getElementById('receiveProgressFill').style.width = '0%';
            document.getElementById('receiveProgressFill').textContent = '0%';
            document.getElementById('downloadArea').classList.remove('show');
            
            showStatus(`Receiving (${data.index + 1}/${data.total}): ${data.name}`, 'info'); 
          }
        } catch {}
      } else {
        currentBuffers.push(e.data);
        receivedSize += e.data.byteLength;
        if (expectedSize > 0) {
          const percent = Math.round((receivedSize / expectedSize) * 100);
          document.getElementById('receiveProgressFill').style.width = percent + '%';
          document.getElementById('receiveProgressFill').textContent = percent + '%';
        }
      }
    };

    channel.onopen = () => showStatus('✓ Connected! Waiting for file...', 'success');
    channel.onclose = () => showStatus('Connection closed', 'info');
  };
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
  try {
    if (pc) pc.close();
  } catch {}

  document.getElementById('receiverCancelBtn').style.display = 'none';
  document.getElementById('receiveProgressFill').style.width = '0%';
  document.getElementById('receiveProgressFill').textContent = '0%';
  document.getElementById('receiveStatus').textContent = 'Cancelled';
  document.getElementById('receiverCancelBtn').style.display = 'none';
  showStatus('❌ Receive cancelled', 'info');
}
