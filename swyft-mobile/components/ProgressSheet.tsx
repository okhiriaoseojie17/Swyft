import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, Animated } from 'react-native';
import { colors, font, radius } from '@/lib/theme';
import { fmtSize } from '@/lib/zip';
import SwyftButton from './SwyftButton';

interface Props {
  visible:   boolean;
  verb:      string;         // 'Sending' | 'Receiving'
  filename:  string;
  pct:       number;
  stats:     string;
  done:      boolean;
  onCancel:  () => void;
  onClose:   () => void;
  children?: React.ReactNode; // download buttons injected after completion
}

export default function ProgressSheet({ visible, verb, filename, pct, stats, done, onCancel, onClose, children }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>{done ? (verb === 'Sending' ? '✓ Sent!' : '✓ Received!') : `${verb}…`}</Text>
          <Text style={styles.filename} numberOfLines={2}>{filename}</Text>

          {/* Progress bar */}
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%` as any }]} />
          </View>

          <Text style={styles.stats}>{stats}</Text>

          {/* Download/action area */}
          {done && children}

          {/* Buttons */}
          {!done && (
            <SwyftButton label="✕ Cancel" variant="outline" onPress={onCancel} style={{ marginTop: 10 }} />
          )}
          {done && (
            <SwyftButton label="Close" variant="outline" onPress={onClose} style={{ marginTop: 8 }} />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#161616',
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border2,
    padding: 24, paddingBottom: 36,
  },
  handle: {
    width: 36, height: 4, backgroundColor: colors.border2,
    borderRadius: 99, alignSelf: 'center', marginBottom: 20,
  },
  title:    { fontSize: font.md, fontWeight: '700', color: colors.white, marginBottom: 4 },
  filename: { fontSize: font.sm, color: colors.muted, marginBottom: 18 },
  track:    { height: 7, backgroundColor: '#1a1a1a', borderRadius: 99, overflow: 'hidden', marginBottom: 8 },
  fill:     { height: '100%', backgroundColor: colors.green, borderRadius: 99 },
  stats:    { fontSize: font.xs, color: '#444', textAlign: 'center', marginBottom: 16 },
});
