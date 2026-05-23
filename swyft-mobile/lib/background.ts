import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';

export const TRANSFER_TASK = 'SWYFT_TRANSFER_TASK';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge:  false,
  }),
});

/** Show a persistent progress notification during transfer. */
export async function showTransferNotification(filename: string, pct: number) {
  await Notifications.scheduleNotificationAsync({
    identifier: 'swyft-transfer',
    content: {
      title: pct < 100 ? `Swyft — Transferring ${filename}` : `Swyft — Transfer complete`,
      body:  pct < 100 ? `${pct}% transferred…` : `${filename} received successfully`,
      data:  { type: 'transfer' },
    },
    trigger: null,
  });
}

/** Dismiss the transfer notification. */
export async function dismissTransferNotification() {
  await Notifications.dismissNotificationAsync('swyft-transfer');
}

/** Request notification permissions (called once on app launch). */
export async function requestNotificationPermissions() {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// Register background task (no-op — actual transfer runs in foreground;
// this keeps the JS runtime alive when the app is backgrounded)
TaskManager.defineTask(TRANSFER_TASK, async () => {
  return BackgroundFetch.BackgroundFetchResult.NewData;
});

export async function registerBackgroundTask() {
  try {
    await BackgroundFetch.registerTaskAsync(TRANSFER_TASK, {
      minimumInterval: 15,
      stopOnTerminate:  false,
      startOnBoot:      false,
    });
  } catch (e) {
    console.log('Background task registration skipped:', e);
  }
}
