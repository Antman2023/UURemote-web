import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Read the signing material from the user's reference APK, never from the browser bundle.
// Fingerprint identifies the constant verified in ee.c, rather than distributing it here.
const SIGNING_FINGERPRINT = '40cb3a32f9f6f90d9962fb9736685bb881979e848b5956649b6dae3cc957528c';

export function zipEntry(zip, filename) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid APK ZIP directory');
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid APK entry');
    const nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === filename) {
      const local = zip.readUInt32LE(cursor + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(cursor + 20));
      const method = zip.readUInt16LE(cursor + 10);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error('Unsupported APK compression');
    }
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  throw new Error(`APK entry not found: ${filename}`);
}

export function dexStrings(dex) {
  if (dex.toString('ascii', 0, 4) !== 'dex\n') throw new Error('Invalid DEX');
  const count = dex.readUInt32LE(56), offset = dex.readUInt32LE(60), result = [];
  for (let i = 0; i < count; i++) {
    let p = dex.readUInt32LE(offset + i * 4);
    while (dex[p] & 128) p++;
    p++;
    result.push(dex.toString('utf8', p, dex.indexOf(0, p)));
  }
  return result;
}

export function loadApkSigningKey(root) {
  if (process.env.UU_API_SIGN_KEY) return process.env.UU_API_SIGN_KEY;
  const path = process.env.UU_REFERENCE_APK || join(root, 'ref', readdirSync(join(root, 'ref')).find(n => n.endsWith('.apk')) || 'missing.apk');
  const strings = dexStrings(zipEntry(readFileSync(path), 'classes.dex'));
  const key = strings.find(s => s.length === 24 && createHash('sha256').update(s).digest('hex') === SIGNING_FINGERPRINT);
  if (!key) throw new Error('Reference APK signing constant does not match version 3.5.0');
  return key;
}
