import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Alert, Platform,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';

import SwyftHeader from '@/components/SwyftHeader';
import SwyftButton from '@/components/SwyftButton';
import StatusBar   from '@/components/StatusBar';
import ProgressSheet from '@/components/ProgressSheet';
import { colors, font, radius } from '@/lib/theme';
import { fmtSize, zipFiles } from '@/lib/zip';
import { SwyftSender } from '@/lib/webrtc';
import { getOnlineSocket, disconnectOnline } from '@/lib/socket';
import { showTransferNotification, dismissTransferNotification } from '@/lib/background';

type Step = 'pin' | 'waiting' | 'transfer';
type StatusType = 'success' | 'error' | 'info' | null;

export default function SendScreen() {
  const router = useRouter();

  const [step,        setStep]       = useState<Step>('pin');
  const [pin,         setPin]        = useState('------');
  const [statusMsg,   setStatusMsg]  = useState('');
  const [statusType,  setStatusType] = useState<StatusType>(null);
  const [selectedFile, setFile]      = useState<{ uri: string; name: string; size: number } | null>(null);
  const [progVisible, setProgVis]    = useState(false);
  const [progPct,     setProgPct]    = useState(0);
  const [progStats,   setProgStats]  = useState('Starting…');
  const [progDone,    setProgDone]   = useState(false);

  const senderRef = useRef<SwyftSender | null>(null);

  function showStatus(msg: string, type: StatusType) {
    setStatusMsg(msg); setStatusType(type);
  }

  // Initialise sender once
  useEffect(() => {
    const socket = getOnlineSocket();
    senderRef.current = new SwyftSender(socket, {
      onPINReady:          (p)      => { setPin(p); setStep('waiting'); showStatus(`PIN ready: ${p}`, 'success'); },
      onConnected:         ()       => { setStep('transfer'); showStatus('✓ Connected! Select a file to send.', 'success'); },
      onProgress:          (pct, speed, sent, total) => {
        setProgPct(pct);
        setProgStats(`${fmtSize(sent)} / ${fmtSize(total)} @ ${speed.toFixed(2)} MB/s`);
        showTransferNotification(selectedFile?.name || 'file', pct);
      },
      onComplete:          ()       => { setProgDone(true); dismissTransferNotification(); showStatus('✓ File sent!', 'success'); },
      onError:             (msg)    => showStatus('❌ ' + msg, 'error'),
      onRemoteCancel:      ()       => { setProgVis(false); showStatus('❌ Receiver cancelled', 'error'); },
      onRemoteDisconnect:  ()       => { setStep('pin'); setPin('------'); showStatus('Receiver disconnected', 'info'); },
    });
    return () => { senderRef.current?.cleanup(); };
  }, []);

  async function handleGeneratePIN() {
    showStatus('Generating PIN…', 'info');
    await senderRef.current?.generatePIN({ name: '', size: 0 });
  }

  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      const assets = result.assets;
      if (assets.length === 1) {
        setFile({ uri: assets[0].uri, name: assets[0].name, size: assets[0].size || 0 });
      } else {
        // Multiple files — zip them
        showStatus('Zipping files…', 'info');
        const { buffer, name } = await zipFiles(assets.map(a => ({ uri: a.uri, name: a.name })));
        const tmpUri = FileSystem.cacheDirectory + name;
        const arr    = new Uint8Array(buffer);
        let b64 = '';
        arr.forEach(b => b64 += String.fromCharCode(b));
        await FileSystem.writeAsStringAsync(tmpUri, btoa(b64), { encoding: FileSystem.EncodingType.Base64 });
        const info = await FileSystem.getInfoAsync(tmpUri);
        setFile({ uri: tmpUri, name, size: (info as any).size || 0 });
        showStatus('✓ ZIP ready', 'success');
      }
    } catch (err: any) {
      showStatus('❌ ' + err.message, 'error');
    }
  }

  async function handleSend() {
    if (!selectedFile) { showStatus('⚠️ Select a file first', 'error'); return; }
    setProgPct(0); setProgStats('Starting…'); setProgDone(false); setProgVis(true);
    await senderRef.current?.sendFile(selectedFile.uri, selectedFile.name, selectedFile.size);
  }

  function handleCancel() {
    senderRef.current?.cancel();
    setProgVis(false);
    showStatus('Transfer cancelled', 'info');
  }

  function handleEndConnection() {
    Alert.alert('End Connection', 'Disconnect from the receiver?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => {
        senderRef.current?.endConnection();
        setStep('pin'); setPin('------'); setFile(null);
        showStatus('Connection ended', 'info');
      }},
    ]);
  }

  function handleBack() {
    senderRef.current?.endConnection();
    router.back();
  }

  function copyPIN() {
    const Clipboard = require('expo-clipboard');
    Clipboard.setStringAsync(pin);
    showStatus('PIN copied!', 'success');
  }

  return (
    <View style={styles.bg}>
      <SwyftHeader badge="📤 Send" onBack={handleBack} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.h1}>Send a File</Text>

        {/* ── STEP: PIN ──────────────────────────────────── */}
        {step === 'pin' && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}><Text style={styles.num}>1</Text>  Generate a PIN code</Text>
            <Text style={styles.instruction}>Create a one-time PIN and share it with the receiver.</Text>
            <SwyftButton label="Generate PIN" onPress={handleGeneratePIN} />
          </View>
        )}

        {/* ── STEP: WAITING ──────────────────────────────── */}
        {step === 'waiting' && (
          <>
            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>1</Text>  Share this PIN</Text>
              <View style={styles.pinDisplay}>
                <Text style={styles.pinCode}>{pin}</Text>
                <Text style={styles.pinInstruction}>Share this code with the receiver</Text>
                <SwyftButton label="📋 Copy PIN" variant="outline" onPress={copyPIN} />
              </View>
              {/* QR code of the PIN */}
              <View style={styles.qrWrap}>
                <QRCode value={pin} size={140} color={colors.indigo} backgroundColor={colors.surface} />
                <Text style={styles.qrCaption}>Receiver can scan this instead of typing</Text>
              </View>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>2</Text>  Waiting for receiver…</Text>
              <Text style={styles.instruction}>Ask the receiver to open Swyft and enter the PIN above.</Text>
              <View style={styles.waitRow}>
                <View style={styles.spinner} />
                <Text style={styles.waitText}>Waiting for receiver to connect…</Text>
              </View>
            </View>
          </>
        )}

        {/* ── STEP: TRANSFER ─────────────────────────────── */}
        {step === 'transfer' && (
          <>
            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>1</Text>  Connected</Text>
              <View style={styles.connectedRow}>
                <Text style={styles.checkmark}>✓</Text>
                <Text style={styles.connectedText}>Receiver is ready</Text>
              </View>
            </View>

            <View style={styles.step}>
              <Text style={styles.stepTitle}><Text style={styles.num}>2</Text>  Select a file to send</Text>
              <SwyftButton label="📄 Pick File(s)" onPress={pickFile} variant="outline" style={{ marginBottom: 10 }} />
              {selectedFile && (
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName}>{selectedFile.name}</Text>
                  <Text style={styles.fileSize}>{fmtSize(selectedFile.size)}</Text>
                </View>
              )}
            </View>

            <SwyftButton label="Send File →" onPress={handleSend} disabled={!selectedFile} />
            <SwyftButton label="🔌 End Connection" variant="outline" onPress={handleEndConnection} style={{ marginTop: 10 }} />
          </>
        )}

      </ScrollView>

      <StatusBar message={statusMsg} type={statusType} />

      <ProgressSheet
        visible={progVisible}
        verb="Sending"
        filename={selectedFile?.name || ''}
        pct={progPct}
        stats={progStats}
        done={progDone}
        onCancel={handleCancel}
        onClose={() => setProgVis(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bg:          { flex: 1, backgroundColor: colors.bg },
  scroll:      { flex: 1 },
  body:        { padding: 20, paddingBottom: 40, gap: 16 },
  h1:          { fontSize: font.xl, fontWeight: '700', color: colors.white, marginBottom: 4 },

  step:        { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 18, gap: 12 },
  stepTitle:   { fontSize: font.base, fontWeight: '700', color: colors.white },
  num:         { color: colors.green, fontWeight: '800' },
  instruction: { fontSize: font.sm, color: colors.muted, lineHeight: 18 },

  pinDisplay:  { backgroundColor: '#0f0f0f', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 20, alignItems: 'center', gap: 10 },
  pinCode:     { fontSize: 36, fontWeight: '800', letterSpacing: 8, color: colors.white, fontVariant: ['tabular-nums'] },
  pinInstruction: { fontSize: font.sm, color: colors.muted },

  qrWrap:      { alignItems: 'center', gap: 8, marginTop: 4 },
  qrCaption:   { fontSize: font.xs, color: colors.faint, textAlign: 'center' },

  waitRow:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spinner:     { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#1a1a1a', borderTopColor: colors.green },
  waitText:    { fontSize: font.sm, color: colors.muted },

  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: '#0f0f0f', borderRadius: radius.md },
  checkmark:    { fontSize: 22, color: colors.green },
  connectedText:{ fontSize: font.base, fontWeight: '500', color: 'rgba(52,211,153,0.9)' },

  fileInfo:    { backgroundColor: '#0f0f0f', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12 },
  fileName:    { fontSize: font.base, fontWeight: '600', color: '#ccc' },
  fileSize:    { fontSize: font.xs, color: colors.muted, marginTop: 2 },
});
