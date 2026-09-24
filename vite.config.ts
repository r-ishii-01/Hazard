import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

/*
 * 第三者ソフトウェアのライセンス表示（public/THIRD_PARTY_LICENSES.txt）
 *
 * ビルドした JavaScript には MapLibre GL JS（BSD-3-Clause）・three.js（MIT）などが含まれる。MIT・BSD 系のライセンスは
 * 配布物に著作権表示とライセンス条文を含めることを求めているので、
 * - 最小化しても `@license` のコメント（MapLibre GL JS・three.js の先頭の表示）を残す（build.rolldownOptions.output.comments）。
 * - 配布物に含まれる npm パッケージの著作権表示とライセンス条文を public/THIRD_PARTY_LICENSES.txt にまとめる
 *   （公開したサイトでは ./THIRD_PARTY_LICENSES.txt）。
 * - `npm run build` のたびに、配布物に含まれるパッケージがすべてこのファイルに載っているかを確かめ、足りなければビルドを失敗させる。
 * - `npm run licenses`（= vite build --mode licenses。出力は書き出さない）で、実際にビルドに含まれるパッケージからこのファイルを作り直す。
 * 配布物に含まれるパッケージは、各チャンクのモジュールの ID（node_modules/<パッケージ>/…）と、ビルド済みの配布ファイルに付いている
 * source map の sources（MapLibre GL JS の dist が内部に含む earcut・gl-matrix など）から調べる。
 */

export const THIRD_PARTY_NOTICES_FILE = 'THIRD_PARTY_LICENSES.txt';

/** fs のうち使う分だけの型（このプロジェクトは @types/node に依存しないため） */
interface NodeFsSubset {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string): void;
}

async function nodeFs(): Promise<NodeFsSubset> {
  const name = 'node:fs';
  return (await import(/* @vite-ignore */ name)) as NodeFsSubset;
}

/** モジュールの ID → npm パッケージ名（node_modules の外・不明な仮想モジュールは null） */
export function packageNameOfModule(id: string): string | null {
  // ビルドが挿入する実行時の補助コード（\0vite/modulepreload-polyfill.js・\0vite/preload-helper.js・\0rolldown/runtime.js）
  const virtual = /^\0(vite|rolldown)\//.exec(id);
  if (virtual) return virtual[1];
  const path = id.replace(/\\/g, '/').split('?')[0];
  const i = path.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const m = /^((?:@[^/]+\/)?[^/]+)\//.exec(path.slice(i + '/node_modules/'.length));
  return m ? m[1] : null;
}

/** source map の sources（"../node_modules/earcut/src/earcut.js" など）に現れるパッケージ名 */
export function packagesInSourceMap(sources: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    const name = packageNameOfModule(s.replace(/^(?:\.\.?\/)+/, '/'));
    if (name) out.add(name);
  }
  return [...out].sort();
}

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  repository: string;
  /** ライセンス条文（パッケージに含まれるファイルのまま） */
  text: string;
}

/** package.json の repository を https の URL に */
function repositoryUrl(pkg: { repository?: string | { url?: string }; homepage?: string }): string {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

const LICENSE_FILE_RE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

/**
 * パッケージのライセンス条文を読む。
 * - 通常はパッケージ直下の LICENSE* / COPYING* のファイルをそのまま使う。
 * - vite の LICENSE.md は Vite 自身が同梱する依存パッケージの条文も含む（このサイトの配布物に入るのは Vite の実行時の補助コードだけ）ので、
 *   「# Licenses of bundled dependencies」より前（Vite 本体の MIT ライセンス）だけを使う。
 * - murmurhash-js は LICENSE ファイルが無く、README の「## License (MIT)」の節に条文がある。
 */
function readLicenseText(fs: NodeFsSubset, dir: string, name: string): string {
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE_RE.test(f));
  let text = '';
  if (file) {
    text = fs.readFileSync(`${dir}/${file}`, 'utf8');
    if (name === 'vite') {
      const cut = text.indexOf('# Licenses of bundled dependencies');
      if (cut > 0) text = text.slice(0, cut);
    }
  } else {
    const readme = fs.readdirSync(dir).find((f) => /^readme(\.md)?$/i.test(f));
    const body = readme ? fs.readFileSync(`${dir}/${readme}`, 'utf8') : '';
    const i = body.search(/^#+ *Licen[cs]e\b.*$/im);
    if (i >= 0) text = body.slice(i);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!text) throw new Error(`${name} のライセンス条文が見つかりません（${dir}）`);
  return text;
}

/** node_modules からパッケージの情報を読む（入れ子の node_modules も探す） */
export async function readPackageInfo(root: string, name: string): Promise<PackageInfo> {
  const fs = await nodeFs();
  const candidates = [`${root}/node_modules/${name}`];
  // ホイストされていない場合（maplibre-gl/node_modules/<name> など）も探す
  if (!fs.existsSync(`${candidates[0]}/package.json`)) {
    for (const parent of fs.readdirSync(`${root}/node_modules`)) {
      const scoped = parent.startsWith('@') ? fs.readdirSync(`${root}/node_modules/${parent}`).map((p) => `${parent}/${p}`) : [parent];
      for (const p of scoped) {
        const dir = `${root}/node_modules/${p}/node_modules/${name}`;
        if (fs.existsSync(`${dir}/package.json`)) candidates.push(dir);
      }
    }
  }
  const dir = candidates.find((d) => fs.existsSync(`${d}/package.json`));
  if (!dir) throw new Error(`${name} が node_modules にありません`);
  const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8')) as {
    version: string;
    license?: string | { type?: string };
    repository?: string | { url?: string };
    homepage?: string;
  };
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '（package.json に記載なし）';
  return { name, version: pkg.version, license, repository: repositoryUrl(pkg), text: readLicenseText(fs, dir, name) };
}

