/**
 * 第三者ソフトウェアのライセンス表示（public/THIRD_PARTY_LICENSES.txt）の検査。
 * - 配布物に含まれるライブラリ（package.json の dependencies、MapLibre GL JS の配布ファイルが内部に含むパッケージ、
 *   Vite・Rolldown の実行時の補助コード）がすべて載っていること。
 * - 各節の版・ライセンス・条文が、node_modules にあるパッケージのものと一致すること（依存を更新したら `npm run licenses` で作り直す）。
 * 実際にビルドに含まれるパッケージとの照合は、`npm run build` のたびに vite.config.ts のプラグインが行う。
 */
import { describe, expect, it } from 'vitest';
import {
  THIRD_PARTY_NOTICES_FILE,
  packageNameOfModule,
  packagesInSourceMap,
  parseThirdPartyNotices,
  readPackageInfo,
} from '../vite.config';

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
}
const fsName = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const NOTICE_PATH = `${ROOT}/public/${THIRD_PARTY_NOTICES_FILE}`;
const RULE = '='.repeat(80);
const THIN = '-'.repeat(80);

/** 節ごとの条文（見出しの行 → 区切り線の後の本文） */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.split(`\n${RULE}\n`)) {
    const head = /^== (\S+) \S+ \(.*\) ==$/m.exec(block);
    const i = block.indexOf(`${THIN}\n`);
    if (head && i >= 0) out.set(head[1], block.slice(i + THIN.length + 1).trim());
  }
  return out;
}

/** 配布物に必ず含まれるパッケージ */
function requiredPackages(): string[] {
  const pkg = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8')) as { dependencies: Record<string, string> };
  const names = new Set<string>(Object.keys(pkg.dependencies));
  // @mapbox/vector-tile が使う点の型（ビルドに含まれる）
  names.add('@mapbox/point-geometry');
  // MapLibre GL JS の配布ファイルが内部に含むパッケージ（source map の sources から）
  for (const f of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs']) {
    const map = JSON.parse(fs.readFileSync(`${ROOT}/node_modules/maplibre-gl/dist/${f}.map`, 'utf8')) as { sources: string[] };
    for (const n of packagesInSourceMap(map.sources)) names.add(n);
  }
  // ビルドが挿入する実行時の補助コード
  names.add('vite');
  names.add('rolldown');
  return [...names].sort();
}

describe('第三者ソフトウェアのライセンス表示（public/THIRD_PARTY_LICENSES.txt）', () => {
  const text = fs.existsSync(NOTICE_PATH) ? fs.readFileSync(NOTICE_PATH, 'utf8') : '';
  const listed = parseThirdPartyNotices(text);
  const bodies = sections(text);

  it('サイトと一緒に公開される場所（public/）にあり、日本語の説明と目次がある', () => {
    expect(text.length).toBeGreaterThan(1000);
    // BOM 付き UTF-8（charset の無い text/plain で配信されても文字化けしない）
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('第三者ソフトウェアのライセンス表示');
    expect(text).toContain('npm run licenses');
    for (const l of listed) expect(text).toContain(`  - ${l.name} ${l.version} `);
  });

  it('配布物に含まれるライブラリ（MapLibre GL JS が内部に含むものを含む）がすべて載っている', () => {
    const required = requiredPackages();
    // 最低限: 地図・3D・建物のベクトルタイルのライブラリ
    for (const n of ['maplibre-gl', 'three', 'pbf', '@mapbox/vector-tile', '@mapbox/point-geometry', 'earcut', 'gl-matrix']) expect(required).toContain(n);
    const names = listed.map((l) => l.name);
    expect(required.filter((n) => !names.includes(n))).toEqual([]);
    // 見出しは重複しない
    expect(new Set(names).size).toBe(names.length);
  });

  it('各節の版・ライセンス・条文は node_modules のパッケージと一致する（古ければ npm run licenses で作り直す）', async () => {
    expect(listed.length).toBeGreaterThan(10);
    for (const l of listed) {
      const info = await readPackageInfo(ROOT, l.name);
      expect(`${l.name} ${l.version}`).toBe(`${l.name} ${info.version}`);
      expect(l.license).toBe(info.license.replace(/^\((.*)\)$/, '$1'));
      expect(bodies.get(l.name), l.name).toBe(info.text);
      // 著作権表示を含む（MIT・BSD・ISC は著作権表示の保持を求めている）
      expect(info.text, l.name).toMatch(/copyright/i);
    }
  });

  it('MapLibre GL JS（BSD-3-Clause）・three.js（MIT）の条文そのものを含む', () => {
    expect(bodies.get('maplibre-gl')).toContain('Copyright (c) 2023, MapLibre contributors');
    expect(bodies.get('maplibre-gl')).toContain('Redistributions in binary form must reproduce the above copyright notice');
    expect(bodies.get('maplibre-gl')).toContain('Contains code from mapbox-gl-js v1.13 and earlier');
    expect(bodies.get('three')).toMatch(/Copyright © 2010-\d{4} three\.js authors/);
    expect(bodies.get('three')).toContain('The above copyright notice and this permission notice shall be included');
    // Vite は本体の MIT ライセンスだけ（Vite 自身が同梱する依存の条文は配布物に入らない）
    expect(bodies.get('vite')).toContain('Vite is released under the MIT license');
    expect(bodies.get('vite')).not.toContain('Licenses of bundled dependencies');
  });
});

describe('ライセンス表示のためのパッケージ名の判定', () => {
  it('モジュールの ID → パッケージ名', () => {
    expect(packageNameOfModule('/app/node_modules/@mapbox/vector-tile/index.js')).toBe('@mapbox/vector-tile');
    expect(packageNameOfModule('/app/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')).toBe('maplibre-gl');
    expect(packageNameOfModule('C:\\app\\node_modules\\three\\build\\three.module.js')).toBe('three');
    expect(packageNameOfModule('/app/node_modules/a/node_modules/quickselect/index.js')).toBe('quickselect');
    expect(packageNameOfModule('\0vite/preload-helper.js')).toBe('vite');
    expect(packageNameOfModule('\0rolldown/runtime.js')).toBe('rolldown');
    expect(packageNameOfModule('/app/src/main.ts')).toBeNull();
  });

  it('source map の sources から、内部に含むパッケージを読む', () => {
    expect(
      packagesInSourceMap([
        '../src/ui/map.ts',
        '../node_modules/earcut/src/earcut.js',
        '../node_modules/@maplibre/maplibre-gl-style-spec/dist/node_modules/tinyqueue/index.mjs',
        '../node_modules/@maplibre/maplibre-gl-style-spec/dist/expression/index.mjs',
        '../package.json',
      ]),
    ).toEqual(['@maplibre/maplibre-gl-style-spec', 'earcut', 'tinyqueue']);
  });
});
