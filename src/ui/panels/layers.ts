/**
 * 「レイヤー」タブ: 背景地図、重ねる情報の切り替え、3D の鉛直強調。
 */
import type { Basemap, LayerState } from '../../core/types';
import { BASEMAPS, HAZARD_PORTAL_NOTICE, HAZARD_TSUNAMI_TILES } from '../../data/sources';
import type { UIContext } from '../context';
import { h, safeAttributionHTML, setHidden } from '../dom';
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
  // 公式の津波浸水想定の説明（表示の有無にかかわらず常に出す）
  const hazardAbout = h(
    'div',
    { class: 'hazard-about' },
    h('p', { class: 'hazard-notice' }, icon('alert', 14), h('span', null, HAZARD_PORTAL_NOTICE)),
    HAZARD_TSUNAMI_TILES.notes ? h('p', { class: 'field-hint' }, HAZARD_TSUNAMI_TILES.notes) : null,
    h('p', { class: 'source-note' }, '出典: ', safeAttributionHTML(HAZARD_TSUNAMI_TILES.attribution)),
  );
  // 表示中のみ: 不透明度と凡例
  const hazardExtra = h(
    'div',
    { class: 'switch-extra' },
    opacity,
    depthLegend('浸水深（公式の津波浸水想定。このサイトの計算結果と同じ色分け）'),
  );
  ctx.scope.add(store.select((s) => s.layers.officialHazard, (on) => setHidden(hazardExtra, !on), true));

  const floodLegend = h('div', { class: 'switch-extra' }, depthLegend());
  const arrLegend = h('div', { class: 'switch-extra' }, arrivalLegend());
  ctx.scope.add(store.select((s) => s.layers.simFlood || s.layers.maxDepth, (on) => setHidden(floodLegend, !on), true));
  ctx.scope.add(store.select((s) => s.layers.arrival, (on) => setHidden(arrLegend, !on), true));

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
