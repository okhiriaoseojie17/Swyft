import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, radius } from '@/lib/theme';

interface Props {
  badge?:    string;
  onBack?:   () => void;
  backLabel?: string;
}

export default function SwyftHeader({ badge, onBack, backLabel = '← Back' }: Props) {
  const router  = useRouter();
  const insets  = useSafeAreaInsets();

  const handleBack = () => {
    if (onBack) { onBack(); return; }
    router.back();
  };

  return (
    <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
      <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.7}>
        <Text style={styles.backText}>{backLabel}</Text>
      </TouchableOpacity>

      <Image
        source={require('@/assets/logo.png')}
        style={styles.logo}
        resizeMode="contain"
      />

      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : (
        <View style={{ width: 60 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom:  14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  backBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border2,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.sm,
  },
  backText: { color: '#777', fontSize: font.sm },
  logo: { height: 32, width: 100 },
  badge: {
    backgroundColor: colors.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
  },
  badgeText: {
    color: colors.green,
    fontSize: font.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
