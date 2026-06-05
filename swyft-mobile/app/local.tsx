/**
 * app/local.tsx  (MOBILE)
 *
 * Local WiFi transfer screen.
 *
 * CHANGES vs old code:
 *  1. Uses updated TransferManager API (sendFiles, respondToTransfer with sessionId)
 *  2. No more peerType desktop/mobile branching in UI
 *  3. TransferRequest now carries sessionId (not transferId)
 *  4. Progress and completion callbacks unchanged — UI is mostly the same
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Modal, Alert, Platform, AppState, TextInput, ActivityIndicator,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import SwyftHeader   from '@/components/SwyftHeader';
import SwyftButton   from '@/components/SwyftButton';
import StatusBar     from '@/components/StatusBar';
import ProgressSheet from '@/components/ProgressSheet';
import { colors, font, radius } from '@/lib/theme';
import { fmtSize, zipFiles, extractZip } from '@/lib/zip';
import { SwyftPeer } from '@/lib/discovery';
import { TransferManager, TMCallbacks } from '@/lib/transferManager';
import { TransferRequest } from '@/lib/localServer';

type StatusType = 'success' | 'error' | 'info' | null;

const PLATFORM_ICON: Record<string, string> = {
  android: '📱', ios: '📱', windows: '💻', mac: '💻', linux: '💻', desktop: '💻',
};

export default function LocalScreen() {
  const router = useRouter();

  // ── State ─────────────────────────────────────────────────────────────────
  const [peers,        setPeers]      = useState<SwyftPeer[]>([]);
  const [myName,       setMyName]     = useState('This Device');
  const [myIP,         setMyIP]       = useState('');
  const [selectedFiles, setFiles]     = useState<{ uri: string; name: string; size: number }[] | null>(null);
  const [sending,      setSending]    = useState<string | null>(null);  // peer fingerprint
  const [manualIP,     setManualIP]   = useState('');
  const [manualStatus, setManualStatus] = useState<{msg:string; type:'ok'|'err'|'loading'}|null>(null);
  const [corpOpen,     setCorpOpen]   = useState(false);
  const [progVisible,  setProgVis]    = useState(false);
  const [progVerb,     setProgVerb]   = useState<'Sending' | 'Receiving'>('Sending');
  const [progFile,     setProgFile]   = useState('');
  const [progPct,      setProgPct]    = useState(0);
  const [progStats,    setProgStats]  = useState('');
  const [progDone,     setProgDone]   = useState(false);
  const [savedUri,     setSavedUri]   = useState<string | null>(null);
  const [savedName,    setSavedName]  = useState('');
  const [savedIsZip,   setSavedIsZip] = useState(false);
  const [savedMimeType, setSavedMimeType] = useState<string>('');
  const [reqVisible,   setReqVisible] = useState(false);
  const [reqData,      setReqData]    = useState<TransferRequest | null>(null);
  const [statusMsg,    setStatusMsg]  = useState('');
  const [statusType,   setStatusType] = useState<StatusType>(null);

  const tmRef        = useRef<TransferManager | null>(null);
  // Stores the fake-progress interval used while receiving (see respondToRequest).
  // Kept in a ref so onTransferComplete / onTransferError can clear it immediately
  // instead of letting it keep ticking after the transfer finishes.
  const pendingMimeTypeRef = useRef<string>('');
  // Stores the fake-progress interval used while receiving (see respondToRequest).
  // Kept in a ref so onTransferComplete / onTransferError can clear it immediately
  // instead of letting it keep ticking after the transfer finishes.
  const fakeProgRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  function showStatus(msg: string, type: StatusType) {
    setStatusMsg(msg); setStatusType(type);
  }

  // ── Init TransferManager ──────────────────────────────────────────────────
  useEffect(() => {
    const callbacks: TMCallbacks = {
      onPeersChanged: (p) => setPeers(p),

      onIncomingRequest: (req) => {
        setReqData(req);
        setReqVisible(true);
      },

      onTransferProgress: (pct, speed, sent, total) => {
        setProgPct(pct);
        setProgStats(
          speed > 0
            ? `${fmtSize(sent)} / ${fmtSize(total)} @ ${speed.toFixed(2)} MB/s`
            : `${fmtSize(sent)} / ${fmtSize(total)}`
        );
      },

      onTransferComplete: (fileName, uri) => {
        // Kill the fake progress animation immediately so it doesn't keep
        // ticking past 100% after the transfer has already finished.
        if (fakeProgRef.current) {
          clearInterval(fakeProgRef.current);
          fakeProgRef.current = null;
        }
        // Strip the sessionId prefix the server adds to the cache filename
        // e.g. "abc123_myfile.pdf" → "myfile.pdf" for display
        const displayName = fileName.includes('_')
          ? fileName.substring(fileName.indexOf('_') + 1)
          : fileName;
        setProgPct(100);
        setProgStats('File received — tap below to save');
        setProgDone(true);
        setSavedUri(uri);
        setSavedName(displayName);
        setSavedIsZip(displayName.endsWith('.zip'));
        setSavedMimeType(pendingMimeTypeRef.current);
        showStatus('✓ File received!', 'success');
      },

      onTransferError: (msg) => {
        // Also stop the fake animation on error
        if (fakeProgRef.current) {
          clearInterval(fakeProgRef.current);
          fakeProgRef.current = null;
        }
        showStatus('❌ ' + msg, 'error');
        setProgVis(false);
        setSending(null);
      },

      onRemoteCancel: () => {
        // BUGFIX: also dismiss the incoming-request prompt if it's still showing.
        // Previously, if the sender cancelled before the user tapped Accept/Decline,
        // the request sheet stayed visible and could still be acted on.
        setReqVisible(false);
        setReqData(null);
        showStatus('❌ Transfer cancelled by other device', 'error');
        setProgVis(false);
        setSending(null);
      },

      onSendComplete: () => {
        setProgDone(true);
        showStatus('✓ File sent!', 'success');
      },
    };

    const tm = new TransferManager(callbacks);
    tmRef.current = tm;

    tm.start().then(() => {
      setMyName(tm.getAlias());
      setMyIP(tm.getIP());
  showStatus('✓ Searching for nearby devices…', 'info');
    }).catch(err => {
      showStatus('⚠️ Could not start local server: ' + err.message, 'error');
    });

    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        tm.start().catch(() => {});
      }
    });

    return () => {
      sub.remove();
      tm.stop();
    };
  }, []);

  // ── Pick file(s) ──────────────────────────────────────────────────────────
  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true, copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const assets = result.assets;

      if (assets.length === 1) {
        setFiles([{ uri: assets[0].uri, name: assets[0].name, size: assets[0].size || 0 }]);
        showStatus(`✓ Ready: ${assets[0].name}`, 'success');
      } else {
        showStatus('Zipping ' + assets.length + ' files…', 'info');
        const { buffer, name } = await zipFiles(assets.map(a => ({ uri: a.uri, name: a.name })));
        const tmpUri = FileSystem.cacheDirectory + name;
        const arr = new Uint8Array(buffer);
        let b64 = ''; arr.forEach(b => b64 += String.fromCharCode(b));
        await FileSystem.writeAsStringAsync(tmpUri, btoa(b64), {
          encoding: FileSystem.EncodingType.Base64,
        });
        const info = await FileSystem.getInfoAsync(tmpUri);
        setFiles([{ uri: tmpUri, name, size: (info as any).size || 0 }]);
        showStatus('✓ ZIP ready — tap a device to send', 'success');
      }
    } catch (err: any) {
      showStatus('❌ ' + err.message, 'error');
    }
  }

  // ── Tap a peer → send ─────────────────────────────────────────────────────
  async function handlePeerTap(peer: SwyftPeer) {
    if (!selectedFiles) {
      showStatus('⚠️ Pick a file first, then tap a device', 'error'); return;
    }
    if (sending) return;

    setSending(peer.fingerprint);
    showStatus(`Waiting for ${peer.alias} to accept…`, 'info');

    // Open progress sheet immediately so user sees feedback
    setProgVerb('Sending');
    setProgFile(selectedFiles.map(f => f.name).join(', '));
    setProgPct(0); setProgStats('Waiting for acceptance…'); setProgDone(false);
    setProgVis(true);

    try {
      await tmRef.current!.sendFiles(peer, selectedFiles);
    } catch (err: any) {
      showStatus('❌ ' + err.message, 'error');
      setProgVis(false);
    } finally {
      setSending(null);
    }
  }

  // ── Accept / decline incoming ─────────────────────────────────────────────
  // ── Manual IP connect ──────────────────────────────────────────────────────
  async function connectManualIP() {
    let ip = manualIP.trim().replace(/^https?:\/\//i, '').split(':')[0];
    if (!ip || !/^[\d.]+$/.test(ip)) {
      setManualStatus({ msg: 'Enter a valid IP (e.g. 192.168.1.42)', type: 'err' });
      return;
    }
    setManualStatus({ msg: `Connecting to ${ip}…`, type: 'loading' });
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res   = await fetch(`http://${ip}:53317/info`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info  = await res.json();

      // Build a peer object matching SwyftPeer shape and inject into peer list
      const peer = {
        alias:       info.alias       || ip,
        version:     info.version     || '2.0',
        deviceModel: info.deviceModel || 'Unknown',
        deviceType:  info.deviceType  || 'desktop',
        fingerprint: info.fingerprint || ip,
        port:        info.port        || 53317,
        protocol:    'http' as const,
        download:    true,
        ip,
        lastSeen:    Date.now(),
        baseUrl:     `http://${ip}:53317`,
      };

      // Merge into peers list without duplicates
      setPeers(prev => {
        const filtered = prev.filter(p => p.fingerprint !== peer.fingerprint && p.ip !== ip);
        return [...filtered, peer];
      });
      setManualStatus({ msg: `✓ Found ${peer.alias} — tap the card to send`, type: 'ok' });
      setManualIP('');
    } catch (err: any) {
      setManualStatus({
        msg: err.name === 'AbortError'
          ? 'Timed out — is Swyft open on that device?'
          : 'Could not connect: ' + err.message,
        type: 'err',
      });
    }
  }

  function respondToRequest(accepted: boolean) {
    setReqVisible(false);
    if (!reqData) return;

    // Capture the mime type now — reqData is cleared after this function returns
    if (accepted) {
      pendingMimeTypeRef.current = reqData.files[0]?.fileType || '';
    }

    tmRef.current?.respondToTransfer(reqData.sessionId, accepted);

    if (accepted) {
      setProgVerb('Receiving');
      setProgFile(reqData.files[0]?.fileName || 'file');
      setProgPct(0); setProgStats('Receiving file…'); setProgDone(false);
      setProgVis(true);

      // expo-http-server gives no streaming progress events on the receiving side —
      // the bar would sit at 0% until onTransferComplete fires.
      // Instead we animate the bar: fast to 80% over ~2s (17 steps × 120ms),
      // then slow creep (one tick per 400ms) so it never looks completely stuck.
      // onTransferComplete (or onTransferError) clears fakeProgRef and snaps to 100%.
      let step = 0;
      const FAST_STEPS  = 17;   // 17 × 120ms = 2.04s → reaches 80%
      const FAST_MS     = 120;
      const SLOW_MS     = 400;

      // Fast phase
      const fastIv = setInterval(() => {
        step++;
        setProgPct(Math.round((step / FAST_STEPS) * 80));
        if (step >= FAST_STEPS) {
          clearInterval(fastIv);
          // Slow creep phase — adds 1% roughly every 400ms, capped at 95%
          let slowPct = 80;
          const slowIv = setInterval(() => {
            if (slowPct < 95) {
              slowPct++;
              setProgPct(slowPct);
            }
          }, SLOW_MS);
          fakeProgRef.current = slowIv;
        }
      }, FAST_MS);
      // Store fastIv too so an early completion clears it
      fakeProgRef.current = fastIv;
    }
    setReqData(null);
  }

  // ── Save received file to device storage ─────────────────────────────────
  // • Images / videos  → MediaLibrary.saveToLibraryAsync() → Photos / Gallery
  // • Everything else  → StorageAccessFramework (SAF) → user picks destination
  //                      (usually Downloads, but they can choose anywhere)
  // A share fallback is provided if SAF is unavailable.
  async function handleSaveToDevice() {
    if (!savedUri) return;

    const mimeType = savedMimeType || '';
    const isMedia  = mimeType.startsWith('image/') || mimeType.startsWith('video/');

    if (isMedia) {
      // ── Gallery path ────────────────────────────────────────────────────
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission needed',
          'Allow storage access in Settings to save files to your gallery.',
        );
        return;
      }
      try {
        await MediaLibrary.saveToLibraryAsync(savedUri);
        showStatus('✓ Saved to gallery!', 'success');
      } catch (err: any) {
        showStatus('❌ Could not save to gallery: ' + err.message, 'error');
      }
      return;
    }

    // ── SAF path (documents, ZIPs, APKs, etc.) ──────────────────────────
    // StorageAccessFramework lets the user pick a folder / filename — no
    // root access or MANAGE_EXTERNAL_STORAGE permission required.
    const SAF = FileSystem.StorageAccessFramework;
    if (!SAF) {
      // Older Expo SDK or iOS — fall back to share sheet
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(savedUri);
      return;
    }

    try {
      const permissions = await SAF.requestDirectoryPermissionsAsync();
      if (!permissions.granted) return;

      // Create the file in the user-chosen directory
      const destUri = await SAF.createFileAsync(
        permissions.directoryUri,
        savedName,
        mimeType || 'application/octet-stream',
      );

      // Copy contents from cache → chosen destination
      const base64 = await FileSystem.readAsStringAsync(savedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await SAF.writeAsStringAsync(destUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      showStatus('✓ File saved!', 'success');
    } catch (err: any) {
      // User cancelled the folder picker — not an error
      if (err.message?.includes('cancelled') || err.message?.includes('canceled')) return;
      showStatus('❌ Could not save file: ' + err.message, 'error');
    }
  }

  async function handleShare() {
    if (!savedUri) return;
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(savedUri);
  }

  async function handleExtractZip() {
    if (!savedUri) return;
    try {
      const b64 = await FileSystem.readAsStringAsync(savedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const u8  = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const entries = await extractZip(buf);
      showStatus(`✓ Extracted ${entries.length} files to cache`, 'success');
    } catch (err: any) {
      showStatus('❌ Extract failed: ' + err.message, 'error');
    }
  }

  function handleBack() {
    tmRef.current?.stop();
    router.back();
  }

  const totalSelectedSize = selectedFiles?.reduce((s, f) => s + f.size, 0) ?? 0;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.bg}>
      <SwyftHeader badge="📡 Local" onBack={handleBack} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>

        {/* ── This device ───────────────────────────────────────── */}
        <View style={styles.deviceBar}>
          <View style={styles.dotPulse} />
          <View style={{ flex: 1 }}>
            <Text style={styles.deviceName}>{myName}</Text>
            {myIP ? <Text style={styles.deviceIP}>{myIP}</Text> : null}
          </View>
          <View style={styles.onlineDot} />
          <Text style={styles.onlineLabel}>Ready</Text>
        </View>

        {/* ── File picker ───────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>File to Send</Text>
          <SwyftButton label="📄 Pick File(s)" variant="outline" onPress={pickFile} />
          {selectedFiles && (
            <View style={styles.fileInfo}>
              <Text style={styles.fileName} numberOfLines={1}>
                {selectedFiles.length === 1
                  ? selectedFiles[0].name
                  : `${selectedFiles.length} files`}
              </Text>
              <Text style={styles.fileSize}>{fmtSize(totalSelectedSize)}</Text>
            </View>
          )}
          {!selectedFiles && (
            <Text style={styles.hintText}>Pick a file first, then tap a device below to send it</Text>
          )}
        </View>

        {/* ── Nearby devices ────────────────────────────────────── */}
        <View>
          <View style={styles.peersHeader}>
            <Text style={styles.sectionTitle}>Nearby Devices</Text>
            <View style={styles.scanRow}>
              <View style={styles.spinner} />
              <Text style={styles.scanText}>Scanning…</Text>
              <Text style={styles.peerCount}>{peers.length} found</Text>
            </View>
          </View>

          {peers.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📡</Text>
              <Text style={styles.emptyTitle}>No devices found yet</Text>
              <Text style={styles.emptyDesc}>
                Make sure the other device has Swyft open and is on the same WiFi network.
                {'\n\n'}Both phones and the desktop app will appear here automatically.
              </Text>
            </View>
          ) : (
            <View style={styles.peerList}>
              {peers.map(peer => (
                <TouchableOpacity
                  key={peer.fingerprint}
                  style={[styles.peerCard, sending === peer.fingerprint && styles.peerCardConnecting]}
                  onPress={() => handlePeerTap(peer)}
                  activeOpacity={0.8}
                  disabled={!!sending}
                >
                  <View style={styles.peerAvatar}>
                    <Text style={{ fontSize: 22 }}>{PLATFORM_ICON[peer.deviceType] || '📱'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.peerName}>{peer.alias}</Text>
                    <Text style={styles.peerSub}>
                      {peer.deviceType} · {peer.ip}
                      {sending === peer.fingerprint ? ' · Sending…' : ''}
                    </Text>
                  </View>
                  {sending === peer.fingerprint
                    ? <View style={styles.peerSpinner} />
                    : <Text style={styles.peerArrow}>
                        {selectedFiles ? '↑ Send' : '›'}
                      </Text>
                  }
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ── Corporate network / manual IP connect ────────────── */}
        <View style={styles.corpWrapper}>
          {/* Toggle button */}
          <TouchableOpacity
            style={[styles.corpToggle, corpOpen && styles.corpToggleOpen]}
            onPress={() => { setCorpOpen(o => !o); setManualStatus(null); }}
            activeOpacity={0.8}
          >
            <View style={styles.corpToggleLeft}>
              <Text style={styles.corpToggleIcon}>🏢</Text>
              <Text style={[styles.corpToggleText, corpOpen && styles.corpToggleTextOpen]}>
                Using a corporate network?
              </Text>
            </View>
            <Text style={[styles.corpToggleArrow, corpOpen && styles.corpToggleArrowOpen]}>▼</Text>
          </TouchableOpacity>

          {/* Dropdown panel */}
          {corpOpen && (
            <View style={styles.corpDropdown}>
              <Text style={styles.corpHint}>{'On managed or corporate WiFi, automatic discovery is usually blocked. Enter the other device\'s IP to connect directly.\n\nFind the IP under the scanning bar on the other device (e.g. 192.168.1.42).'}</Text>
              <View style={styles.manualIPRow}>
                <TextInput
                  style={styles.manualIPInput}
                  value={manualIP}
                  onChangeText={setManualIP}
                  placeholder="e.g. 192.168.1.42"
                  placeholderTextColor="#555"
                  keyboardType="numeric"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={connectManualIP}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={[styles.manualIPBtn, manualStatus?.type === 'loading' && { opacity: 0.6 }]}
                  onPress={connectManualIP}
                  activeOpacity={0.8}
                  disabled={manualStatus?.type === 'loading'}
                >
                  {manualStatus?.type === 'loading'
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.manualIPBtnText}>🔍 Search</Text>
                  }
                </TouchableOpacity>
              </View>
              {manualStatus && (
                <Text style={[styles.manualIPStatus,
                  manualStatus.type === 'ok'      ? styles.manualOk      :
                  manualStatus.type === 'err'     ? styles.manualErr     :
                                                    styles.manualLoading
                ]}>
                  {manualStatus.msg}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* ── How it works note ─────────────────────────────────── */}
        <View style={styles.noteCard}>
          <Text style={styles.noteTitle}>💡 How it works</Text>
          <Text style={styles.noteText}>
            Swyft automatically finds other devices on the same WiFi — no pairing or QR scanning needed.
            {'\n\n'}Both devices can send and receive. Either side can initiate a transfer.
            {'\n\n'}Works with the Swyft desktop app too — just open Swyft Local on the desktop.
          </Text>
        </View>

      </ScrollView>

      <StatusBar message={statusMsg} type={statusType} />

      {/* ── Incoming request sheet ──────────────────────────────── */}
      <Modal visible={reqVisible} transparent animationType="slide" statusBarTranslucent>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetIcon}>📥</Text>
            <Text style={styles.sheetTitle}>Incoming File</Text>
            <Text style={styles.sheetFrom}>from {reqData?.from}</Text>
            <View style={styles.sheetFile}>
              <Text style={styles.sheetFileName} numberOfLines={2}>
                {reqData?.files.map(f => f.fileName).join(', ')}
              </Text>
              <Text style={styles.sheetFileSize}>
                {reqData ? fmtSize(reqData.files.reduce((s, f) => s + f.size, 0)) : ''}
              </Text>
            </View>
            <View style={styles.sheetBtns}>
              <SwyftButton label="✕ Decline" variant="red"   onPress={() => respondToRequest(false)} style={{ flex: 1 }} />
              <SwyftButton label="✓ Accept"  variant="green" onPress={() => respondToRequest(true)}  style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Transfer progress ────────────────────────────────────── */}
      <ProgressSheet
        visible={progVisible}
        verb={progVerb}
        filename={progFile}
        pct={progPct}
        stats={progStats}
        done={progDone}
        onCancel={async () => {
          await tmRef.current?.cancelTransfer();
          setProgVis(false);
          showStatus('Transfer cancelled', 'info');
        }}
        onClose={() => setProgVis(false)}
      >
        {progDone && savedUri && (
          <View style={{ gap: 8 }}>
            <TouchableOpacity style={styles.dlBtn} onPress={handleSaveToDevice}>
              <Text style={styles.dlBtnText}>⬇️  Save {savedName}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
              <Text style={styles.shareBtnText}>↗️  Share / Forward</Text>
            </TouchableOpacity>
            {savedIsZip && (
              <SwyftButton label="📂 Extract ZIP" variant="outline" onPress={handleExtractZip} />
            )}
          </View>
        )}
      </ProgressSheet>
    </View>
  );
}

// Styles unchanged from original — visual design is preserved
const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  body:   { padding: 20, paddingBottom: 60, gap: 16 },
  sectionTitle: {
    fontSize: font.xs, fontWeight: '700', color: colors.faint,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
  },
  deviceBar: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  dotPulse:    { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  deviceName:  { fontSize: font.sm, fontWeight: '600', color: '#ccc' },
  deviceIP:    { fontSize: font.xs, color: '#383838', marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  onlineDot:   { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  onlineLabel: { fontSize: font.xs, color: colors.green },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 16, gap: 10,
  },
  fileInfo: { backgroundColor: '#0f0f0f', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12 },
  fileName: { fontSize: font.base, fontWeight: '600', color: '#ccc' },
  fileSize: { fontSize: font.xs, color: colors.muted, marginTop: 2 },
  hintText: { fontSize: font.xs, color: colors.muted, textAlign: 'center', lineHeight: 17 },
  peersHeader: { marginBottom: 10 },
  scanRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spinner:     { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#1a1a1a', borderTopColor: colors.green },
  scanText:    { fontSize: font.xs, color: colors.muted, flex: 1 },
  peerCount:   { fontSize: font.xs, color: colors.green },
  emptyCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 28, alignItems: 'center', borderStyle: 'dashed',
  },
  emptyIcon:  { fontSize: 36, marginBottom: 12 },
  emptyTitle: { fontSize: font.base, fontWeight: '600', color: colors.white, marginBottom: 8 },
  emptyDesc:  { fontSize: font.xs, color: colors.muted, textAlign: 'center', lineHeight: 18 },
  peerList: { gap: 8 },
  peerCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  peerCardConnecting: { opacity: 0.6 },
  peerAvatar:  { width: 44, height: 44, borderRadius: 11, backgroundColor: colors.greenDim, alignItems: 'center', justifyContent: 'center' },
  peerName:    { fontSize: font.base, fontWeight: '600', color: colors.white },
  peerSub:     { fontSize: font.xs, color: colors.muted, marginTop: 2 },
  peerArrow:   { color: colors.green, fontSize: font.sm, fontWeight: '700' },
  peerSpinner: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#1a1a1a', borderTopColor: colors.green },
  noteCard: {
    backgroundColor: 'rgba(16,185,129,0.04)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)',
    borderRadius: radius.md, padding: 16, gap: 8,
  },
  /* Corporate network toggle */
  corpWrapper:          { marginBottom: 0 },
  corpToggle:           {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#111', borderWidth: 1, borderColor: '#222',
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 13,
  },
  corpToggleOpen:       { borderColor: '#10b981', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  corpToggleLeft:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  corpToggleIcon:       { fontSize: 15 },
  corpToggleText:       { fontSize: 13, fontWeight: '600', color: '#666' },
  corpToggleTextOpen:   { color: '#10b981' },
  corpToggleArrow:      { fontSize: 11, color: '#666' },
  corpToggleArrowOpen:  { color: '#10b981', transform: [{ rotate: '180deg' }] },
  corpDropdown:         {
    backgroundColor: '#111', borderWidth: 1, borderColor: '#10b981',
    borderTopWidth: 0, borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
    padding: 16,
  },
  corpHint:             { fontSize: 12, color: '#666', lineHeight: 18, marginBottom: 12 },
  manualIPRow:          { flexDirection: 'row', gap: 8 },
  manualIPInput:        {
    flex: 1, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    color: '#fff', fontSize: 14,
  },
  manualIPBtn:          {
    backgroundColor: '#10b981', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center', alignItems: 'center',
  },
  manualIPBtnText:      { color: '#fff', fontWeight: '700', fontSize: 13 },
  manualIPStatus:       { fontSize: 12, marginTop: 10 },
  manualOk:             { color: '#10b981' },
  manualErr:            { color: '#ef4444' },
  manualLoading:        { color: '#888' },
  noteTitle: { fontSize: font.sm, fontWeight: '700', color: 'rgba(16,185,129,0.6)' },
  noteText:  { fontSize: font.xs, color: '#3a3a3a', lineHeight: 18 },
  overlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,.85)', justifyContent: 'flex-end' },
  sheet:      { backgroundColor: '#161616', borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: colors.border2, padding: 24, paddingBottom: 36 },
  sheetHandle:   { width: 36, height: 4, backgroundColor: colors.border2, borderRadius: 99, alignSelf: 'center', marginBottom: 22 },
  sheetIcon:     { fontSize: 38, textAlign: 'center', marginBottom: 14 },
  sheetTitle:    { fontSize: font.lg, fontWeight: '700', textAlign: 'center', color: colors.white, marginBottom: 6 },
  sheetFrom:     { fontSize: font.base, color: colors.green, textAlign: 'center', marginBottom: 16, fontWeight: '500' },
  sheetFile:     { backgroundColor: '#0f0f0f', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12, marginBottom: 22, alignItems: 'center' },
  sheetFileName: { fontSize: font.base, fontWeight: '600', color: '#ddd', textAlign: 'center' },
  sheetFileSize: { fontSize: font.xs, color: colors.muted, marginTop: 3 },
  sheetBtns:     { flexDirection: 'row', gap: 10 },
  dlBtn:     { backgroundColor: colors.green, borderRadius: radius.md, padding: 14, alignItems: 'center' },
  dlBtnText: { color: '#fff', fontWeight: '700', fontSize: font.base },
  shareBtn:     { backgroundColor: 'transparent', borderRadius: radius.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  shareBtnText: { color: colors.muted, fontWeight: '600', fontSize: font.base },
});