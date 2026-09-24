/**
 * 「情報」タブ: 凡例、モデルのしくみと限界、出典、注意事項。
 */
import { DEM_CREDIT_HTML, GSI_ATTRIBUTION, HAZARD_PORTAL_NOTICE, HAZARD_TSUNAMI_TILES, OPENFREEMAP } from '../../data/sources';
import { SCENARIOS } from '../../data/scenarios';
import type { UIContext } from '../context';
import { extLink, h, safeAttributionHTML } from '../dom';
import { disclaimerBody } from '../disclaimer';
import { icon } from '../icons';
import { arrivalLegend, depthLegend } from '../legends';
import { sheltersInfoLine } from '../shelterInfo';
import { DISAPORTAL_URL, FUJISAWA_TSUNAMI_HAZARDMAP_URL, GSI_DEM_TILE_URL, JMA_SHINDO_TABLE_URL, JMA_TSUNAMI_WARNING_URL, KANAGAWA_TSUNAMI_SHINSUI_URL } from '../links';

export function createInfoPanel(ctx: UIContext): HTMLElement {
  // シナリオの出典（重複を除く）
  const seen = new Set<string>();
  const scenarioSources = SCENARIOS.filter((s) => s.source || s.sourceUrl)
    .filter((s) => {
      const key = `${s.source ?? ''}|${s.sourceUrl ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s) => h('li', null, s.sourceUrl ? extLink(s.sourceUrl, s.source || s.sourceUrl) : s.source ?? '', h('span', { class: 'muted' }, `（シナリオ「${s.shortName || s.name}」）`)));

  return h(
    'div',
    { class: 'panel-body panel-info' },
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('alert', 18), '実際の避難のために'),
      disclaimerBody(),
      h(
        'div',
        { class: 'link-cards' },
        extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市 津波ハザードマップ', 'link-card'),
        extLink(KANAGAWA_TSUNAMI_SHINSUI_URL, '神奈川県 津波浸水想定', 'link-card'),
      ),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => ctx.openDisclaimer() }, icon('help', 14), '「ご利用にあたって」をもう一度表示'),
    ),
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('layers', 18), '凡例'),
      depthLegend('浸水深（計算結果・公式の津波浸水想定で共通）'),
      h(
        'div',
        { class: 'legend-hazard-note' },
        h('p', null, h('strong', null, '公式の津波浸水想定（レイヤー「公式ハザードマップ」）: '), HAZARD_TSUNAMI_TILES.notes ?? ''),
        h('p', { class: 'hazard-notice' }, icon('alert', 14), h('span', null, HAZARD_PORTAL_NOTICE)),
        h('p', { class: 'source-note' }, '出典: ', safeAttributionHTML(HAZARD_TSUNAMI_TILES.attribution)),
      ),
      arrivalLegend(),
      h('p', { class: 'field-hint' }, '津波到達時間の色分けは、このサイトの計算結果用のものです（公式の区分ではありません）。'),
    ),
    h(
      'section',
      { class: 'section prose' },
      h('h2', { class: 'section-title' }, icon('wave', 18), 'シミュレーションのしくみ'),
      h('p', null, '海や陸の上を流れる水の動きを、浅い水の流れを表す「非線形長波方程式」で簡易的に計算しています。沖合の境界から周期的な波を入れ、海岸での最大水位が設定した津波高になるよう、入れる波の大きさを自動で調整しています。'),
      h('p', null, '陸の高さは国土地理院の標高データをもとにしています。建物がどれだけ水の流れを妨げるかは「粗度係数」でまとめて表しています。'),
      h('h3', { class: 'group-title' }, '主な限界'),
      h(
        'ul',
        null,
        h('li', null, '津波の発生（断層の動き）から計算するのではなく、沖合から決まった形の波を入れる簡易な方法です。公的な津波浸水想定を再現するものではありません。'),
        h('li', null, '海底地形（水深）は推定値で、実測の詳細な海底地形とは異なります。'),
        h('li', null, '建物・防潮堤・河川の堤防・水門などの構造物は簡略化しているか、考慮していません。建物の間を流れる速い流れや、漂流物の影響も表現できません。'),
        h('li', null, '境川・引地川などを遡上する津波は、計算の解像度（約8〜31 m）の範囲でしか表現できません。'),
        h('li', null, '人物の避難は、道路や混雑を考えない簡易な経路と一定の速さで計算しています。'),
        h('li', null, '揺れのアニメーションは震度の大きさを直感的に示すための演出で、実際の揺れ方を再現したものではありません。'),
      ),
    ),
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('info', 18), '出典・データ'),
      h(
        'ul',
        { class: 'source-list' },
        h('li', null, '背景地図・色別標高図: ', safeAttributionHTML(GSI_ATTRIBUTION), '（国土地理院）'),
        h('li', null, '標高: ', safeAttributionHTML(DEM_CREDIT_HTML), '（', extLink(GSI_DEM_TILE_URL, '標高タイルの仕様'), '）'),
        h('li', null, '津波浸水想定: ', safeAttributionHTML(HAZARD_TSUNAMI_TILES.attribution), '（', extLink(DISAPORTAL_URL, '重ねるハザードマップ'), '）'),
        h('li', { class: 'source-li-shelters' }, sheltersInfoLine(ctx, '避難場所')),
        h('li', null, '建物（3D）: ', safeAttributionHTML(OPENFREEMAP.attribution)),
        h('li', null, '震度の解説: ', extLink(JMA_SHINDO_TABLE_URL, '気象庁「気象庁震度階級関連解説表」')),
        h('li', null, '津波警報・注意報: ', extLink(JMA_TSUNAMI_WARNING_URL, '気象庁「津波警報・注意報、津波情報、津波予報について」')),
        h('li', null, extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市「津波ハザードマップ」')),
        scenarioSources,
      ),
    ),
  );
}