/** 配布物に含まれるパッケージと、その含まれ方（maplibre-gl の配布ファイルに同梱、など） */
export type BundledPackages = Map<string, Set<string>>;

const RULE = '='.repeat(80);
const THIN = '-'.repeat(80);

function inclusionNote(name: string, via: ReadonlySet<string>): string {
  if (name === 'vite') return 'ビルド時に挿入される実行時の補助コード（modulepreload の polyfill・動的 import の補助） / Vite runtime helpers';
  if (name === 'rolldown') return 'ビルド時に挿入される実行時の補助コード / Rolldown runtime helpers';
  const parents = [...via].filter((v) => v !== name).sort();
  const inside = parents.length
    ? `${parents.join('・')} の配布ファイルに組み込み済み（版は node_modules にあるもの） / bundled inside ${parents.join(', ')}`
    : '';
  if (!via.has(name)) return inside;
  return parents.length ? `ビルドした JavaScript に直接含む。${inside}` : 'ビルドした JavaScript に直接含む / bundled directly';
}

/** 見出しに書くライセンスの表記（SPDX の式がすでに括弧で囲まれていればそのまま） */
function licenseLabel(license: string): string {
  return /^\(.*\)$/.test(license) ? license : `(${license})`;
}

/** THIRD_PARTY_LICENSES.txt の本文を作る（パッケージ名の順） */
export function renderThirdPartyNotices(infos: readonly PackageInfo[], bundled: BundledPackages): string {
  const sorted = [...infos].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const lines: string[] = [
    '鵠沼海岸 津波シミュレーター — 第三者ソフトウェアのライセンス表示',
    'Third-party software notices',
    '',
    'このサイトの配布物（ビルドした JavaScript・CSS）には、次のオープンソースソフトウェアが含まれています。',
    '各ソフトウェアの著作権表示とライセンス条文を、それぞれのパッケージに含まれるとおりに掲載します。',
    'This site includes the following open-source software. Their copyright notices and license texts are',
    'reproduced below as distributed with each package.',
    '',
    'このファイルは `npm run licenses` で、実際にビルドに含まれるパッケージから作成しています（vite.config.ts）。手で編集しないでください。',
    '地図・標高などのデータの出典と利用条件は、サイトの「情報」タブと docs/DATA_SOURCES.md を参照してください。',
    '',
    '目次 / Contents',
    ...sorted.map((p) => `  - ${p.name} ${p.version} ${licenseLabel(p.license)}`),
    '',
  ];
  for (const p of sorted) {
    lines.push(
      RULE,
      `== ${p.name} ${p.version} ${licenseLabel(p.license)} ==`,
      `Source: ${p.repository || '（記載なし）'}`,
      `Included: ${inclusionNote(p.name, bundled.get(p.name) ?? new Set())}`,
      THIN,
      p.text,
      '',
    );
  }
  lines.push(RULE, '');
  // 先頭に BOM を付ける: charset の無い text/plain で配信されても（開発サーバーなど）、ブラウザが UTF-8 として読むように
  return `\uFEFF${lines.join('\n')}`;
}

