import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, StyleSheet, ScrollView,
  TouchableOpacity, Platform, Alert,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing    from 'expo-sharing';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';

import SwyftHeader   from '@/components/SwyftHeader';
import SwyftButton   from '@/components/SwyftButton';
import StatusBar     from '@/components/StatusBar';
import ProgressSheet from '@/components/ProgressSheet';
import { colors, font, radius } from '@/lib/theme';
import { fmtSize, extractZip } from '@/lib/zip';
import { SwyftReceiver } from '@/lib/webrtc';
import { getOnlineSocket } from '@/lib/socket';
import { showTransferNotification, dismissTransferNotification } from '@/lib/background';

type Step       = 'pin' | 'receiving';
type StatusType = 'success' | 'error' | 'info' | null;

// ── Helper: save a file to device storage ──────────────────────────────────
// On Android uses StorageAccessFramework (lets user pick folder, e.g. Downloads).
// On iOS falls back to share sheet (standard iOS behaviour).
async function saveToDevice(uri: string, filename: string): Promise<boolean> {
  if (Platform.OS === 'android') {
    try {
      const perms = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!perms.granted) return false;
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const mime = filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
      const dest = await FileSystem.StorageAccessFramework.createFileAsync(
        perms.directoryUri, filename, mime,
      );
      await FileSystem.writeAsStringAsync(dest, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return true;
    } catch {
      return false;
    }
  }
  // iOS — share sheet is the standard save method
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
  return true;
}

