import { describe, expect, it } from 'vitest';
import { SHINDO_LEVELS } from '../src/core/types';
import type { WarningLevel } from '../src/core/types';
import {
  DEFAULT_LAND_MANNING,
  DURATION_OPTIONS_MIN,
  KANAGAWA_2015_FUJISAWA,
  OFFICIAL_TIDE_TP,
  SCENARIO_NOTES,
  SCENARIOS,
  SHINDO_PRESETS,
  defaultDurationMin,
  defaultParams,
  getScenario,
} from '../src/data/scenarios';
import { INTENSITY_INFO } from '../src/data/intensity';
import {
  JMA_ISSUE_TARGET_NOTE,
  JMA_ISSUE_TARGET_SEC,
  WARNING_INFO,
  announcedHeight,
  jmaHeightFromTP,
  warningForHeight,
} from '../src/data/warnings';

const HEX = /^#[0-9a-f]{6}$/i;
const WARNING_LEVELS: WarningLevel[] = ['none', 'forecast', 'advisory', 'warning', 'major'];

describe('SCENARIOS', () => {
  it('has unique ids', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('placeholder');
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s has valid fields', (_id, s) => {
    expect(s.name.length).toBeGreaterThan(0);
    expect(s.shortName.length).toBeGreaterThan(0);
    expect(s.description.length).toBeGreaterThan(40);
    expect(SHINDO_LEVELS).toContain(s.shindo);
    expect(WARNING_LEVELS).toContain(s.warning);
    expect(s.magnitude === null || (Number.isFinite(s.magnitude) && s.magnitude > 5 && s.magnitude < 10)).toBe(true);
    // 海岸での最大水位は潮位より高く、UI のスライダー範囲（0〜20 m）内
    expect(s.coastHeight).toBeGreaterThan(OFFICIAL_TIDE_TP);
    expect(s.coastHeight).toBeLessThanOrEqual(20);
    // UI のスライダー範囲（到達 1〜120 分、周期 2〜60 分、波 1〜8）
    expect(s.arrivalMin).toBeGreaterThanOrEqual(1);
    expect(s.arrivalMin).toBeLessThanOrEqual(120);
    expect(s.periodMin).toBeGreaterThanOrEqual(2);
    expect(s.periodMin).toBeLessThanOrEqual(60);
    expect(Number.isInteger(s.waves)).toBe(true);
    expect(s.waves).toBeGreaterThanOrEqual(1);
    expect(s.waves).toBeLessThanOrEqual(8);
    expect(['rise', 'fall']).toContain(s.firstMotion);
    expect(s.shakingSec).toBeGreaterThanOrEqual(0);
    expect(s.shakingSec).toBeLessThanOrEqual(300);
    // 出典 URL は https
    if (s.sourceUrl) expect(s.sourceUrl).toMatch(/^https:\/\//);
    for (const r of s.refs ?? []) expect(r.url).toMatch(/^https:\/\//);
  });

  it('official scenarios cite a source and say which values are assumptions', () => {
    const official = SCENARIOS.filter((s) => s.isOfficial);
    expect(official.length).toBeGreaterThanOrEqual(6);
    for (const s of official) {
      expect(s.source, s.id).toBeTruthy();
      expect(s.sourceUrl, s.id).toMatch(/^https:\/\/www\.(pref\.kanagawa\.jp|bousai\.go\.jp)\//);
      expect(s.magnitude, s.id).not.toBeNull();
      expect(s.arrivalBasis, s.id).toBeTruthy();
      expect(s.description, s.id).toContain('仮定');
    }
  });

  it('illustrative scenarios are labelled as such', () => {
    const examples = SCENARIOS.filter((s) => !s.isOfficial);
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const s of examples) {
      expect(s.description, s.id).toMatch(/説明用|公的な想定ではありません|予測ではありません/);
      expect(s.sourceUrl, s.id).toBeTruthy();
    }
  });

  it('covers the key official models with published Fujisawa values', () => {
    const west = getScenario('sagami-west')!;
    expect(west.coastHeight).toBe(8.8);
    expect(west.arrivalMin).toBe(8);
    expect(west.magnitude).toBe(8.7);
    expect(west.shindo).toBe('7');
    expect(getScenario('sagami-central')!.coastHeight).toBe(9.5);
    expect(getScenario('taisho')!.coastHeight).toBe(6.5);
    expect(getScenario('nankai')!.coastHeight).toBe(7);
    // シナリオの値は参照表（県の予測図の藤沢海岸）と一致すること
    const table = new Map(KANAGAWA_2015_FUJISAWA.map((m) => [m.model, m]));
    const pairs: [string, string][] = [
      ['sagami-west', '相模トラフ沿いの海溝型地震（西側モデル）'],
      ['sagami-central', '相模トラフ沿いの海溝型地震（中央モデル）'],
      ['genroku', '元禄関東地震タイプ'],
      ['taisho', '大正関東地震タイプ'],
      ['keicho', '慶長型地震'],
      ['meio', '明応型地震'],
    ];
    for (const [id, model] of pairs) {
      const s = getScenario(id)!;
      const m = table.get(model)!;
      expect(s, id).toBeDefined();
      expect(m, model).toBeDefined();
      expect(s.coastHeight, id).toBe(m.fujisawaCoast.heightTP);
      expect(s.arrivalMin, id).toBe(m.fujisawaCoast.maxArrivalMin);
    }
  });

  it('illustrative JMA-level examples match the JMA category of their height', () => {
    for (const s of SCENARIOS.filter((x) => !x.isOfficial && x.id !== 'example-farfield')) {
      expect(s.jmaHeightM, s.id).toBeDefined();
      expect(warningForHeight(s.jmaHeightM!), s.id).toBe(s.warning);
      expect(s.coastHeight, s.id).toBeCloseTo(OFFICIAL_TIDE_TP + s.jmaHeightM!, 6);
    }
  });

  it('far-field example: no felt shaking but a tsunami warning', () => {
    const s = getScenario('example-farfield')!;
    expect(s.shindo).toBe('0');
    expect(s.shakingSec).toBe(0);
    expect(s.warning).toBe('warning');
  });

  it('getScenario returns undefined for unknown ids', () => {
    expect(getScenario('nope')).toBeUndefined();
  });
});

describe('KANAGAWA_2015_FUJISAWA', () => {
  it('lists the nine Kanagawa 2015 models with plausible values', () => {
    expect(KANAGAWA_2015_FUJISAWA).toHaveLength(9);
    for (const m of KANAGAWA_2015_FUJISAWA) {
      for (const v of [m.fujisawaCoast, m.katase, m.shonanPort]) {
        expect(v.heightTP).toBeGreaterThan(OFFICIAL_TIDE_TP);
        expect(v.heightTP).toBeLessThan(20);
        expect(v.maxArrivalMin).toBeGreaterThan(0);
      }
      expect(m.pageUrl).toMatch(/^https:\/\/www\.pref\.kanagawa\.jp\//);
      expect(m.sheetUrl).toMatch(/^https:\/\/www\.pref\.kanagawa\.jp\/uploaded\/attachment\/\d+\.pdf$/);
    }
  });
});

describe('SHINDO_PRESETS', () => {
  it('covers every shindo level and references existing scenarios', () => {
    for (const lv of SHINDO_LEVELS) {
      const p = SHINDO_PRESETS[lv];
      expect(p, lv).toBeDefined();
      expect(getScenario(p.scenarioId), `${lv} → ${p.scenarioId}`).toBeDefined();
      expect(p.note.length, lv).toBeGreaterThan(20);
    }
  });

  it('uses official scenarios where official intensity estimates exist', () => {
    expect(SHINDO_PRESETS['7'].scenarioId).toBe('sagami-west');
    expect(SHINDO_PRESETS['6+'].scenarioId).toBe('taisho');
    expect(SHINDO_PRESETS['6-'].scenarioId).toBe('nankai');
    for (const lv of ['6-', '6+', '7'] as const) {
      const s = getScenario(SHINDO_PRESETS[lv].scenarioId)!;
      expect(s.isOfficial).toBe(true);
      expect(s.shindo).toBe(lv);
    }
  });

  it('the initial scenario (震度7) exists', () => {
    expect(getScenario(SHINDO_PRESETS['7'].scenarioId)).toBeDefined();
  });
});

describe('defaultParams', () => {
  it('uses the official tide, a sane duration and the MLIT manning value', () => {
    for (const s of SCENARIOS) {
      const p = defaultParams(s);
      expect(p.scenario).not.toBe(s);
      expect(p.scenario).toEqual(s);
      expect(p.tideTP).toBe(0.85);
      expect(p.resolution).toBe('standard');
      expect(p.landManning).toBe(DEFAULT_LAND_MANNING);
      expect(p.landManning).toBe(0.06);
      expect(DURATION_OPTIONS_MIN).toContain(p.durationMin as (typeof DURATION_OPTIONS_MIN)[number]);
      expect(p.durationMin).toBeGreaterThanOrEqual(60);
      // 到達時刻は計算時間内
      expect(p.durationMin, s.id).toBeGreaterThan(s.arrivalMin);
    }
  });

  it('chooses the smallest option covering arrival + 3 periods', () => {
    expect(defaultDurationMin({ arrivalMin: 8, periodMin: 10 })).toBe(60);
    expect(defaultDurationMin({ arrivalMin: 34, periodMin: 20 })).toBe(120);
    expect(defaultDurationMin({ arrivalMin: 20, periodMin: 20 })).toBe(90);
    expect(defaultDurationMin({ arrivalMin: 200, periodMin: 60 })).toBe(120);
    expect(defaultDurationMin({ arrivalMin: NaN, periodMin: NaN })).toBe(60);
  });
});

describe('INTENSITY_INFO', () => {
  it('has JMA wording, colours and a monotone shake for every level', () => {
    let prev = -1;
    for (const lv of SHINDO_LEVELS) {
      const i = INTENSITY_INFO[lv];
      expect(i.shindo).toBe(lv);
      expect(i.label.startsWith('震度')).toBe(true);
      expect(i.person.length).toBeGreaterThan(5);
      expect(i.indoor.length).toBeGreaterThan(0);
      expect(i.outdoor.length).toBeGreaterThan(0);
      expect(i.color).toMatch(HEX);
      expect(i.shake).toBeGreaterThanOrEqual(0);
      expect(i.shake).toBeLessThanOrEqual(1);
      expect(i.shake).toBeGreaterThan(prev);
      prev = i.shake;
    }
    expect(INTENSITY_INFO['0'].shake).toBe(0);
    expect(INTENSITY_INFO['7'].shake).toBe(1);
    expect(INTENSITY_INFO['5-'].label).toBe('震度5弱');
    expect(INTENSITY_INFO['6-'].person).toBe('立っていることが困難になる。');
    // 気象庁の配色指針（表2－2）
    expect(INTENSITY_INFO['7'].color).toBe('#b40068');
    expect(INTENSITY_INFO['3'].color).toBe('#0041ff');
  });
});

describe('WARNING_INFO / warningForHeight', () => {
  it('has complete entries', () => {
    for (const lv of WARNING_LEVELS) {
      const w = WARNING_INFO[lv];
      expect(w.level).toBe(lv);
      expect(w.label.length).toBeGreaterThan(0);
      expect(w.heightRange.length).toBeGreaterThan(0);
      expect(w.color).toMatch(HEX);
      expect(w.textColor).toMatch(HEX);
    }
    for (const lv of ['advisory', 'warning', 'major'] as const) {
      expect(WARNING_INFO[lv].damage.length).toBeGreaterThan(0);
      expect(WARNING_INFO[lv].action.length).toBeGreaterThan(0);
    }
  });

  it('follows the JMA thresholds (0.2 ≤ 注意報 ≤ 1 < 警報 ≤ 3 < 大津波警報)', () => {
    expect(warningForHeight(0)).toBe('none');
    expect(warningForHeight(-1)).toBe('none');
    expect(warningForHeight(NaN)).toBe('none');
    expect(warningForHeight(0.05)).toBe('forecast');
    expect(warningForHeight(0.19)).toBe('forecast');
    expect(warningForHeight(0.2)).toBe('advisory');
    expect(warningForHeight(1)).toBe('advisory');
    expect(warningForHeight(1.0000000000000002)).toBe('advisory'); // 浮動小数の誤差
    expect(warningForHeight(1.01)).toBe('warning');
    expect(warningForHeight(3)).toBe('warning');
    expect(warningForHeight(3.01)).toBe('major');
    expect(warningForHeight(10)).toBe('major');
  });

  it('maps to the announced heights', () => {
    expect(announcedHeight(0.1)).toBeNull();
    expect(announcedHeight(0.2)).toBe('1m');
    expect(announcedHeight(1)).toBe('1m');
    expect(announcedHeight(2)).toBe('3m');
    expect(announcedHeight(3)).toBe('3m');
    expect(announcedHeight(4)).toBe('5m');
    expect(announcedHeight(5)).toBe('5m');
    expect(announcedHeight(7)).toBe('10m');
    expect(announcedHeight(10)).toBe('10m');
    expect(announcedHeight(12)).toBe('10m超');
  });

  it('converts T.P. heights to JMA-style heights', () => {
    expect(jmaHeightFromTP(1.85, 0.85)).toBe(1);
    expect(warningForHeight(jmaHeightFromTP(8.8, OFFICIAL_TIDE_TP))).toBe('major');
  });
});

// ---------------------------------------------------------------------------
// ファクトチェック（2026-09）で一次資料と照合した値の回帰テスト
// ---------------------------------------------------------------------------

describe('fact-check: Kanagawa 2015 sheet values (予測図 17/24 の区間表示)', () => {
  // [model, 藤沢海岸 m/分, 片瀬漁港海岸 m/分, 湘南港海岸 m/分]（各地震の 17/24 図 PDF のテキストと画像で確認）
  const EXPECTED: [string, [number, number], [number, number], [number, number]][] = [
    ['相模トラフ沿いの海溝型地震（西側モデル）', [8.8, 8], [7.9, 11], [11.5, 12]],
    ['相模トラフ沿いの海溝型地震（中央モデル）', [9.5, 23], [8.7, 20], [9.1, 22]],
    ['元禄関東地震タイプ', [8.0, 9], [8.1, 9], [8.0, 9]],
    ['元禄関東地震タイプと国府津-松田断層帯地震の連動地震', [7.9, 9], [8.0, 9], [7.9, 9]],
    ['慶長型地震', [8.6, 50], [8.6, 71], [8.1, 51]],
    ['大正関東地震タイプ', [6.5, 9], [6.0, 25], [6.4, 7]],
    ['明応型地震', [7.5, 50], [7.4, 50], [7.5, 52]],
    ['神奈川県西部地震', [4.2, 29], [5.0, 31], [3.6, 31]],
    ['西相模灘地震', [1.8, 29], [1.8, 29], [1.4, 80]],
  ];
  it.each(EXPECTED)('%s', (model, coast, katase, shonan) => {
    const m = KANAGAWA_2015_FUJISAWA.find((x) => x.model === model)!;
    expect(m).toBeDefined();
    expect([m.fujisawaCoast.heightTP, m.fujisawaCoast.maxArrivalMin]).toEqual(coast);
    expect([m.katase.heightTP, m.katase.maxArrivalMin]).toEqual(katase);
    expect([m.shonanPort.heightTP, m.shonanPort.maxArrivalMin]).toEqual(shonan);
  });

  it('city maxima match 解説 表2 (がけ地等を含む)', () => {
    const cityMax = Object.fromEntries(KANAGAWA_2015_FUJISAWA.filter((m) => m.cityMax).map((m) => [m.model, m.cityMax]));
    expect(cityMax['相模トラフ沿いの海溝型地震（西側モデル）']).toEqual({ heightTP: 11.6, maxArrivalMin: 12 });
    expect(cityMax['相模トラフ沿いの海溝型地震（中央モデル）']).toEqual({ heightTP: 10.8, maxArrivalMin: 21 });
    expect(cityMax['元禄関東地震タイプ']).toEqual({ heightTP: 9.9, maxArrivalMin: 6 });
    expect(cityMax['元禄関東地震タイプと国府津-松田断層帯地震の連動地震']).toEqual({ heightTP: 9.8, maxArrivalMin: 6 });
    expect(cityMax['慶長型地震']).toEqual({ heightTP: 8.6, maxArrivalMin: 71 });
    expect(Object.keys(cityMax)).toHaveLength(5);
  });
});

describe('fact-check: scenario wording', () => {
  it('西側: distinguishes the 11.5 m (coast zones) and 11.6 m (incl. cliffs) city maxima', () => {
    const d = getScenario('sagami-west')!.description;
    expect(d).toContain('11.5m・12分');
    expect(d).toContain('11.6m');
  });

  it('far-field example uses the JMA monthly-report name and does not claim an unverified 3 m forecast', () => {
    const s = getScenario('example-farfield')!;
    expect(s.name).toContain('カムチャツカ半島東方沖');
    expect(s.description).toContain('カムチャツカ半島東方沖');
    expect(s.description).not.toMatch(/予想される高さ\s*3\s*m/);
    expect(SHINDO_PRESETS['0'].note).toContain('カムチャツカ半島東方沖');
    // 観測値（気象庁 月報 表3-1）
    expect(s.description).toContain('油壺22cm');
    expect(s.description).toContain('小田原14cm');
    expect(s.jmaHeightM).toBe(0.2);
    // 気象庁 月報 p.71: 08:24 地震、08:37 注意報、09:40 警報へ切替
    expect(s.description).toContain('13分後に津波注意報、76分後に津波警報へ切替');
  });

  it('JMA issuance target is about 3 minutes (a target, not a guarantee)', () => {
    expect(JMA_ISSUE_TARGET_SEC).toBe(180);
    expect(JMA_ISSUE_TARGET_NOTE).toContain('約3分');
    expect(JMA_ISSUE_TARGET_NOTE).toContain('目標');
  });

  it('南海トラフ: explains that 7 m is the rounded-up city maximum, not a Kugenuma value, and the tide difference', () => {
    const s = getScenario('nankai')!;
    expect(s.coastHeight).toBe(7);
    expect(s.arrivalMin).toBe(34);
    expect(s.description).toContain('切り上げ');
    expect(s.description).toContain('平均は5m');
    expect(s.description).toContain('年間最高潮位');
    expect((s.assumptions ?? []).some((a) => a.includes('年間最高潮位'))).toBe(true);
    expect(s.description).toMatch(/\+1mの到達は32分、\+3mは34分、\+5mは60分/);
  });

  it('慶長型: no unsupported causal claim about a distant source', () => {
    const d = getScenario('keicho')!.description;
    expect(d).not.toContain('震源が遠いため');
    expect(d).toContain('再現ではなく');
    expect(d).toContain('仮置き');
  });

  it('明応型: described as not a reproduction of the 1498 earthquake', () => {
    const d = getScenario('meio')!.description;
    expect(d).toContain('明応地震（1498年）の再現ではなく');
    expect(d).toContain('仮置き');
  });

  it('10 m example compares T.P. values consistently', () => {
    const s = getScenario('example-major10')!;
    expect(s.coastHeight).toBe(10.85);
    expect(s.description).toContain('T.P.+10.85m');
    expect(s.description).toContain('T.P.+8.8〜9.5m');
  });

  it('period assumptions are labelled as having no official value', () => {
    for (const s of SCENARIOS.filter((x) => x.isOfficial)) {
      expect((s.assumptions ?? []).some((a) => a.startsWith('周期') && a.includes('公的資料に周期の値は無い')), s.id).toBe(true);
    }
  });

  it('shared notes mention both tide conditions and repeated waves', () => {
    const all = SCENARIO_NOTES.join('\n');
    expect(all).toContain('朔望平均満潮位 T.P.+0.85m');
    expect(all).toContain('年間最高潮位');
    expect(all).toContain('数時間以上くり返し');
    expect(all).toContain('公式の予測・浸水想定ではありません');
  });
});

describe('fact-check: JMA colours and wording', () => {
  it('intensity colours equal JMA colour guide 表2－2 for 震度1〜7', () => {
    const expected: Record<string, [number, number, number]> = {
      '7': [180, 0, 104],
      '6+': [165, 0, 33],
      '6-': [255, 40, 0],
      '5+': [255, 153, 0],
      '5-': [255, 230, 0],
      '4': [250, 230, 150],
      '3': [0, 65, 255],
      '2': [0, 170, 255],
      '1': [242, 242, 255],
    };
    for (const [lv, rgb] of Object.entries(expected)) {
      expect(hexToRgb(INTENSITY_INFO[lv as keyof typeof INTENSITY_INFO].color), lv).toEqual(rgb);
    }
  });

  it('warning colours equal JMA colour guide 表1 (forecast is this site’s choice)', () => {
    expect(hexToRgb(WARNING_INFO.major.color)).toEqual([200, 0, 255]);
    expect(hexToRgb(WARNING_INFO.warning.color)).toEqual([255, 40, 0]);
    expect(hexToRgb(WARNING_INFO.advisory.color)).toEqual([250, 245, 0]);
    expect(hexToRgb(WARNING_INFO.none.color)).toEqual([200, 200, 203]);
    expect(hexToRgb(WARNING_INFO.forecast.color)).toEqual([160, 210, 255]);
  });

  it('text colour is the higher-contrast choice of black/white', () => {
    for (const lv of WARNING_LEVELS) {
      const w = WARNING_INFO[lv];
      const L = relLum(w.color);
      const black = (L + 0.05) / 0.05;
      const white = 1.05 / (L + 0.05);
      expect(w.textColor.toLowerCase(), lv).toBe(black >= white ? '#000000' : '#ffffff');
    }
  });

  it('uses JMA wording verbatim', () => {
    expect(WARNING_INFO.major.damage).toBe('巨大な津波が襲い、木造家屋が全壊・流失し、人は津波による流れに巻き込まれます。');
    expect(WARNING_INFO.warning.heightRange).toBe('予想される津波の最大波の高さが高いところで1mを超え、3m以下の場合');
    expect(WARNING_INFO.forecast.action).toContain(
      '津波に伴う海面変動が観測されており、今後も継続する可能性が高いため、海に入っての作業や釣り、海水浴などに際しては十分な留意が必要である旨を発表します。',
    );
    expect(INTENSITY_INFO['6+'].person).toBe(INTENSITY_INFO['7'].person);
    expect(INTENSITY_INFO['5+'].outdoor).toBe(
      '窓ガラスが割れて落ちることがある。補強されていないブロック塀が崩れることがある。据付けが不十分な自動販売機が倒れることがある。自動車の運転が困難となり、停止する車もある。',
    );
    expect(INTENSITY_INFO['7'].indoor).toBe('固定していない家具のほとんどが移動したり倒れたりし、飛ぶこともある。');
  });
});

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function relLum(hex: string): number {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgb(hex).map((v) => f(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
