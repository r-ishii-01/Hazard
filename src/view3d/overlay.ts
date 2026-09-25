/**
 * 3D ビュー内の小さな DOM 要素（視点リセット・方位・出典・倍率の注記・ツールチップ・状態表示）。
 * スタイルは .v3d- 接頭辞のクラスに閉じ込める。
 *
 * 狭い画面（幅 560px 未満）: 左上は経過時間・水位の表示（UI 担当の HUD）が幅いっぱい近くまで使い、
 * 右端の列（幅 約 70px）だけが地図の操作部品の場所なので、右上には方位磁針のボタン 1 つだけを置く
 * （押すと視点をリセット。小さな矢印の印でそれを示す）。「視点をリセット」の文字のボタンは広い画面だけ。
 * タッチ操作・狭い画面では、ボタンを指で押しやすい大きさ（40px）にする。
 */
const STYLE_ID = 'view3d-style';

const CSS = `
.v3d-root{position:absolute;inset:0;overflow:hidden;background:#cfdfea;touch-action:none;user-select:none;-webkit-user-select:none}
.v3d-root canvas{display:block;width:100%;height:100%;outline:none}
.v3d-root canvas:focus-visible{outline:3px solid #0284c7;outline-offset:-3px}
.v3d-tools{position:absolute;top:10px;right:10px;display:flex;gap:6px;align-items:center;z-index:2}
.v3d-btn{font:600 12px/1 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.18);border-radius:8px;padding:7px 10px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.18);display:inline-flex;align-items:center;gap:5px}
.v3d-btn:hover{background:#fff}
.v3d-btn:focus-visible{outline:2px solid #0284c7;outline-offset:1px}
.v3d-compass{width:32px;height:32px;padding:0;justify-content:center;border-radius:50%}
.v3d-compass svg{transition:none}
.v3d-compass-reset{display:none}
@media (pointer:coarse){.v3d-btn{min-height:40px}.v3d-compass{width:40px;height:40px}.v3d-attrib-btn{min-height:40px;min-width:48px}.v3d-card-close{width:40px;height:40px;top:0;right:0}.v3d-card h4{margin-right:36px}}
.v3d-root.v3d-narrow .v3d-tools{top:8px;right:8px}
.v3d-root.v3d-narrow .v3d-reset{display:none}
.v3d-root.v3d-narrow .v3d-compass{width:40px;height:40px;position:relative}
.v3d-root.v3d-narrow .v3d-compass-reset{display:grid;place-items:center;position:absolute;right:-4px;bottom:-4px;width:17px;height:17px;border-radius:50%;background:#0f172a;color:#fff;border:1.5px solid #fff;box-sizing:border-box}
.v3d-note{position:absolute;left:8px;bottom:6px;z-index:2;font:500 11px/1.35 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#1e293b;background:rgba(255,255,255,.82);border-radius:6px;padding:3px 7px;cursor:help;max-width:60%}
.v3d-attrib{position:absolute;right:0;bottom:0;z-index:2;font:400 10px/1.4 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#334155;background:rgba(255,255,255,.8);padding:2px 6px;border-top-left-radius:6px;max-width:min(72%,720px);text-align:right}
.v3d-attrib a{color:inherit;text-decoration:underline;text-decoration-color:rgba(51,65,85,.4)}
.v3d-attrib-btn{display:none;font:600 11px/1 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#1e293b;background:rgba(255,255,255,.88);border:1px solid rgba(15,23,42,.18);border-radius:999px;padding:5px 9px;cursor:pointer}
.v3d-attrib-btn:focus-visible{outline:2px solid #0284c7;outline-offset:1px}
.v3d-root.v3d-narrow .v3d-attrib-btn{display:block;position:absolute;right:4px;bottom:0;z-index:3;min-height:40px;min-width:48px;padding:5px 12px}
.v3d-root.v3d-narrow .v3d-attrib{bottom:46px;right:6px;border-radius:6px;max-width:calc(100% - 12px)}
.v3d-root.v3d-narrow .v3d-attrib[data-open="0"]{display:none}
.v3d-root.v3d-narrow .v3d-card-close{width:40px;height:40px;top:0;right:0}
.v3d-root.v3d-narrow .v3d-card h4{margin-right:36px}
.v3d-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;font:600 13px/1.5 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;background:rgba(255,255,255,.9);border-radius:10px;padding:10px 16px;box-shadow:0 2px 10px rgba(15,23,42,.2);pointer-events:none;text-align:center;max-width:80%}
.v3d-tip{position:absolute;z-index:3;pointer-events:none;font:500 12px/1.45 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#f8fafc;background:rgba(15,23,42,.9);border-radius:6px;padding:5px 8px;white-space:pre-line;max-width:280px;transform:translate(12px,12px)}
.v3d-tip-note{display:block;margin-top:4px;padding-top:4px;border-top:1px solid rgba(248,250,252,.25);font-size:10.5px;line-height:1.45;font-weight:400;color:#cbd5e1;white-space:normal}
.v3d-tip-note[hidden]{display:none}
.v3d-card{position:absolute;z-index:4;box-sizing:border-box;width:max-content;max-width:min(300px,calc(100% - 16px));font:500 12px/1.5 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;background:#fff;border-radius:10px;padding:9px 12px 10px;box-shadow:0 4px 16px rgba(15,23,42,.32);user-select:text;-webkit-user-select:text;touch-action:auto}
.v3d-card[hidden]{display:none}
.v3d-card-close{position:absolute;top:2px;right:2px;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;color:#334155;font:700 17px/1 system-ui,sans-serif;cursor:pointer}
.v3d-card-close:hover{background:#f1f5f9}
.v3d-card-close:focus-visible{outline:2px solid #0284c7;outline-offset:1px}
.v3d-card h4{margin:0 30px 2px 0;font-size:13.5px;line-height:1.35}
.v3d-card p{margin:2px 0 0}
.v3d-card-kind{display:inline-block;font-size:11px;padding:0 6px;border-radius:999px;color:#fff;margin-bottom:3px}
.v3d-card-src{color:#64748b;font-size:10.5px;margin-top:4px}
.v3d-card .v3d-shelter-note{margin-top:6px;padding-top:5px;border-top:1px solid #e2e8f0;color:#475569;font-size:10.5px;line-height:1.5;max-height:min(36vh,200px);overflow-y:auto;overscroll-behavior:contain}
.v3d-card .v3d-shelter-note p{margin:0 0 3px}
.v3d-card a{color:#0369a1;text-decoration:underline}
.v3d-card a:focus-visible{outline:2px solid #0284c7;outline-offset:1px}
.v3d-root[data-placing="1"] canvas{cursor:crosshair}
.v3d-toast{position:absolute;left:50%;top:56px;transform:translateX(-50%);z-index:3;font:600 12.5px/1.4 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#fff;background:rgba(15,23,42,.88);border-radius:8px;padding:7px 12px;pointer-events:none;transition:opacity .25s;opacity:0}
.v3d-toast[data-show="1"]{opacity:1}
`;

