/**
 * main.js  (DESKTOP)
 *
 * FIXES vs old code:
 *  1. Port references updated: 3001 → 53317 where appropriate
 *  2. getLANIP() filter list kept in sync with local-server.js
 *  3. hotspot serverUrl corrected: 3001 → 53317
 *  4. No functional changes to window creation or app lifecycle
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const SWYFT_PORT  = 53317;
const SIGNAL_PORT = 3001;

// ─── Helper: get primary LAN IPv4 ─────────────────────────────────────────────
// Must match the logic in local-server.js exactly so both agree on the IP.

function getLANIP() {
  const ifaces = os.networkInterfaces();
  const SKIP = [
    a => a.startsWith('192.168.56.'),                           // VirtualBox
    a => a.startsWith('100.64.') || a.startsWith('100.65.'),   // Tailscale CGNAT
    a => { const b = parseInt(a.split('.')[1]);                 // WSL2/Docker/Hyper-V
           return a.startsWith('172.') && b >= 16 && b <= 31; },
    a => a.startsWith('169.254.'),                              // APIPA link-local
    a => a.startsWith('10.0.2.'),                              // VirtualBox NAT
  ];

  const SKIP_NAMES = [
    'vmware', 'virtualbox', 'vethernet', 'hyper-v',
    'docker', 'wsl', 'loopback', 'pseudo', 'tailscale', 'zerotier', 'tun', 'tap',
  ];

  const candidates = [];
  for (const [name, entries] of Object.entries(ifaces)) {
    const nameLC = name.toLowerCase();
    if (SKIP_NAMES.some(v => nameLC.includes(v))) continue;

    for (const iface of entries) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (SKIP.some(fn => fn(iface.address))) continue;
      candidates.push(iface.address);
    }
  }

  // Prefer 192.168.x.x (home WiFi) over 10.x.x.x (corporate)
  return candidates.find(a => a.startsWith('192.168.')) ||
         candidates.find(a => a.startsWith('10.'))      ||
         candidates[0] || '127.0.0.1';
}

// Windows ICS / Mobile Hotspot gateway is always on 192.168.137.x
function getHotspotIP() {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries) {
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
    width:     430,
    height:    800,
    minWidth:  380,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title:           'Swyft',
    backgroundColor: '#0a0a0a',
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
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

// ─── Expose LAN IP to renderer ────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLANIP());

// ─── Open Windows network settings ───────────────────────────────────────────
ipcMain.handle('open-network-settings', () => {
  if (process.platform === 'win32') {
    shell.openExternal('ms-settings:network-wifi');
  }
});

// ─── Hotspot credentials ──────────────────────────────────────────────────────
ipcMain.handle('get-hotspot-info', async () => {
  return new Promise((resolve) => {
    exec('netsh wlan show hostednetwork', (err, stdout) => {
      if (err) {
        resolve({
          ssid:     'SwyftLocal',
          password: 'swyft1234',
          ip:       getHotspotIP() || '192.168.137.1',
        });
        return;
      }
      const ssidMatch = stdout.match(/SSID name\s*:\s*(.+)/i);
      const ssid = ssidMatch ? ssidMatch[1].trim().replace(/^"|"$/g, '') : 'SwyftLocal';

      exec('netsh wlan show hostednetwork setting=security', (err2, stdout2) => {
        const pwdMatch = stdout2 && stdout2.match(/User Password\s*:\s*(.+)/i);
        const password = pwdMatch ? pwdMatch[1].trim() : 'swyft1234';
        resolve({ ssid, password, ip: getHotspotIP() || '192.168.137.1' });
      });
    });
  });
});

// ─── Hotspot control (Windows only) ──────────────────────────────────────────

ipcMain.handle('hotspot-start', async () => {
  if (process.platform !== 'win32') {
    return {
      success: false,
      message: 'Hotspot control is Windows-only. Use your system settings to create a hotspot, then open Swyft on the other device.',
    };
  }

  const legacyResult = await tryLegacyHostedNetwork();
  if (legacyResult.success) {
    await new Promise(r => setTimeout(r, 1500));
    const ip = getHotspotIP() || '192.168.137.1';
    return {
      ...legacyResult,
      ssid:      'SwyftLocal',
      password:  'swyft1234',
      ip,
      serverUrl: `http://${ip}:${SWYFT_PORT}`,   // fixed: was 3001
    };
  }

  const psResult = await tryPowerShellHotspot();
  if (psResult.success) {
    await new Promise(r => setTimeout(r, 2000));
    const ip = getHotspotIP() || '192.168.137.1';
    return {
      ...psResult,
      ssid:      'Your Windows Hotspot SSID',
      password:  'Your Windows Hotspot Password',
      ip,
      serverUrl: `http://${ip}:${SWYFT_PORT}`,   // fixed: was 3001
    };
  }

  shell.openExternal('ms-settings:network-mobilehotspot');
  const fallbackIP = getLANIP();
  return {
    success:        false,
    openedSettings: true,
    ip:             fallbackIP,
    serverUrl:      `http://${fallbackIP}:${SWYFT_PORT}`,   // fixed: was 3001
    message:        "Your WiFi adapter doesn't support auto hotspot. Windows Mobile Hotspot settings opened — enable it there, connect the other device to that hotspot, then open Swyft on it.",
  };
});

ipcMain.handle('hotspot-stop', async () => {
  if (process.platform !== 'win32') return { success: false };

  const legacyStop = await new Promise((resolve) => {
    exec('netsh wlan stop hostednetwork', (err) => resolve({ success: !err }));
  });
  if (legacyStop.success) return legacyStop;

  const script = `
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $ap = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]
    $profile = $ap::GetCurrentProfile()
    $mgr = $ap::CreateFromConnectionProfile($profile)
    $result = $mgr.StopTetheringAsync()
    $result.AsTask().GetAwaiter().GetResult()
  `;
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, '; ')}"`,
      (err) => resolve({ success: !err }));
  });
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
      'exit 0',
    ].join('; ');

    exec(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) resolve({ success: false, message: (stderr || err.message).trim() });
        else     resolve({ success: true, method: 'powershell' });
      }
    );
  });
}
