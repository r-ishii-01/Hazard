/**
 * 3D ビュー内の小さな DOM 要素（視点リセット・方位・出典・倍率の注記・ツールチップ・状態表示）。
 * スタイルは .v3d- 接頭辞のクラスに閉じ込める。
 */
const STYLE_ID = 'view3d-style';

const CSS = `
.v3d-root{position:absolute;inset:0;overflow:hidden;background:#cfdfea;touch-action:none;user-select:none;-webkit-user-select:none}
.v3d-root canvas{display:block;width:100%;height:100%;outline:none}
.v3d-tools{position:absolute;top:10px;right:10px;display:flex;gap:6px;align-items:center;z-index:2}
.v3d-btn{font:600 12px/1 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.18);border-radius:8px;padding:7px 10px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.18);display:inline-flex;align-items:center;gap:5px}
.v3d-btn:hover{background:#fff}
.v3d-btn:focus-visible{outline:2px solid #0284c7;outline-offset:1px}
.v3d-compass{width:32px;height:32px;padding:0;justify-content:center;border-radius:50%}
.v3d-compass svg{transition:none}
.v3d-note{position:absolute;left:8px;bottom:6px;z-index:2;font:500 11px/1.35 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#1e293b;background:rgba(255,255,255,.82);border-radius:6px;padding:3px 7px;cursor:help;max-width:60%}
.v3d-attrib{position:absolute;right:0;bottom:0;z-index:2;font:400 10.5px/1.4 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#334155;background:rgba(255,255,255,.8);padding:2px 6px;border-top-left-radius:6px;max-width:72%;text-align:right}
.v3d-attrib a{color:inherit;text-decoration:underline;text-decoration-color:rgba(51,65,85,.4)}
.v3d-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;font:600 13px/1.5 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#0f172a;background:rgba(255,255,255,.9);border-radius:10px;padding:10px 16px;box-shadow:0 2px 10px rgba(15,23,42,.2);pointer-events:none;text-align:center;max-width:80%}
.v3d-tip{position:absolute;z-index:3;pointer-events:none;font:500 12px/1.45 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;color:#f8fafc;background:rgba(15,23,42,.9);border-radius:6px;padding:5px 8px;white-space:pre-line;max-width:280px;transform:translate(12px,12px)}
.v3d-root[data-placing="1"] canvas{cursor:crosshair}
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
    compass.title = '方位（赤が北）。クリックで視点をリセット';
    compass.setAttribute('aria-label', '方位磁針（クリックで視点をリセット）');
    compass.innerHTML =
      '<svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true"><g><polygon points="0,-9 3.2,0 -3.2,0" fill="#dc2626"/><polygon points="0,9 3.2,0 -3.2,0" fill="#94a3b8"/><circle r="1.4" fill="#0f172a"/></g></svg>';
    this.compassArrow = compass.querySelector('g')!;
    compass.addEventListener('click', () => handlers.onReset());
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'v3d-btn';
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
    this.root.append(this.tools, this.note, this.attrib, this.msg, this.tip);
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
  }

  setAttribution(html: string): void {
    if (html === this.attribHtml) return;
    this.attribHtml = html;
    this.attrib.innerHTML = html;
  }

  setMessage(text: string | null): void {
    this.msg.hidden = !text;
    if (text) this.msg.textContent = text;
  }

  setTooltip(text: string | null, x = 0, y = 0): void {
    if (!text) {
      this.tip.hidden = true;
      return;
    }
    this.tip.hidden = false;
    if (this.tip.textContent !== text) this.tip.textContent = text;
    const w = this.root.clientWidth;
    // 右端では左側に出す
    const flip = x > w - 290;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
    this.tip.style.transform = flip ? 'translate(calc(-100% - 12px), 12px)' : 'translate(12px, 12px)';
  }

  setPlacing(on: boolean): void {
    this.root.dataset.placing = on ? '1' : '0';
  }

  dispose(): void {
    this.root.remove();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
