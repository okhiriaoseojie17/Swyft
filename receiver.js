
let pc;
let receivedBuffers = [];

function goBack() {
  window.location.href = 'index.html';
}

function showStatus(message, type) {
  const statusEl = document.getElementById('receiverStatus');
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
}

function copyToClipboard(elementId) {
  const textarea = document.getElementById(elementId);
  textarea.select();
  textarea.setSelectionRange(0, 99999);
  
  try {
    document.execCommand('copy');
    showStatus('✓ Code copied to clipboard!', 'success');
  } catch (err) {
    showStatus('Failed to copy. Please copy manually.', 'error');
  }
}

async function createAnswer() {
  try {
    // Get the offer text and clean it thoroughly
    let offerText = document.getElementById('receiverOffer').value;
    
    // Remove ALL whitespace from beginning and end
    offerText = offerText.trim();
    
    // Remove any invisible characters
    offerText = offerText.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // Log for debugging
    console.log('Offer text length:', offerText.length);
    console.log('First 50 chars:', offerText.substring(0, 50));
    console.log('Last 50 chars:', offerText.substring(offerText.length - 50));
    
    // Check if empty
    if (!offerText || offerText.length === 0) {
      showStatus('❌ Please paste the sender\'s code first!', 'error');
      return;
    }
    
    // Check if it looks like JSON
    if (!offerText.startsWith('{') || !offerText.endsWith('}')) {
      showStatus('❌ Invalid code format! Make sure you copied the ENTIRE code.', 'error');
      console.error('Code doesn\'t look like JSON. Starts with:', offerText.substring(0, 10));
      return;
    }
    
    // Try to parse JSON
    let offer;
    try {
      offer = JSON.parse(offerText);
    } catch (parseError) {
      showStatus('❌ Invalid code! Error: ' + parseError.message, 'error');
      console.error('JSON Parse Error:', parseError);
      console.error('Attempted to parse:', offerText);
      return;
    }
    
    // Validate it's a WebRTC offer
    if (!offer.type || offer.type !== 'offer') {
      showStatus('❌ This doesn\'t look like a sender code. Expected type "offer", got: ' + offer.type, 'error');
      return;
    }
    
    if (!offer.sdp) {
      showStatus('❌ Invalid offer - missing SDP data!', 'error');
      return;
    }
    
    console.log('Offer validated successfully!');
    showStatus('✓ Code validated! Creating connection...', 'info');

    // Create peer connection
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    
    let fileMetadata = null;
    let expectedSize = 0;
    let receivedSize = 0;
    let startTime = null;

    pc.ondatachannel = event => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      console.log('Data channel received!');
      
      document.getElementById('receiveProgress').classList.add('show');

      channel.onmessage = e => {
        if (typeof e.data === 'string') {
          if (e.data === 'EOF') {
            // File transfer complete
            const received = new Blob(receivedBuffers, { 
              type: fileMetadata?.mimeType || 'application/octet-stream' 
            });
            const url = URL.createObjectURL(received);

            const link = document.getElementById('downloadLink');
            link.href = url;
            link.download = fileMetadata?.name || 'received_file';
            document.getElementById('downloadArea').classList.add('show');
            
            const totalTime = (Date.now() - startTime) / 1000;
            const avgSpeed = (receivedSize / (1024 * 1024)) / totalTime;
            
            showStatus('✓ File received successfully!', 'success');
            document.getElementById('receiveStatus').textContent = 
              `Download ready! (${avgSpeed.toFixed(2)} MB/s average)`;
            return;
          }
          
          // Try to parse as metadata
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'metadata') {
              fileMetadata = data;
              expectedSize = data.size;
              startTime = Date.now();
              document.getElementById('receiveStatus').textContent = 
                `Receiving: ${data.name}`;
              showStatus(`Receiving file: ${data.name}`, 'info');
            }
          } catch (err) {
            console.log('Non-JSON string data:', e.data);
          }
        } else {
          // Binary data (file chunks)
          receivedBuffers.push(e.data);
          receivedSize += e.data.byteLength;
          
          if (expectedSize > 0) {
            const percent = Math.round((receivedSize / expectedSize) * 100);
            document.getElementById('receiveProgressFill').style.width = percent + '%';
            document.getElementById('receiveProgressFill').textContent = percent + '%';
            
            const recvMB = (receivedSize / (1024 * 1024)).toFixed(2);
            const totalMB = (expectedSize / (1024 * 1024)).toFixed(2);
            
            // Calculate current speed
            const elapsedTime = (Date.now() - startTime) / 1000;
            const speed = (receivedSize / (1024 * 1024)) / elapsedTime;
            
            document.getElementById('receiveStatus').textContent = 
              `Received: ${recvMB} MB / ${totalMB} MB (${speed.toFixed(2)} MB/s)`;
          }
        }
      };

      channel.onopen = () => {
        console.log('Channel opened on receiver!');
        showStatus('✓ Connected! Waiting for file...', 'success');
      };
      
      channel.onclose = () => {
        console.log('Channel closed');
        showStatus('Connection closed.', 'info');
      };

      channel.onerror = (error) => {
        console.error('Channel error:', error);
        showStatus('Connection error occurred.', 'error');
      };
    };

    pc.onicecandidate = event => {
      if (!event.candidate) {
        const answerText = JSON.stringify(pc.localDescription);
        document.getElementById('receiverAnswer').value = answerText;
        document.getElementById('copyAnswerBtn').style.display = 'block';
        showStatus('✓ Answer code generated! Send it to the sender.', 'info');
        console.log('Answer generated, length:', answerText.length);
      }
    };

    // Set the remote description (sender's offer)
    await pc.setRemoteDescription(offer);
    console.log('Remote description set successfully');

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('Answer created and set as local description');
    
    showStatus('Generating answer code...', 'info');
  } catch (error) {
    console.error('Error creating answer:', error);
    showStatus('Error: ' + error.message + ' (Check console for details)', 'error');
  }
}