/** THIRD_PARTY_LICENSES.txt の見出し（== name version (license) ==）を読む */
export function parseThirdPartyNotices(text: string): { name: string; version: string; license: string }[] {
  const out: { name: string; version: string; license: string }[] = [];
  for (const m of text.matchAll(/^== (\S+) (\S+) (\(.*\)) ==$/gm)) out.push({ name: m[1], version: m[2], license: m[3].replace(/^\((.*)\)$/, '$1') });
  return out;
}

/** 配布物に含まれるパッケージ（メインのビルドとワーカーのビルドで共有する） */
const bundledPackages: BundledPackages = new Map();

function addBundled(name: string, via: string): void {
  let s = bundledPackages.get(name);
  if (!s) bundledPackages.set(name, (s = new Set()));
  s.add(via);
}

/**
 * 配布物に含まれるパッケージを集め、メインのビルドの最後に THIRD_PARTY_LICENSES.txt と照合する（mode が licenses なら作り直す）。
 * role: 'worker' は Web Worker のビルド用（集めるだけ）。
 */
function thirdPartyNotices(role: 'main' | 'worker'): Plugin {
  let config: ResolvedConfig;
  return {
    name: `kugenuma:third-party-notices-${role}`,
    apply: 'build',
    config(_c, env) {
      // npm run licenses: ファイルを作り直すだけで、ビルドの出力は書き出さない
      if (role === 'main' && env.mode === 'licenses') return { build: { write: false } };
      return undefined;
    },
    configResolved(c) {
      config = c;
    },
    async generateBundle(_opts, bundle) {
      const fs = await nodeFs();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const name = packageNameOfModule(id);
          if (!name) continue;
          addBundled(name, name);
          // ビルド済みの配布ファイル（maplibre-gl/dist/*.mjs など）が内部に含むパッケージ
          const file = id.split('?')[0];
          if (!id.startsWith('\0') && fs.existsSync(`${file}.map`)) {
            try {
              const map = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8')) as { sources?: string[] };
              for (const inner of packagesInSourceMap(map.sources ?? [])) if (inner !== name) addBundled(inner, name);
            } catch {
              this.warn(`${file}.map を読めませんでした（ライセンス表示の確認）`);
            }
          }
        }
      }
      if (role !== 'main') return;

      const noticePath = `${config.publicDir}/${THIRD_PARTY_NOTICES_FILE}`;
      const names = [...bundledPackages.keys()].sort();
      if (config.mode === 'licenses') {
        const infos = await Promise.all(names.map((n) => readPackageInfo(config.root, n)));
        fs.writeFileSync(noticePath, renderThirdPartyNotices(infos, bundledPackages));
        config.logger.info(`${noticePath} を作り直しました（${names.length} パッケージ）`);
        return;
      }
      const listed = fs.existsSync(noticePath) ? parseThirdPartyNotices(fs.readFileSync(noticePath, 'utf8')) : [];
      const missing = names.filter((n) => !listed.some((l) => l.name === n));
      if (missing.length) {
        this.error(
          `配布物に含まれる次のパッケージのライセンス表示が public/${THIRD_PARTY_NOTICES_FILE} にありません: ${missing.join(', ')}。` +
            '`npm run licenses` で作り直してください。',
        );
      }
      for (const l of listed) {
        if (!bundledPackages.has(l.name)) {
          this.warn(`public/${THIRD_PARTY_NOTICES_FILE} の ${l.name} は配布物に含まれていません。\`npm run licenses\` で作り直してください。`);
          continue;
        }
        const info = await readPackageInfo(config.root, l.name);
        if (info.version !== l.version) {
          this.warn(`public/${THIRD_PARTY_NOTICES_FILE} の ${l.name} は ${l.version} ですが、使われているのは ${info.version} です。\`npm run licenses\` で作り直してください。`);
        }
      }
    },
  };
}

/** 最小化しても残すコメント: @license・@preserve・/*! で始まるもの（ライセンス表示）だけ */
const KEEP_LEGAL_COMMENTS = { comments: { legal: true, annotation: false, jsdoc: false } } as const;

// base: './' so the built site works from any sub-path (GitHub Pages etc.)
export default defineConfig({
  base: './',
  plugins: [thirdPartyNotices('main')],
  worker: {
    format: 'es',
    plugins: () => [thirdPartyNotices('worker')],
    rolldownOptions: { output: KEEP_LEGAL_COMMENTS },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { output: KEEP_LEGAL_COMMENTS },
  },
  server: { host: true },
});
