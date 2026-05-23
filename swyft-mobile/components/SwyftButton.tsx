import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native';
import { colors, font, radius } from '@/lib/theme';

type Variant = 'green' | 'red' | 'amber' | 'outline' | 'ghost';

interface Props {
  label:     string;
  onPress:   () => void;
  variant?:  Variant;
  disabled?: boolean;
  loading?:  boolean;
  style?:    ViewStyle;
}

export default function SwyftButton({ label, onPress, variant = 'green', disabled, loading, style }: Props) {
  const vs = variantStyles[variant];
  return (
    <TouchableOpacity
      style={[styles.btn, vs.btn, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
    >
      {loading
        ? <ActivityIndicator color={vs.textColor} size="small" />
        : <Text style={[styles.label, { color: vs.textColor }]}>{label}</Text>
      }
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: '100%', paddingVertical: 13, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  label:   { fontSize: font.base, fontWeight: '600', letterSpacing: -0.1 },
  disabled:{ opacity: 0.35 },
});

const variantStyles: Record<Variant, { btn: object; textColor: string }> = {
  green:   { btn: { backgroundColor: colors.green },                                                      textColor: '#fff' },
  red:     { btn: { backgroundColor: colors.redDim, borderWidth: 1, borderColor: 'rgba(239,68,68,.25)' }, textColor: '#f87171' },
  amber:   { btn: { backgroundColor: colors.amberDim, borderWidth: 1, borderColor: 'rgba(245,158,11,.25)' }, textColor: colors.amber },
  outline: { btn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border2 },        textColor: '#666' },
  ghost:   { btn: { backgroundColor: 'transparent' },                                                     textColor: colors.muted },
};
