/**
 * テスト用の最小限の PNG デコーダと、同梱のミラー（public/tiles）を読む fetch の代わり（Node で使う）。
 * 8bit・非インターレースの RGB / RGBA のみ（国土地理院の標高タイルは RGB、ハザードマップポータルサイトの
 * 津波浸水想定タイルは RGBA）。
 */
interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
// 型定義（@types/node）を使わずに Node の fs を読む
const fsName = 'node:fs';
export const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
/** public/ の絶対パス（末尾に /） */
export const PUBLIC_ROOT = decodeURIComponent(new URL('../../public/', import.meta.url).pathname);

export async function decodePng(buf: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let ch = 0;
  const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8);
      h = dv.getUint32(p + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      ch = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!ch) throw new Error(`unsupported color type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of idat) {
    joined.set(a, o);
    o += a.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out.set(cur.subarray(x * ch, x * ch + 3), (y * w + x) * 4);
      out[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev = cur;
  }
  return out;
}

/** サイトの相対パス（/tiles/...）を public/ から返す fetch。https: の要求は 404（ネットワークに接続しない） */
export const mirrorFetch = async (url: string): Promise<Response> => {
  const path = `${PUBLIC_ROOT}${url.replace(/^\//, '')}`;
  if (url.startsWith('https:') || !fs.existsSync(path)) return new Response('', { status: 404 });
  return new Response(fs.readFileSync(path) as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'image/png' },
  });
};

export const decodeBlob = async (blob: Blob) => decodePng(new Uint8Array(await blob.arrayBuffer()));
