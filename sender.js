let pc;
let dataChannel;
let selectedFile = null;

function goBack() {
  window.location.href = 'index.html';
}

function showStatus(message, type) {
  const statusEl = document.getElementById('senderStatus');
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
}

function handleFileSelect() {
  const input = document.getElementById('fileInput');
  selectedFile = input.files[0];
  
  if (selectedFile) {
    const fileInfo = document.getElementById('fileInfo');
    const sizeMB = (selectedFile.size / (1024 * 1024)).toFixed(2);
    fileInfo.innerHTML = `<strong>${selectedFile.name}</strong><br>Size: ${sizeMB} MB`;
    fileInfo.classList.add('show');
    
    if (dataChannel && dataChannel.readyState === 'open') {
      document.getElementById('sendBtn').disabled = false;
    }
  }
}

function copyToClipboard(elementId) {
  const textarea = document.getElementById(elementId);
  textarea.select();
  textarea.setSelectionRange(0, 99999); // For mobile devices
  
  try {
    document.execCommand('copy');
    showStatus('✓ Code copied to clipboard!', 'success');
  } catch (err) {
    showStatus('Failed to copy. Please copy manually.', 'error');
  }
}

async function createOffer() {
  try {
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    
    dataChannel = pc.createDataChannel('fileTransfer');
    dataChannel.binaryType = 'arraybuffer';
    
    dataChannel.onopen = () => {
      console.log('Channel opened!');
      showStatus('✓ Connected! You can now send files.', 'success');
      if (selectedFile) {
        document.getElementById('sendBtn').disabled = false;
      }
    };
    
    dataChannel.onclose = () => {
      console.log('Channel closed');
      showStatus('Connection closed.', 'info');
      document.getElementById('sendBtn').disabled = true;
    };
    
    dataChannel.onerror = (error) => {
      console.error('Channel error:', error);
      showStatus('Connection error occurred.', 'error');
    };

    pc.onicecandidate = event => {
      if (!event.candidate) {
        const offerText = JSON.stringify(pc.localDescription);
        document.getElementById('offer').value = offerText;
        document.getElementById('copyOfferBtn').style.display = 'block';
        showStatus('✓ Connection code generated! Copy it to the receiver.', 'info');
        
        console.log('Offer generated successfully');
        console.log('Offer length:', offerText.length);
        console.log('Offer type:', pc.localDescription.type);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    showStatus('Generating connection code...', 'info');
  } catch (error) {
    console.error('Error creating offer:', error);
    showStatus('Error: ' + error.message, 'error');
  }
}

async function applyAnswer() {
  try {
    // Get the answer text and clean it thoroughly
    let answerText = document.getElementById('answer').value;
    
    // Remove ALL whitespace from beginning and end
    answerText = answerText.trim();
    
    // Remove any invisible characters
    answerText = answerText.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Log for debugging
    console.log('Answer text length:', answerText.length);
    console.log('First 50 chars:', answerText.substring(0, 50));
    console.log('Last 50 chars:', answerText.substring(answerText.length - 50));
    
    // Check if empty
    if (!answerText || answerText.length === 0) {
      showStatus('❌ Please paste the receiver\'s code first!', 'error');
      return;
    }
    
    // Check if it looks like JSON
    if (!answerText.startsWith('{') || !answerText.endsWith('}')) {
      showStatus('❌ Invalid code format! Make sure you copied the ENTIRE code.', 'error');
      console.error('Code doesn\'t look like JSON. Starts with:', answerText.substring(0, 10));
      return;
    }
    
    // Try to parse JSON
    let answer;
    try {
      answer = JSON.parse(answerText);
    } catch (parseError) {
      showStatus('❌ Invalid code! Error: ' + parseError.message, 'error');
      console.error('JSON Parse Error:', parseError);
      console.error('Attempted to parse:', answerText);
      return;
    }
    
    // Validate it's a WebRTC answer
    if (!answer.type || answer.type !== 'answer') {
      showStatus('❌ This doesn\'t look like a receiver code. Expected type "answer", got: ' + answer.type, 'error');
      return;
    }
    
    if (!answer.sdp) {
      showStatus('❌ Invalid answer - missing SDP data!', 'error');
      return;
    }
    
    console.log('Answer validated successfully!');
    showStatus('✓ Code validated! Connecting...', 'info');

    await pc.setRemoteDescription(answer);
    console.log('Remote description set successfully');
    showStatus('Connecting... Wait for "Connected!" message.', 'info');
  } catch (error) {
    console.error('Error applying answer:', error);
    showStatus('Error: ' + error.message + ' (Check console for details)', 'error');
  }
}

function sendFile() {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    showStatus('❌ Connection not ready! Please wait for "Connected!" message.', 'error');
    return;
  }

  if (!selectedFile) {
    showStatus('❌ No file selected!', 'error');
    return;
  }

  const chunkSize = 16 * 1024; // 16KB chunks
  let offset = 0;
  const reader = new FileReader();
  const totalSize = selectedFile.size;
  const startTime = Date.now();
  
  document.getElementById('sendProgress').classList.add('show');
  document.getElementById('sendBtn').disabled = true;

  // Send file metadata first
  const metadata = {
    type: 'metadata',
    name: selectedFile.name,
    size: selectedFile.size,
    mimeType: selectedFile.type || 'application/octet-stream'
  };
  
  try {
    dataChannel.send(JSON.stringify(metadata));
    console.log('Metadata sent:', metadata);
  } catch (error) {
    console.error('Error sending metadata:', error);
    showStatus('Error starting transfer: ' + error.message, 'error');
    document.getElementById('sendBtn').disabled = false;
    return;
  }

  reader.onload = e => {
    try {
      dataChannel.send(e.target.result);
      offset += e.target.result.byteLength;

      const percent = Math.round((offset / totalSize) * 100);
      document.getElementById('sendProgressFill').style.width = percent + '%';
      document.getElementById('sendProgressFill').textContent = percent + '%';
      
      const sentMB = (offset / (1024 * 1024)).toFixed(2);
      const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
      
      // Calculate speed
      const elapsedTime = (Date.now() - startTime) / 1000; // seconds
      const speed = (offset / (1024 * 1024)) / elapsedTime; // MB/s
      
      document.getElementById('sendStatus').textContent = 
        `Sent: ${sentMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;

      if (offset < totalSize) {
        readSlice(offset);
      } else {
        dataChannel.send('EOF');
        showStatus('✓ File sent successfully!', 'success');
        document.getElementById('sendBtn').disabled = false;
        document.getElementById('sendStatus').textContent = 
          `Transfer complete! (${speed.toFixed(2)} MB/s average)`;
      }
    } catch (error) {
      console.error('Send error:', error);
      showStatus('Error sending file: ' + error.message, 'error');
      document.getElementById('sendBtn').disabled = false;
    }
  };

  reader.onerror = error => {
    console.error('File read error:', error);
    showStatus('Error reading file!', 'error');
    document.getElementById('sendBtn').disabled = false;
  };

  function readSlice(o) {
    const slice = selectedFile.slice(o, o + chunkSize);
    reader.readAsArrayBuffer(slice);
  }

  showStatus('Sending file...', 'info');
  console.log(`Starting file transfer: ${selectedFile.name} (${selectedFile.size} bytes)`);
  readSlice(0);
}