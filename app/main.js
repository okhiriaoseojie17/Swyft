const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

// ─── Helper: get primary LAN IPv4 ─────────────────────────────────────────────
function getLANIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Windows ICS / Mobile Hotspot gateway is always on 192.168.137.x
function getHotspotIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal &&
          iface.address.startsWith('192.168.137.')) {
        return iface.address;
      }
    }
  }
  return null;
}


let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 800,
    minWidth: 380,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Swyft',
    backgroundColor: '#0a0a0a'
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  require('./local-server');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Hotspot control (Windows only) ───────────────────────────────────────────
//
// Strategy (tried in order):
//   1. netsh wlan set/start hostednetwork  — works on older Win10 / some adapters
//   2. PowerShell Mobile Hotspot API       — works on Win10 1607+ if adapter supports it
//   3. Open ms-settings:network-mobilehotspot — always works; user enables manually
//
// The hosted-network command fails when the WiFi driver doesn't expose a virtual
// adapter (common on modern drivers). The PowerShell approach uses the newer
// Windows.Networking.NetworkOperators API to toggle the system Mobile Hotspot.

// ─── Expose LAN IP to renderer ────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLANIP());

// ─── Open Windows network settings (used by firewall warning card) ────────────
// Lets the user change their WiFi profile from Public → Private with one click.
ipcMain.handle('open-network-settings', () => {
  if (process.platform === 'win32') {
    shell.openExternal('ms-settings:network-wifi');
  }
});

// ─── Expose hotspot credentials (reads real SSID/pwd from netsh after start) ──
ipcMain.handle('get-hotspot-info', async () => {
  return new Promise((resolve) => {
    exec('netsh wlan show hostednetwork', (err, stdout) => {
      if (err) {
        resolve({ ssid: 'SwyftLocal', password: 'swyft1234', ip: getHotspotIP() || '192.168.137.1' });
        return;
      }
      const ssidMatch = stdout.match(/SSID name\s*:\s*(.+)/i);
      const ssid = ssidMatch ? ssidMatch[1].trim().replace(/^"|"$/g, '') : 'SwyftLocal';
      // Password can only be read with show hostednetwork setting=security
      exec('netsh wlan show hostednetwork setting=security', (err2, stdout2) => {
        const pwdMatch = stdout2 && stdout2.match(/User Password\s*:\s*(.+)/i);
        const password = pwdMatch ? pwdMatch[1].trim() : 'swyft1234';
        resolve({ ssid, password, ip: getHotspotIP() || '192.168.137.1' });
      });
    });
  });
});

ipcMain.handle('hotspot-start', async () => {
  if (process.platform !== 'win32') {
    return {
      success: false,
      message: 'Hotspot control is Windows-only. Use your system settings to create a hotspot, then open Swyft on the other device.'
    };
  }

  // ── Attempt 1: legacy hosted network ──────────────────────────
  const legacyResult = await tryLegacyHostedNetwork();
  if (legacyResult.success) {
    await new Promise(r => setTimeout(r, 1500));
    const ip = getHotspotIP() || '192.168.137.1';
    return { ...legacyResult, ssid: 'SwyftLocal', password: 'swyft1234', ip, serverUrl: 'http://' + ip + ':3001' };
  }

  // ── Attempt 2: PowerShell Mobile Hotspot (Win10 1607+) ────────
  const psResult = await tryPowerShellHotspot();
  if (psResult.success) {
    await new Promise(r => setTimeout(r, 2000));
    const ip = getHotspotIP() || '192.168.137.1';
    return { ...psResult, ssid: 'Your Windows Hotspot SSID', password: 'Your Windows Hotspot Password', ip, serverUrl: 'http://' + ip + ':3001' };
  }

  // ── Attempt 3: Open Windows Settings as fallback ──────────────
  shell.openExternal('ms-settings:network-mobilehotspot');
  const fallbackIP = getLANIP();
  return {
    success: false,
    openedSettings: true,
    ip: fallbackIP,
    serverUrl: 'http://' + fallbackIP + ':3001',
    message: "Your WiFi adapter doesn't support auto hotspot. Windows Mobile Hotspot settings opened — enable it there, connect the other device to that hotspot, then open Swyft on it."
  };
});

ipcMain.handle('hotspot-stop', async () => {
  if (process.platform !== 'win32') return { success: false };

  // Try stopping legacy hosted network first, then PowerShell
  const legacyStop = await new Promise((resolve) => {
    exec('netsh wlan stop hostednetwork', (err) => resolve({ success: !err }));
  });
  if (legacyStop.success) return legacyStop;

  // PowerShell stop
  const psStop = await new Promise((resolve) => {
    const script = `
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $ap = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]
      $profile = $ap::GetCurrentProfile()
      $mgr = $ap::CreateFromConnectionProfile($profile)
      $result = $mgr.StopTetheringAsync()
      $result.AsTask().GetAwaiter().GetResult()
    `;
    exec(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, '; ')}"`,
      (err) => resolve({ success: !err }));
  });

  return psStop;
});

// ─── Helper: legacy netsh hosted network ──────────────────────────────────────
function tryLegacyHostedNetwork() {
  return new Promise((resolve) => {
    exec('netsh wlan set hostednetwork mode=allow ssid=SwyftLocal key=swyft1234', (err) => {
      if (err) return resolve({ success: false, message: err.message });
      exec('netsh wlan start hostednetwork', (err2) => {
        if (err2) return resolve({ success: false, message: err2.message });
        resolve({ success: true, method: 'legacy' });
      });
    });
  });
}

// ─── Helper: PowerShell TetheringManager ──────────────────────────────────────
function tryPowerShellHotspot() {
  return new Promise((resolve) => {
    // This script uses the UWP API to start Mobile Hotspot programmatically.
    // It requires Windows 10 build 10586+ and a compatible adapter.
    const script = [
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '$null = [Windows.Networking.Connectivity.NetworkInformation, Windows, ContentType=WindowsRuntime]',
      '$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows, ContentType=WindowsRuntime]',
      '$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
      'if (-not $profile) { exit 1 }',
      '$mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)',
      'if (-not $mgr) { exit 1 }',
      '$task = $mgr.StartTetheringAsync()',
      '$task.AsTask().GetAwaiter().GetResult()',
      'exit 0'
    ].join('; ');

    exec(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, message: (stderr || err.message).trim() });
        } else {
          resolve({ success: true, method: 'powershell' });
        }
      }
    );
  });
}