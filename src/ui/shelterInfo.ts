/**
 * 避難場所データの出所と利用上の注意の表示（「レイヤー」「人物」「情報」タブで共用）。
 * 例: 「避難場所: 国土地理院 指定緊急避難場所データ（津波） 7か所」
 *
 * 指定緊急避難場所データの「ご利用上の注意」は、データを第三者に提供するときに注意事項が正確に伝わるようにすることを
 * 求めている（data/shelters.ts の SHELTER_USAGE_NOTICE）。出所と一緒に、その要点と、藤沢市の津波避難ビルの多くが
 * 含まれないこと（市の一覧へのリンク）を常に示す。
 */
import {
  FUJISAWA_TSUNAMI_BUILDING_LABEL,
  FUJISAWA_TSUNAMI_BUILDING_URL,
  SHELTER_BUILDING_NOTE,
  SHELTER_BUILTIN_SOURCE_LABEL,
  SHELTER_SOURCE_LABEL,
  SHELTER_SOURCE_URL,
  SHELTER_USAGE_NOTICE,
} from '../data/shelters';
import type { UIContext } from './context';
import { extLink, h, setHidden, setText } from './dom';
import { icon } from './icons';

/** 利用上の注意と、津波避難ビルが含まれないことの説明（市の一覧へのリンクつき） */
export function shelterUsageNotice(): HTMLElement {
  return h(
    'span',
    { class: 'shelters-info-notice' },
    SHELTER_USAGE_NOTICE,
    SHELTER_BUILDING_NOTE,
    '（',
    extLink(FUJISAWA_TSUNAMI_BUILDING_URL, FUJISAWA_TSUNAMI_BUILDING_LABEL),
    '）',
  );
}

export function sheltersInfoLine(ctx: UIContext, prefix = '避難場所'): HTMLElement {
  const count = h('span', { class: 'shelters-info-count' });
  const text = h('span', { class: 'shelters-info-text' });
  const warn = h('span', { class: 'shelters-info-warn' });
  const link = extLink(SHELTER_SOURCE_URL, SHELTER_SOURCE_LABEL);
  const line = h('span', { class: 'shelters-info-line', role: 'status' }, `${prefix}: `, link, count, text, warn);
  const el = h('div', { class: 'shelters-info' }, icon('info', 14), h('span', { class: 'shelters-info-body' }, line, shelterUsageNotice()));
  ctx.scope.add(
    ctx.store.select(
      (s) => s.sheltersInfo,
      (info) => {
        el.dataset.origin = info?.origin ?? 'loading';
        if (!info) {
          setText(count, '');
          setText(text, '（読み込み中…）');
          setText(warn, '');
          setHidden(warn, true);
          return;
        }
        setText(link, info.origin === 'builtin' ? SHELTER_BUILTIN_SOURCE_LABEL : SHELTER_SOURCE_LABEL);
        setText(count, ` ${info.count}か所`);
        setText(text, info.origin === 'gsi' ? '（国土地理院のサーバーから取得）' : '');
        // 取得できずに内蔵の写しを使っている場合は、その旨（データ側の説明文）を出す
        setText(warn, info.origin === 'builtin' ? info.message : '');
        setHidden(warn, info.origin !== 'builtin');
      },
      true,
    ),
  );
  return el;
}
