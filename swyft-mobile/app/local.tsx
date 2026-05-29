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
  Modal, Alert, Platform, AppState,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
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
  const [progVisible,  setProgVis]    = useState(false);
  const [progVerb,     setProgVerb]   = useState<'Sending' | 'Receiving'>('Sending');
  const [progFile,     setProgFile]   = useState('');
  const [progPct,      setProgPct]    = useState(0);
  const [progStats,    setProgStats]  = useState('');
  const [progDone,     setProgDone]   = useState(false);
  const [savedUri,     setSavedUri]   = useState<string | null>(null);
  const [savedName,    setSavedName]  = useState('');
  const [savedIsZip,   setSavedIsZip] = useState(false);
  const [reqVisible,   setReqVisible] = useState(false);
  const [reqData,      setReqData]    = useState<TransferRequest | null>(null);
  const [statusMsg,    setStatusMsg]  = useState('');
  const [statusType,   setStatusType] = useState<StatusType>(null);

  const tmRef = useRef<TransferManager | null>(null);

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
        setProgDone(true);
        setSavedUri(uri);
        setSavedName(fileName);
        setSavedIsZip(fileName.endsWith('.zip'));
        showStatus('✓ File received!', 'success');
      },

      onTransferError: (msg) => {
        showStatus('❌ ' + msg, 'error');
        setProgVis(false);
        setSending(null);
      },

      onRemoteCancel: () => {
        showStatus('❌ Transfer cancelled by other device', 'error');
        setProgVis(false);
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
  function respondToRequest(accepted: boolean) {
    setReqVisible(false);
    if (!reqData) return;

    tmRef.current?.respondToTransfer(reqData.sessionId, accepted);

    if (accepted) {
      setProgVerb('Receiving');
      setProgFile(reqData.files[0]?.fileName || 'file');
      setProgPct(0); setProgStats('Starting…'); setProgDone(false);
      setProgVis(true);
    }
    setReqData(null);
  }

  // ── Share / extract received file ─────────────────────────────────────────
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
            <TouchableOpacity style={styles.dlBtn} onPress={handleShare}>
              <Text style={styles.dlBtnText}>⬇️  Save / Share {savedName}</Text>
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
});