export interface OverlayHandlers {
  onReset(): void;
}

export class Overlay {
  readonly root: HTMLDivElement;
  private readonly tools: HTMLDivElement;
  private readonly compassArrow: SVGGElement;
  private readonly note: HTMLDivElement;
  private readonly attrib: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly tipText: HTMLSpanElement;
  private readonly tipNote: HTMLSpanElement;
  /** 地図の上の説明の札（避難場所をクリック・タップしたとき。リンクを押せる） */
  private readonly card: HTMLDivElement;
  private readonly cardBody: HTMLDivElement;
  private cardAnchor: { x: number; y: number } | null = null;
  private onCardClose: (() => void) | null = null;
  private readonly toastEl: HTMLDivElement;
  private toastTimer = 0;
  private readonly attribBtn: HTMLButtonElement;
  private attribOpen = false;
  private attribHtml = '';
  private noteText = '';

  constructor(container: HTMLElement, handlers: OverlayHandlers) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.root = document.createElement('div');
    this.root.className = 'v3d-root';
    container.appendChild(this.root);

    this.tools = document.createElement('div');
    this.tools.className = 'v3d-tools';
    const compass = document.createElement('button');
    compass.type = 'button';
    compass.className = 'v3d-btn v3d-compass';
    compass.title = '方位（赤が北）。押すと視点をリセット';
    compass.setAttribute('aria-label', '方位磁針（赤が北）。押すと視点をリセット');
    compass.innerHTML =
      '<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true"><g><polygon points="0,-9 3.2,0 -3.2,0" fill="#dc2626"/><polygon points="0,9 3.2,0 -3.2,0" fill="#94a3b8"/><circle r="1.4" fill="#0f172a"/></g></svg>' +
      // 狭い画面では「視点をリセット」のボタンを出さないので、方位磁針にリセットの印を付ける
      '<span class="v3d-compass-reset" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg></span>';
    this.compassArrow = compass.querySelector('g')!;
    compass.addEventListener('click', () => handlers.onReset());
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'v3d-btn v3d-reset';
    reset.title = '最初の視点（沖合の南南西から鵠沼海岸を見る）に戻します';
    reset.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg><span>視点をリセット</span>';
    reset.addEventListener('click', () => handlers.onReset());
    this.tools.append(compass, reset);

