import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  ScrollView, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, radius } from '@/lib/theme';

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.bg}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Logo */}
      <View style={styles.logoWrap}>
        <Image source={require('@/assets/logo.png')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.tagline}>Fast file transfer, your way</Text>
      </View>

      {/* Mode cards */}
      <View style={styles.cards}>

        {/* Online */}
        <TouchableOpacity style={[styles.card, styles.cardOnline]} onPress={() => router.push('/online-home')} activeOpacity={0.8}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, styles.iconOnline]}>
              <Text style={styles.iconText}>🌐</Text>
            </View>
            <Text style={styles.cardTitle}>Swyft Online</Text>
            <View style={[styles.cardBadge, styles.badgeOnline]}>
              <Text style={styles.badgeOnlineText}>v1</Text>
            </View>
          </View>
          <Text style={styles.cardDesc}>Transfer files over the internet. Works between any two devices anywhere in the world.</Text>
          <View style={styles.features}>
            {['Requires internet connection', 'WebRTC peer-to-peer transfer', '6-digit PIN pairing'].map(f => (
              <View key={f} style={styles.featureRow}>
                <View style={[styles.dot, styles.dotOnline]} />
                <Text style={styles.featureText}>{f}</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>

        {/* Divider */}
        <View style={styles.divider}><Text style={styles.dividerText}>or</Text></View>

        {/* Local */}
        <TouchableOpacity style={[styles.card, styles.cardLocal]} onPress={() => router.push('/local')} activeOpacity={0.8}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, styles.iconLocal]}>
              <Text style={styles.iconText}>📡</Text>
            </View>
            <Text style={styles.cardTitle}>Swyft Local</Text>
            <View style={[styles.cardBadge, styles.badgeLocal]}>
              <Text style={styles.badgeLocalText}>WiFi</Text>
            </View>
          </View>
          <Text style={styles.cardDesc}>Transfer over WiFi without internet. Faster speeds, works completely offline.</Text>
          <View style={styles.features}>
            {['No internet needed', 'Auto device discovery on LAN', 'Accept / Decline incoming files'].map(f => (
              <View key={f} style={styles.featureRow}>
                <View style={[styles.dot, styles.dotLocal]} />
                <Text style={styles.featureText}>{f}</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>Swyft App · v1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bg:        { flex: 1, backgroundColor: colors.bg },
  container: { alignItems: 'center', paddingHorizontal: 24 },

  logoWrap:  { alignItems: 'center', marginBottom: 48 },
  logo:      { width: 200, height: 60 },
  tagline:   { color: colors.muted, fontSize: font.sm, marginTop: 8, letterSpacing: 0.3 },

  cards: { width: '100%', maxWidth: 400 },

  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: 24, marginBottom: 0,
  },
  cardOnline: {},
  cardLocal:  {},

  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cardIcon: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  iconOnline: { backgroundColor: 'rgba(99,102,241,0.15)' },
  iconLocal:  { backgroundColor: colors.greenDim },
  iconText:   { fontSize: 22 },

  cardTitle: { fontSize: font.md, fontWeight: '600', flex: 1, color: colors.white },

  cardBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99 },
  badgeOnline: { backgroundColor: 'rgba(99,102,241,0.15)' },
  badgeLocal:  { backgroundColor: colors.greenDim },
  badgeOnlineText: { color: '#818cf8', fontSize: font.xs, fontWeight: '700', textTransform: 'uppercase' },
  badgeLocalText:  { color: colors.green, fontSize: font.xs, fontWeight: '700', textTransform: 'uppercase' },

  cardDesc: { color: colors.muted, fontSize: font.sm, lineHeight: 20, marginBottom: 14 },

  features: { gap: 6 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 5, height: 5, borderRadius: 99 },
  dotOnline: { backgroundColor: '#6366f1' },
  dotLocal:  { backgroundColor: colors.green },
  featureText: { fontSize: font.xs, color: '#444' },

  divider: { alignItems: 'center', paddingVertical: 14 },
  dividerText: { color: '#2a2a2a', fontSize: font.sm },

  footer: { marginTop: 40, color: '#2e2e2e', fontSize: font.xs },
});
