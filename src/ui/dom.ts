/**
 * 小さな DOM ヘルパー（フレームワークなし）。
 *
 * - h(): 要素を宣言的に作る
 * - Scope: 購読・イベント・タイマーをまとめて解除する（アンマウント時のリーク防止）
 * - setText(): 値が変わった時だけ textContent を書き換える（毎フレーム更新向け）
 */

export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate', 'open']);

function applyProps(el: Element, props: Props): void {
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (v === undefined || v === null) continue;
    if (key === 'class') {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style' && typeof v === 'object') {
      const style = (el as HTMLElement).style;
      for (const [k, sv] of Object.entries(v as Record<string, string>)) {
        if (k.startsWith('--')) style.setProperty(k, sv);
        else (style as unknown as Record<string, string>)[k] = sv;
      }
    } else if (key === 'dataset' && typeof v === 'object') {
      Object.assign((el as HTMLElement).dataset, v);
    } else if (key === 'text') {
      el.textContent = String(v);
    } else if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2), v as EventListener);
    } else if (PROP_KEYS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = v;
    } else if (v === true) {
      el.setAttribute(key, '');
    } else if (v !== false) {
      el.setAttribute(key, String(v));
    }
  }
}

function appendChildren(el: Node, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** HTML 要素を作る */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG 要素を作る */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Props | null,
  ...children: (Child | Child[])[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) applyProps(el, attrs);
  appendChildren(el, children);
  return el;
}

/** textContent を値が変わった時だけ更新 */
export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** 属性を値が変わった時だけ更新（null で削除） */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/** hidden を切り替え（変化時のみ） */
export function setHidden(el: HTMLElement | SVGElement, hidden: boolean): void {
  if (el instanceof HTMLElement) {
    if (el.hidden !== hidden) el.hidden = hidden;
  } else {
    // SVG は CSS の display 指定が属性より優先されるため style で切り替える
    const v = hidden ? 'none' : '';
    if (el.style.display !== v) el.style.display = v;
  }
}

let uidSeq = 0;
/** ラベルの for 属性などに使う一意な ID */
export function uid(prefix = 'ui'): string {
  uidSeq += 1;
  return `${prefix}-${uidSeq}`;
}

/** 入力要素・ボタン等にフォーカスがあるか（グローバルなキー操作を抑止する判定） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return false;
}

/** 購読・リスナー・タイマーをまとめて解除するための入れ物 */
export class Scope {
  private cleanups: (() => void)[] = [];

  add(fn: () => void): void {
    this.cleanups.push(fn);
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (ev: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (ev: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (ev: Event) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (ev: never) => void, opts?: AddEventListenerOptions): void {
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, opts);
    this.add(() => target.removeEventListener(type, listener, opts));
  }

  interval(fn: () => void, ms: number): number {
    const id = window.setInterval(fn, ms);
    this.add(() => window.clearInterval(id));
    return id;
  }

  timeout(fn: () => void, ms: number): number {
    const id = window.setTimeout(fn, ms);
    this.add(() => window.clearTimeout(id));
    return id;
  }

  dispose(): void {
    const fns = this.cleanups.splice(0).reverse();
    for (const fn of fns) {
      try {
        fn();
      } catch (e) {
        console.error('[ui] cleanup failed', e);
      }
    }
  }
}

/**
 * 呼び出しを間引く（先頭で即実行し、間隔内の最後の呼び出しも必ず実行する）。
 * cancel() で保留中の実行を取り消す。
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let last = -Infinity;
  let timer = 0;
  let pending: A | null = null;
  const run = () => {
    timer = 0;
    last = performance.now();
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args: A) => {
    pending = args;
    const now = performance.now();
    if (now - last >= ms) {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      run();
    } else if (!timer) {
      timer = window.setTimeout(run, ms - (now - last));
    }
  };
  wrapped.cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  wrapped.flush = () => {
    if (pending) {
      if (timer) window.clearTimeout(timer);
      run();
    }
  };
  return wrapped;
}

/**
 * 信頼できる定数由来の出典 HTML（<a> と文字列のみ）を安全に DOM 化する。
 * <a> 以外のタグは中身の文字列だけ残し、href は http(s) のみ許可する。
 */
export function safeAttributionHTML(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (src: Node, dst: Node) => {
    for (const node of Array.from(src.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(node.textContent ?? ''));
      } else if (node instanceof HTMLAnchorElement) {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:\/\//.test(href)) {
          const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer' });
          walk(node, a);
          dst.appendChild(a);
        } else {
          walk(node, dst);
        }
      } else if (node instanceof Element) {
        walk(node, dst);
      }
    }
  };
  walk(tpl.content, frag);
  return frag;
}

/** 外部リンク（新しいタブ） */
export function extLink(href: string, text: string, cls?: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
}

/**
 * 文中の URL（http/https）をリンクにした DOM を返す（データ由来の注記の表示用）。
 * URL の直後の全角括弧・句読点はリンクに含めない。
 */
export function linkifyText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s（）「」、。，]+/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let url = m[0];
    // 末尾の半角の句読点・閉じ括弧はリンクから外す
    const trail = /[).,;:]+$/.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'url-link' }, url));
    last = m.index + url.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
