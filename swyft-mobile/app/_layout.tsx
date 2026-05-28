import '../lib/polyfills';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { requestNotificationPermissions, registerBackgroundTask } from '@/lib/background';
import 'react-native-get-random-values';
// Prevent the splash from auto-hiding before we're ready
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        // Run all startup tasks while splash is still visible
        await Promise.all([
          requestNotificationPermissions(),
          registerBackgroundTask(),
          // Add any other async startup work here (e.g. loading assets, checking auth)
          // The splash stays visible until ALL of these finish
          new Promise(resolve => setTimeout(resolve, 500)), // minimum splash display time
        ]);
      } catch (e) {
        console.warn('Startup error:', e);
      } finally {
        setAppReady(true);
      }
    }
    prepare();
  }, []);

  useEffect(() => {
    if (appReady) {
      SplashScreen.hideAsync();
    }
  }, [appReady]);

  // Keep rendering null (splash stays visible) until ready
  if (!appReady) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#0a0a0a" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0a0a0a' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="online-home" />
        <Stack.Screen name="send" />
        <Stack.Screen name="receive" />
        <Stack.Screen name="local" />
      </Stack>
    </SafeAreaProvider>
  );
}