    this.note = document.createElement('div');
    this.note.className = 'v3d-note';
    this.attrib = document.createElement('div');
    this.attrib.className = 'v3d-attrib';
    this.msg = document.createElement('div');
    this.msg.className = 'v3d-msg';
    this.msg.hidden = true;
    this.tip = document.createElement('div');
    this.tip.className = 'v3d-tip';
    this.tip.hidden = true;
    this.tipText = document.createElement('span');
    this.tipNote = document.createElement('span');
    this.tipNote.className = 'v3d-tip-note';
    this.tipNote.hidden = true;
    this.tip.append(this.tipText, this.tipNote);
    this.card = document.createElement('div');
    this.card.className = 'v3d-card';
    this.card.setAttribute('role', 'dialog');
    this.card.hidden = true;
    this.cardBody = document.createElement('div');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'v3d-card-close';
    close.setAttribute('aria-label', '閉じる');
    close.title = '閉じる';
    close.textContent = '×';
    close.addEventListener('click', () => this.showCard(null));
    this.card.append(this.cardBody, close);
    // 札の上の操作（リンク・スクロール・閉じる）を 3D の操作（回転・クリックでの選択）に渡さない
    for (const type of ['pointerdown', 'pointerup', 'wheel', 'click', 'dblclick', 'contextmenu'] as const) {
      this.card.addEventListener(type, (ev) => ev.stopPropagation());
    }
    this.card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        this.showCard(null);
      }
    });
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'v3d-toast';
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    // 狭い画面では出典を「出典」ボタンで開閉する（長い出典が 3D 表示を覆わないように）
    this.attribBtn = document.createElement('button');
    this.attribBtn.type = 'button';
    this.attribBtn.className = 'v3d-attrib-btn';
    this.attribBtn.textContent = '出典';
    this.attribBtn.setAttribute('aria-expanded', 'false');
    this.attribBtn.addEventListener('click', () => {
      this.attribOpen = !this.attribOpen;
      this.applyAttribOpen();
      this.layout();
    });
    this.applyAttribOpen();
    this.root.append(this.tools, this.note, this.attrib, this.attribBtn, this.msg, this.tip, this.card, this.toastEl);
  }

  private applyAttribOpen(): void {
    this.attrib.dataset.open = this.attribOpen ? '1' : '0';
    this.attribBtn.setAttribute('aria-expanded', String(this.attribOpen));
    this.attribBtn.textContent = this.attribOpen ? '出典を閉じる' : '出典';
  }

  /** 短い通知（数秒で消える） */
  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.dataset.show = '1';
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.dataset.show = '0';
    }, 2600);
  }

  /** キャンバスを最背面に入れる */
  mountCanvas(canvas: HTMLCanvasElement): void {
    this.root.insertBefore(canvas, this.root.firstChild);
  }

  /** カメラの方位角（北=0、時計回り, ラジアン）で方位磁針を回す */
  setHeading(rad: number): void {
    this.compassArrow.setAttribute('transform', `rotate(${(-rad * 180) / Math.PI})`);
  }

  setNote(text: string, tooltip: string): void {
    if (text === this.noteText) return;
    this.noteText = text;
    this.note.textContent = text;
    this.note.title = tooltip;
    this.layout();
  }

  setAttribution(html: string): void {
    if (html === this.attribHtml) return;
    this.attribHtml = html;
    this.attrib.innerHTML = html;
    this.layout();
  }

  /** 狭い画面で注記と出典が重なる場合は、注記を出典の上に移す */
  layout(): void {
    const w = this.root.clientWidth;
    if (w === 0) return;
    if (this.cardAnchor && !this.card.hidden) this.placeCard(this.cardAnchor.x, this.cardAnchor.y);
    const narrow = w < 560;
    this.root.classList.toggle('v3d-narrow', narrow);
    if (narrow) {
      // 出典はボタンで開くので、注記は左下のまま（ボタンと重ならない幅に）
      this.note.style.bottom = '';
      this.note.style.maxWidth = 'calc(100% - 90px)';
      return;
    }
    this.note.style.maxWidth = '';
    const aw = this.attrib.offsetWidth;
    const nw = this.note.offsetWidth;
    const overlap = 8 + nw + 8 > w - aw;
    this.note.style.bottom = overlap ? `${this.attrib.offsetHeight + 6}px` : '';
  }

  setMessage(text: string | null): void {
    this.msg.hidden = !text;
    if (text) this.msg.textContent = text;
  }

  /** ツールチップ（text は改行で行を分ける。note は小さめの文字で下に添える注意）。null で消す */
  setTooltip(text: string | null, x = 0, y = 0, note?: string): void {
    if (!text) {
      this.tip.hidden = true;
      return;
    }
    this.tip.hidden = false;
    if (this.tipText.textContent !== text) this.tipText.textContent = text;
    const n = note ?? '';
    if (this.tipNote.textContent !== n) this.tipNote.textContent = n;
    this.tipNote.hidden = !n;
    const w = this.root.clientWidth;
    // 右端では左側に出す
    const flip = x > w - 290;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
    this.tip.style.transform = flip ? 'translate(calc(-100% - 12px), 12px)' : 'translate(12px, 12px)';
  }

  /**
   * 説明の札を出す（content は呼び出し側が textContent で作った要素。null で閉じる）。
   * (x, y) は指し示す印の上端の画面座標（札はその上に出し、上が足りなければ印の下に出す）。onClose は閉じたときに呼ぶ。
   */
  showCard(content: HTMLElement | null, x = 0, y = 0, label = '', onClose?: () => void): void {
    if (!content) {
      if (this.card.hidden) return;
      // 札の中（閉じるボタン・リンク）にフォーカスがあったら、3D の表示に戻す（フォーカスを見失わないように）
      const hadFocus = this.card.contains(document.activeElement);
      this.card.hidden = true;
      if (hadFocus) this.root.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true });
      this.cardBody.replaceChildren();
      this.cardAnchor = null;
      const cb = this.onCardClose;
      this.onCardClose = null;
      cb?.();
      return;
    }
    this.onCardClose = onClose ?? null;
    this.cardBody.replaceChildren(content);
    if (label) this.card.setAttribute('aria-label', label);
    else this.card.removeAttribute('aria-label');
    this.card.hidden = false;
    this.placeCard(x, y);
  }

  get cardOpen(): boolean {
    return !this.card.hidden;
  }

  /** 札の位置を指し示す地点に合わせる（視点が動いたとき。null なら地点が画面の外なので隠す） */
  placeCard(x: number | null, y = 0): void {
    if (this.card.hidden) return;
    if (x === null) {
      this.card.style.visibility = 'hidden';
      return;
    }
    this.card.style.visibility = '';
    this.cardAnchor = { x, y };
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const cw = this.card.offsetWidth;
    const ch = this.card.offsetHeight;
    const left = Math.max(8, Math.min(w - cw - 8, x - cw / 2));
    // 印（避難場所のアイコン 約 26px）の上に 8px あけて出す。上が足りなければ印の下に
    let top = y - ch - 8;
    if (top < 8) top = Math.min(h - ch - 8, y + 34);
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  setPlacing(on: boolean): void {
    this.root.dataset.placing = on ? '1' : '0';
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    this.root.remove();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
