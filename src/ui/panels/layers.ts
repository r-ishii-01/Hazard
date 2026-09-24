/**
 * 「レイヤー」タブ: 背景地図、重ねる情報の切り替え、3D の鉛直強調。
 */
import type { Basemap, LayerState } from '../../core/types';
import { formatSpan } from '../../core/format';
import { resultCoverage } from '../../core/results';
import { BASEMAPS, HAZARD_PORTAL_NOTICE, HAZARD_TSUNAMI_TILES } from '../../data/sources';
import type { UIContext } from '../context';
import { extLink, h, safeAttributionHTML, setHidden, setText } from '../dom';
import { FUJISAWA_TSUNAMI_HAZARDMAP_URL } from '../links';
import { radioField, sliderField, switchField } from '../fields';
import { icon } from '../icons';
import { arrivalLegend, depthLegend } from '../legends';
import { sheltersInfoLine } from '../shelterInfo';

export function createLayersPanel(ctx: UIContext): HTMLElement {
  const { actions, store } = ctx;
  const layer = <K extends keyof LayerState>(key: K, label: string, hint?: string, extra?: HTMLElement) =>
    switchField(ctx, {
      label,
      hint,
      extra,
      get: (s) => s.layers[key] as boolean,
      commit: (v) => actions.setLayer(key, v as LayerState[K]),
    });

  const basemapKeys = Object.keys(BASEMAPS) as Basemap[];

  // 公式ハザードマップの透明度（表示中のみ）
  const opacity = sliderField(ctx, {
    label: '不透明度',
    unit: '%',
    min: 0,
    max: 100,
    step: 5,
    digits: 0,
    live: true,
    get: (s) => Math.round(s.layers.officialHazardOpacity * 100),
    commit: (v) => actions.setLayer('officialHazardOpacity', v / 100),
  });
  // 公式の津波浸水想定を読み込めないとき（地図に色が無いだけに見えるので、はっきり示す）
  const retryButton = () =>
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => actions.retryOfficialHazard() }, icon('retry', 14), '再試行');
  // (1) 地図に重ねる公式ハザードマップの配信元に接続できない（表示中のみ。凡例のすぐ上に出し、色の凡例は出さない）
  const displayStatus = h(
    'div',
    { class: 'callout callout-warning compact hazard-status hazard-status-display', role: 'status', hidden: true },
    icon('alert', 16),
    h(
      'div',
      { class: 'hazard-status-text' },
      h(
        'p',
        null,
        h('strong', null, '公式ハザードマップ（津波浸水想定）を読み込めません。'),
        '配信元（ハザードマップポータルサイト）に接続できないため、地図に表示できていません。色が付いていない場所も浸水想定区域の可能性があります。',
        extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップ'),
        'で確認してください。',
      ),
      h('div', { class: 'callout-actions' }, retryButton()),
    ),
  );
  // (2) 人物の評価に使う公式の浸水想定を読み込めない・一部しか読めない（レイヤーの表示にかかわらず）
  const dataStatusText = h('p');
  const dataStatus = h(
    'div',
    { class: 'callout callout-warning compact hazard-status hazard-status-data', role: 'status', hidden: true },
    icon('alert', 16),
    h('div', { class: 'hazard-status-text' }, dataStatusText, h('div', { class: 'callout-actions' }, retryButton())),
  );
  const hazardLegend = depthLegend('浸水深（公式の津波浸水想定。このサイトの計算結果と同じ色分け）');
  const renderHazardStatus = () => {
    const s = store.get();
    const o = s.officialInundation;
    const displayFailed = s.layers.officialHazard && o.display === 'error';
    setHidden(displayStatus, !displayFailed);
    setHidden(hazardLegend, displayFailed);
    const text =
      o.status === 'error'
        ? '人物の評価に使う公式の津波浸水想定を読み込めませんでした。「最寄りの高台」は、公式の浸水想定区域の外かどうかを確かめずに選んでいます（避難先の名前に「未確認」と示します）。'
        : o.status === 'ready' && o.message
          ? o.message
          : '';
    setText(dataStatusText, text);
    setHidden(dataStatus, !text);
  };
  ctx.scope.add(store.select((s) => s.officialInundation, renderHazardStatus, true));
  ctx.scope.add(store.select((s) => s.layers.officialHazard, renderHazardStatus));

  // 公式の津波浸水想定の説明（表示の有無にかかわらず常に出す）
  const hazardAbout = h(
    'div',
    { class: 'hazard-about' },
    dataStatus,
    h('p', { class: 'hazard-notice' }, icon('alert', 14), h('span', null, HAZARD_PORTAL_NOTICE)),
    HAZARD_TSUNAMI_TILES.notes ? h('p', { class: 'field-hint' }, HAZARD_TSUNAMI_TILES.notes) : null,
    h('p', { class: 'field-hint' }, '避難には、このサイトの計算ではなく、公式のハザードマップ（', extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップ'), '）を使ってください。'),
    h('p', { class: 'source-note' }, '出典: ', safeAttributionHTML(HAZARD_TSUNAMI_TILES.attribution)),
  );
  // 表示中のみ: 不透明度と凡例
  const hazardExtra = h('div', { class: 'switch-extra' }, displayStatus, opacity, hazardLegend);
  ctx.scope.add(store.select((s) => s.layers.officialHazard, (on) => setHidden(hazardExtra, !on), true));

  const floodLegend = h('div', { class: 'switch-extra' }, depthLegend());
  const arrLegend = h('div', { class: 'switch-extra' }, arrivalLegend());
  ctx.scope.add(store.select((s) => s.layers.simFlood || s.layers.maxDepth, (on) => setHidden(floodLegend, !on), true));
  ctx.scope.add(store.select((s) => s.layers.arrival, (on) => setHidden(arrLegend, !on), true));

  // 途中までの結果（中止・失敗・計算中）: 最大浸水深・到達時間がどの範囲の結果かを示す
  const partialText = h('span');
  const partialNote = h('div', { class: 'callout callout-warning compact layers-partial', role: 'status', hidden: true }, icon('alert', 16), partialText);
  const renderPartial = () => {
    const cov = resultCoverage(store.get());
    let text = '';
    if (cov && !cov.complete) {
      const span = formatSpan(cov.until);
      text =
        cov.state === 'running'
          ? `計算中です。最大浸水深・津波到達時間は、いまは地震発生から${span}までの途中の結果です。`
          : `${cov.state === 'error' ? '計算が途中で止まった' : '計算を中止した'}ため、最大浸水深・津波到達時間は地震発生から${span}までの結果です。それより後の浸水は含まれていません（色の付いていない場所が浸水しないという意味ではありません）。`;
    }
    setText(partialText, text);
    setHidden(partialNote, !text);
  };
  ctx.scope.add(store.select((s) => s.sim, renderPartial, true));
  ctx.scope.add(store.select((s) => s.terrain.grid, renderPartial));
  ctx.scope.add(ctx.watcher.subscribe(renderPartial, false));

  return h(
    'div',
    { class: 'panel-body panel-layers' },
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('map', 18), '背景地図'),
      radioField<Basemap>(ctx, {
        label: '背景地図の種類',
        options: basemapKeys.map((b) => ({ value: b, label: BASEMAPS[b].label })),
        get: (s) => s.basemap,
        commit: (v) => actions.setBasemap(v),
      }),
    ),
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('layers', 18), 'シミュレーション結果'),
      h('div', { class: 'switch-list' }, layer('simFlood', '浸水（現在時刻）', 'タイムラインの時刻の浸水の深さ'), layer('maxDepth', '最大浸水深', '計算した時間内で最も深くなった浸水の深さ'), floodLegend, layer('arrival', '津波到達時間', '陸地に浸水が始まった時刻'), arrLegend),
      partialNote,
    ),
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('info', 18), '防災情報・地形'),
      h(
        'div',
        { class: 'switch-list' },
        layer('officialHazard', '公式ハザードマップ（津波浸水想定）', '神奈川県の津波浸水想定（ハザードマップポータルサイトの配信データ）', hazardExtra),
        hazardAbout,
        layer('shelters', '避難場所', '指定緊急避難場所（津波）など', sheltersInfoLine(ctx, 'データ')),
        layer('elevation', '色別標高', '土地の高さを色で表示'),
        layer('buildings', '建物（3D）', '3D表示で建物を立体的に表示'),
      ),
    ),
    h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, icon('cube', 18), '3D表示'),
      sliderField(ctx, {
        label: '鉛直強調（高さの倍率）',
        unit: '倍',
        min: 1,
        max: 5,
        step: 0.5,
        digits: 1,
        live: true,
        get: (s) => s.exaggeration,
        commit: (v) => actions.setExaggeration(v),
        hint: '高低差を分かりやすくするため、高さを強調して表示します（1倍が実際の比率）。',
      }),
    ),
  );
}
