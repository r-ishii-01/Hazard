/**
 * 避難場所データの出所の表示（「レイヤー」タブと「人物」タブで共用）。
 * 例: 「避難場所: 国土地理院 指定緊急避難場所データ（津波） 58か所」
 */
import { SHELTER_BUILTIN_SOURCE_LABEL, SHELTER_SOURCE_LABEL, SHELTER_SOURCE_URL } from '../data/shelters';
import type { UIContext } from './context';
import { extLink, h, setHidden, setText } from './dom';
import { icon } from './icons';

export function sheltersInfoLine(ctx: UIContext, prefix = '避難場所'): HTMLElement {
  const count = h('span', { class: 'shelters-info-count' });
  const text = h('span', { class: 'shelters-info-text' });
  const warn = h('span', { class: 'shelters-info-warn' });
  const link = extLink(SHELTER_SOURCE_URL, SHELTER_SOURCE_LABEL);
  const el = h('p', { class: 'shelters-info', role: 'status' }, icon('info', 14), h('span', null, `${prefix}: `, link, count, text, warn));
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
