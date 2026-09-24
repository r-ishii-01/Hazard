/**
 * 「ご利用にあたって」（初回表示のモーダル）。確認済みかどうかを localStorage に保存する。
 */
import { extLink, h } from './dom';
import { icon } from './icons';
import { FUJISAWA_TSUNAMI_HAZARDMAP_URL, JMA_TSUNAMI_WARNING_URL } from './links';

export const DISCLAIMER_KEY = 'kugenuma-disclaimer-v1';

function readAck(): boolean {
  try {
    return window.localStorage.getItem(DISCLAIMER_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAck(): void {
  try {
    window.localStorage.setItem(DISCLAIMER_KEY, '1');
  } catch {
    /* プライベートモード等では保存できないが、表示には影響しない */
  }
}

/** 注意事項の本文（モーダルと「情報」タブで共用） */
export function disclaimerBody(): HTMLElement {
  return h(
    'div',
    { class: 'disclaimer-body' },
    h(
      'div',
      { class: 'evac-banner' },
      icon('alert', 22),
      h('p', null, h('strong', null, '強い揺れや長い揺れを感じたら、ただちに高い所へ避難してください。'), h('span', null, '津波警報等の発表や、このようなシミュレーションの結果を待つ必要はありません。')),
    ),
    h(
      'ul',
      { class: 'disclaimer-list' },
      h('li', null, 'このサイトは、津波の仕組みや避難の大切さを学ぶための', h('strong', null, '学習・啓発用の簡易シミュレーション'), 'です。国・県・市などの', h('strong', null, '公的な予測や想定ではありません'), '。'),
      h('li', null, '計算は地形・海底地形・建物などを簡略化しており、実際の津波の高さ・到達時間・浸水範囲とは異なります。「ここまでなら安全」という判断には使わないでください。'),
      h(
        'li',
        null,
        'このサイトの計算は、',
        h('strong', null, '公式の津波浸水想定（神奈川県）より浸水が狭く、浅めに出ます'),
        '（同じ地震の県の想定と比べても、浸水域が1〜2割狭い）。計算で浸水しなかった場所も、公式の想定では浸水することがあります。',
      ),
      h(
        'li',
        null,
        '実際の避難は、',
        extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップ'),
        'と、',
        extLink(JMA_TSUNAMI_WARNING_URL, '気象庁の津波警報・注意報'),
        '、藤沢市などの自治体が発表する避難情報に従ってください。',
      ),
    ),
  );
}

export interface Disclaimer {
  open(): void;
  /**
   * 利用者が内容を確認した（モーダルを閉じた、または以前に確認済み）ときに1回呼ぶ。
   * すでに確認済みなら次のタスクで呼ぶ。
   */
  whenAcknowledged(fn: () => void): void;
  dispose(): void;
}

export function createDisclaimer(): Disclaimer {
  const okBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, icon('check', 18), '内容を確認しました');
  const dialog = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'disclaimer-title' },
    h(
      'div',
      { class: 'modal-card' },
      h('header', { class: 'modal-head' }, h('span', { class: 'modal-icon' }, icon('info', 22)), h('h2', { id: 'disclaimer-title' }, 'ご利用にあたって')),
      disclaimerBody(),
      h(
        'footer',
        { class: 'modal-foot' },
        extLink(FUJISAWA_TSUNAMI_HAZARDMAP_URL, '藤沢市の津波ハザードマップを見る', 'btn btn-secondary'),
        okBtn,
      ),
    ),
  );
  let acknowledged = false;
  const waiting: (() => void)[] = [];
  const flushAck = () => {
    if (acknowledged) return;
    acknowledged = true;
    for (const fn of waiting.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error('[ui] disclaimer callback failed', e);
      }
    }
  };
  const close = () => {
    writeAck();
    if (dialog.open) dialog.close();
  };
  okBtn.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    writeAck();
    flushAck();
  });
  document.body.appendChild(dialog);

  const open = () => {
    if (dialog.open) return;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
    okBtn.focus();
  };
  if (!readAck()) open();
  else window.setTimeout(flushAck, 0);

  return {
    open,
    whenAcknowledged: (fn) => {
      if (acknowledged) window.setTimeout(fn, 0);
      else waiting.push(fn);
    },
    dispose: () => {
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