export default function ReceiveScreen() {
  const router = useRouter();

  const [step,       setStep]     = useState<Step>('pin');
  const [pinValue,   setPinValue] = useState('');
  const [scanning,   setScanning] = useState(false);
  const [permission, requestPerm] = useCameraPermissions();

  const [statusMsg,  setStatusMsg]  = useState('');
  const [statusType, setStatusType] = useState<StatusType>(null);

  const [progVisible, setProgVis]   = useState(false);
  const [progPct,     setProgPct]   = useState(0);
  const [progStats,   setProgStats] = useState('Waiting…');
  const [progDone,    setProgDone]  = useState(false);
  const [savedUri,    setSavedUri]  = useState<string | null>(null);
  const [savedName,   setSavedName] = useState('');
  const [isZip,       setIsZip]     = useState(false);

  // After ZIP extract, store the list of extracted entries for individual saving
  const [extractedEntries, setExtractedEntries] = useState<{ name: string; uri: string }[]>([]);

  const receiverRef = useRef<SwyftReceiver | null>(null);
  const scannedRef  = useRef(false);

  function showStatus(msg: string, type: StatusType) { setStatusMsg(msg); setStatusType(type); }

  useEffect(() => {
    const socket = getOnlineSocket();
    receiverRef.current = new SwyftReceiver(socket, {
      onConnected: () => { setStep('receiving'); showStatus('✓ Paired with sender', 'success'); },
      onProgress:  (pct, speed, rx, total) => {
        setProgPct(pct);
        setProgStats(`${fmtSize(rx)} / ${fmtSize(total)} @ ${speed.toFixed(2)} MB/s`);
        showTransferNotification('file', pct);
      },
      onComplete: async (fileName, data) => {
        dismissTransferNotification();
        setProgDone(true);
        setProgStats(fmtSize(data.byteLength) + ' received');
        setSavedName(fileName);
        setIsZip(fileName.endsWith('.zip'));
        setExtractedEntries([]);

        // Write to cache dir
        const dest = FileSystem.cacheDirectory + fileName;
        const arr  = new Uint8Array(data);
        let b64 = '';
        // Use chunk loop to avoid string size limits on large files
        const CHUNK = 8192;
        for (let i = 0; i < arr.length; i += CHUNK) {
          b64 += String.fromCharCode(...arr.subarray(i, i + CHUNK));
        }
        await FileSystem.writeAsStringAsync(dest, btoa(b64), {
          encoding: FileSystem.EncodingType.Base64,
        });
        setSavedUri(dest);
        showStatus('✓ File received!', 'success');
      },
      onError:            (msg) => showStatus('❌ ' + msg, 'error'),
      onRemoteCancel:     ()    => { showStatus('❌ Sender cancelled', 'error'); setProgVis(false); },
      onRemoteDisconnect: ()    => { setStep('pin'); showStatus('Sender disconnected', 'info'); },
    });
    return () => { receiverRef.current?.cleanup(); };
  }, []);

  async function handleConnect() {
    const clean = pinValue.trim();
    if (!/^\d{6}$/.test(clean)) { showStatus('❌ Enter a valid 6-digit PIN', 'error'); return; }
    showStatus('Connecting…', 'info');
    setProgPct(0); setProgStats('Waiting for sender…'); setProgDone(false); setProgVis(true);
    await receiverRef.current?.connectWithPIN(clean);
  }

  async function handleScanQR() {
    if (!permission?.granted) {
      const { granted } = await requestPerm();
      if (!granted) { showStatus('Camera permission required to scan QR', 'error'); return; }
    }
    scannedRef.current = false;
    setScanning(true);
  }

  function handleBarCodeScanned({ data }: { data: string }) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanning(false);
    const pin = data.trim().replace(/\D/g, '').slice(0, 6);
    if (pin.length === 6) {
      setPinValue(pin);
      showStatus(`PIN ${pin} scanned — tap Connect`, 'success');
    } else {
      showStatus('QR code did not contain a valid PIN', 'error');
    }
  }

  // ── Save the received file to device storage ──────────────────────────────
  async function handleSave() {
    if (!savedUri) return;
    const ok = await saveToDevice(savedUri, savedName);
    if (ok) showStatus('✓ File saved!', 'success');
    else    showStatus('❌ Save failed — try again', 'error');
  }

  // ── Extract ZIP and save each file individually ───────────────────────────
  async function handleExtract() {
    if (!savedUri) return;
    try {
      showStatus('Extracting…', 'info');
      const data = await FileSystem.readAsStringAsync(savedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bin = atob(data);
      const buf = new ArrayBuffer(bin.length);
      const u8  = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const entries = await extractZip(buf);
      setExtractedEntries(entries.map(e => ({ name: e.name, uri: e.uri })));
      showStatus(`✓ Extracted ${entries.length} files — save them below`, 'success');
    } catch {
      showStatus('❌ Extraction failed', 'error');
    }
  }

  function handleBack() {
    receiverRef.current?.cleanup();
    router.back();
  }

  // ── QR Scanner overlay ─────────────────────────────────────────────────────
  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          onBarcodeScanned={handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <TouchableOpacity style={styles.scanCancel} onPress={() => setScanning(false)}>
          <Text style={styles.scanCancelText}>✕ Cancel</Text>
        </TouchableOpacity>
        <View style={styles.scanFrame} />
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <SwyftHeader badge="📥 Receive" onBack={handleBack} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.h1}>Receive a File</Text>

        {step === 'pin' && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}><Text style={styles.num}>1</Text>  Enter the 6-digit PIN</Text>
            <Text style={styles.instruction}>Get the PIN from the sender's device and type it below, or scan their QR code.</Text>
            <TextInput
              style={styles.pinInput}
              value={pinValue}
              onChangeText={t => setPinValue(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              maxLength={6}
              returnKeyType="done"
              onSubmitEditing={handleConnect}
            />
            <SwyftButton label="Connect →" onPress={handleConnect} disabled={pinValue.length !== 6} />
            <SwyftButton label="📷 Scan QR Code" variant="outline" onPress={handleScanQR} style={{ marginTop: 8 }} />
          </View>
        )}

        {step === 'receiving' && (
          <>
            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>1</Text>  Connected</Text>
              <View style={styles.connectedRow}>
                <Text style={styles.checkmark}>✓</Text>
                <Text style={styles.connectedText}>Paired with sender</Text>
              </View>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>2</Text>  Waiting for file</Text>
              <Text style={styles.instruction}>The sender will choose a file — it will arrive here automatically.</Text>
            </View>
          </>
        )}
      </ScrollView>

      <StatusBar message={statusMsg} type={statusType} />

      <ProgressSheet
        visible={progVisible}
        verb="Receiving"
        filename={savedName || 'file'}
        pct={progPct}
        stats={progStats}
        done={progDone}
        onCancel={() => { receiverRef.current?.cancelReceive(); setProgVis(false); }}
        onClose={() => setProgVis(false)}
      >
        {progDone && savedUri && (
          <View style={{ gap: 8 }}>

            {/* ── Save to device ── */}
            <TouchableOpacity style={styles.dlBtn} onPress={handleSave}>
              <Text style={styles.dlBtnText}>⬇️  Save to Device</Text>
            </TouchableOpacity>

            {/* ── ZIP: Extract button then list of extracted files ── */}
            {isZip && extractedEntries.length === 0 && (
              <SwyftButton label="📂 Extract ZIP" variant="outline" onPress={handleExtract} />
            )}

            {extractedEntries.length > 0 && (
              <View style={styles.extractedList}>
                <Text style={styles.extractedHeader}>Extracted files — tap to save each:</Text>
                {extractedEntries.map((entry, i) => (
                  <TouchableOpacity
                    key={i}
                    style={styles.extractedItem}
                    onPress={async () => {
                      const ok = await saveToDevice(entry.uri, entry.name.split('/').pop() || entry.name);
                      if (ok) showStatus(`✓ Saved: ${entry.name}`, 'success');
                      else    showStatus('❌ Save failed', 'error');
                    }}
                  >
                    <Text style={styles.extractedName} numberOfLines={1}>📄 {entry.name}</Text>
                    <Text style={styles.extractedSave}>Save ›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

          </View>
        )}
      </ProgressSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  bg:      { flex: 1, backgroundColor: colors.bg },
  scroll:  { flex: 1 },
  body:    { padding: 20, paddingBottom: 40, gap: 16 },
  h1:      { fontSize: font.xl, fontWeight: '700', color: colors.white, marginBottom: 4 },

  step:        { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 18, gap: 12 },
  stepTitle:   { fontSize: font.base, fontWeight: '700', color: colors.white },
  num:         { color: colors.green, fontWeight: '800' },
  instruction: { fontSize: font.sm, color: colors.muted, lineHeight: 18 },

  pinInput: {
    backgroundColor: '#0f0f0f', borderWidth: 1, borderColor: colors.border2,
    borderRadius: radius.md, padding: 14, fontSize: 24, fontWeight: '700',
    color: colors.white, textAlign: 'center', letterSpacing: 10,
  },

  connectedRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: '#0f0f0f', borderRadius: radius.md },
  checkmark:     { fontSize: 22, color: colors.green },
  connectedText: { fontSize: font.base, fontWeight: '500', color: 'rgba(52,211,153,0.9)' },

  dlBtn:     { backgroundColor: colors.green, borderRadius: radius.md, padding: 14, alignItems: 'center', marginBottom: 4 },
  dlBtnText: { color: '#fff', fontWeight: '700', fontSize: font.base },

  extractedList:   { backgroundColor: '#0f0f0f', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 },
  extractedHeader: { fontSize: font.xs, color: colors.muted, marginBottom: 4 },
  extractedItem:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  extractedName:   { flex: 1, fontSize: font.sm, color: '#ccc' },
  extractedSave:   { fontSize: font.sm, color: colors.green, fontWeight: '600' },

  scanCancel:     { position: 'absolute', top: 60, right: 20, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 99 },
  scanCancelText: { color: '#fff', fontWeight: '600', fontSize: font.base },
  scanFrame:      { position: 'absolute', top: '30%', left: '15%', right: '15%', bottom: '30%', borderWidth: 2, borderColor: colors.green, borderRadius: radius.md },
});