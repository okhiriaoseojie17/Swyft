import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import SwyftHeader from '@/components/SwyftHeader';
import { colors, font, radius } from '@/lib/theme';

export default function OnlineHomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.bg}>
      <SwyftHeader badge="🌐 Online" />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Swyft Online</Text>
        <Text style={styles.subtitle}>What would you like to do?</Text>

        <View style={styles.choices}>
          <TouchableOpacity style={styles.choice} onPress={() => router.push('/send')} activeOpacity={0.8}>
            <View style={styles.choiceIcon}><Text style={{ fontSize: 24 }}>📤</Text></View>
            <View style={styles.choiceBody}>
              <Text style={styles.choiceTitle}>Send a File</Text>
              <Text style={styles.choiceDesc}>Generate a PIN and push files to any device anywhere</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.choice} onPress={() => router.push('/receive')} activeOpacity={0.8}>
            <View style={styles.choiceIcon}><Text style={{ fontSize: 24 }}>📥</Text></View>
            <View style={styles.choiceBody}>
              <Text style={styles.choiceTitle}>Receive a File</Text>
              <Text style={styles.choiceDesc}>Enter a PIN to accept files from another device</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg:       { flex: 1, backgroundColor: colors.bg },
  body:     { alignItems: 'center', padding: 24, paddingTop: 32 },
  title:    { fontSize: font.xxl, fontWeight: '700', letterSpacing: -0.5, marginBottom: 8, color: colors.white },
  subtitle: { color: colors.muted, fontSize: font.base, marginBottom: 40 },
  choices:  { width: '100%', maxWidth: 380, gap: 14 },

  choice: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: 20,
    flexDirection: 'row', alignItems: 'center', gap: 16,
  },
  choiceIcon: {
    width: 50, height: 50, borderRadius: 13,
    backgroundColor: colors.indigoDim,
    alignItems: 'center', justifyContent: 'center',
  },
  choiceBody:  { flex: 1 },
  choiceTitle: { fontSize: font.md, fontWeight: '700', marginBottom: 4, color: colors.white },
  choiceDesc:  { fontSize: font.xs, color: colors.muted, lineHeight: 17 },
  arrow:       { color: '#2a2a2a', fontSize: 20 },
});
