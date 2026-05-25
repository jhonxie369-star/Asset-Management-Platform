import * as crypto from 'crypto';

/**
 * MMH3 32-bit (MurmurHash3 x86_32) — FOFA/EHole favicon 指纹标准算法
 * 注意：输入是 base64 编码后的字节（每 76 字符换行，末尾 \n），符合 Python base64.b64encode 行为。
 */
export function mmh3_32(key: Buffer, seed = 0): number {
  const c1 = 0xcc9e2d51 | 0;
  const c2 = 0x1b873593 | 0;
  const len = key.length;
  const nblocks = Math.floor(len / 4);
  let h1 = seed | 0;

  for (let i = 0; i < nblocks; i++) {
    let k1 =
      (key[i * 4] & 0xff) |
      ((key[i * 4 + 1] & 0xff) << 8) |
      ((key[i * 4 + 2] & 0xff) << 16) |
      ((key[i * 4 + 3] & 0xff) << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }

  let k1 = 0;
  const tail = len & 3;
  const tailStart = nblocks * 4;
  if (tail === 3) k1 ^= (key[tailStart + 2] & 0xff) << 16;
  if (tail >= 2) k1 ^= (key[tailStart + 1] & 0xff) << 8;
  if (tail >= 1) {
    k1 ^= key[tailStart] & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 | 0; // signed int32
}

/** FOFA 风格 favicon hash：base64 编码 + 76 列换行，然后 mmh3_32 */
export function faviconHash(content: Buffer): number {
  const b64 = content.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  const encoded = Buffer.from(lines.join('\n') + '\n');
  return mmh3_32(encoded);
}

/** 简单内容 hash，用于缓存键 */
export function contentSha(content: Buffer): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}
