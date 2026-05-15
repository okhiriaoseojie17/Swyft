const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');

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

ipcMain.handle('hotspot-start', async () => {
  if (process.platform !== 'win32') {
    return {
      success: false,
      message: 'Hotspot control is Windows-only. Use your system settings to create a hotspot, then open Swyft on the other device.'
    };
  }

  // ── Attempt 1: legacy hosted network ──────────────────────────
  const legacyResult = await tryLegacyHostedNetwork();
  if (legacyResult.success) return legacyResult;

  // ── Attempt 2: PowerShell Mobile Hotspot (Win10 1607+) ────────
  const psResult = await tryPowerShellHotspot();
  if (psResult.success) return psResult;

  // ── Attempt 3: Open Windows Settings as fallback ──────────────
  shell.openExternal('ms-settings:network-mobilehotspot');
  return {
    success: false,
    openedSettings: true,
    message:
      'Your WiFi adapter doesn\'t support automatic hotspot creation. ' +
      'Windows Mobile Hotspot settings have been opened for you — ' +
      'enable it there, then come back to Swyft. ' +
      'Connect the other device to the hotspot, then open Swyft on it.'
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