import JSZip from 'jszip';
import * as FileSystem from 'expo-file-system';

export interface ZipEntry {
  name: string;
  uri:  string;
  size: number;
}

/** Zip multiple files into a single ArrayBuffer. */
export async function zipFiles(uris: { uri: string; name: string }[]): Promise<{ buffer: ArrayBuffer; name: string }> {
  const zip = new JSZip();

  for (const { uri, name } of uris) {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    zip.file(name, base64, { base64: true });
  }

  const blob   = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  return { buffer: blob, name: 'archive.zip' };
}

/** Extract a ZIP ArrayBuffer and save each file to the cache directory. Returns list of saved entries. */
export async function extractZip(data: ArrayBuffer): Promise<ZipEntry[]> {
  const zip     = await JSZip.loadAsync(data);
  const entries: ZipEntry[] = [];
  const dir     = FileSystem.cacheDirectory + 'swyft-extracted/';

  // Ensure directory exists
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const content  = await file.async('base64');
    const safeName = path.replace(/\//g, '_');
    const destUri  = dir + safeName;
    await FileSystem.writeAsStringAsync(destUri, content, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const info = await FileSystem.getInfoAsync(destUri);
    entries.push({ name: path, uri: destUri, size: (info as any).size || 0 });
  }

  return entries;
}

export function fmtSize(bytes: number): string {
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes > 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}