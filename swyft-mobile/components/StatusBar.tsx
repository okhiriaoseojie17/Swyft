import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { colors, font, radius } from '@/lib/theme';

type StatusType = 'success' | 'error' | 'info' | null;

interface Props {
  message: string;
  type:    StatusType;
}

export default function StatusBar({ message, type }: Props) {
  const opacity = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!type) { Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(); return; }
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    if (type !== 'error') {
      const t = setTimeout(() => Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(), 4000);
      return () => clearTimeout(t);
    }
  }, [message, type]);

  if (!type) return null;

  return (
    <Animated.View style={[styles.bar, typeStyles[type], { opacity }]}>
      <Text style={[styles.text, { color: typeStyles[type].color }]}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar:  { borderRadius: radius.md, padding: 11, marginHorizontal: 20, marginBottom: 12, borderWidth: 1 },
  text: { fontSize: font.sm },
});

const typeStyles = {
  success: { backgroundColor: 'rgba(16,185,129,.1)',  borderColor: 'rgba(16,185,129,.2)', color: '#34d399' },
  error:   { backgroundColor: 'rgba(239,68,68,.1)',   borderColor: 'rgba(239,68,68,.2)',  color: '#f87171' },
  info:    { backgroundColor: 'rgba(255,255,255,.04)', borderColor: colors.border,         color: '#666'    },
};
