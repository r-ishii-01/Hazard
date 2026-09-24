/**
 * E2E のコードで使う Node.js の API の最小限の型（`npx tsc -p e2e` での型検査用）。
 * このプロジェクトは @types/node に依存していないため、使う分だけをここで宣言する。
 * （@types/node を開発依存に加えた場合は、このファイルを削除すること）
 */

declare class Buffer extends Uint8Array {
  static from(data: ArrayLike<number> | ArrayBuffer | string, encoding?: string): Buffer;
  static alloc(size: number): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  toString(encoding?: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  argv: string[];
  cwd(): string;
};

declare module 'node:zlib' {
  export function deflateSync(data: Uint8Array, options?: { level?: number }): Buffer;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function statSync(path: string): { size: number };
  export function writeFileSync(path: string, data: Uint8Array | string): void;
}

declare module 'node:crypto' {
  export class X509Certificate {
    constructor(data: string | Uint8Array);
    readonly publicKey: { export(options: { type: 'spki'; format: 'der' }): Buffer };
  }
  export function createHash(algorithm: string): { update(data: Uint8Array | string): { digest(encoding: 'base64' | 'hex'): string } };
}
