/**
 * ラベル・アイコン（CanvasTexture のスプライト）。画面上で一定の大きさに見えるよう sizeAttenuation=false。
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace, Sprite, SpriteMaterial } from 'three';
import type { ShelterKind } from '../core/types';

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, "IPAGothic", sans-serif';
const DPR = 2;

export interface LabelSpec {
  title: string;
  line2: string;
  /** 左の帯の色（状態の色） */
  accent: string;
  selected: boolean;
  /** 1行の小さいラベル（選択していない人物） */
  compact: boolean;
}

/** 人物ラベル（CSS px で 240×54 のキャンバス。吹き出しは下端に寄せ、文字幅に合わせて描く） */
export class LabelSprite {
  readonly sprite: Sprite;
  readonly cssW = 240;
  readonly cssH = 54;
  /** 描いた吹き出しの大きさ（CSS px、しっぽを含む）。重なり判定に使う */
  boxW = 0;
  boxH = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  private readonly material: SpriteMaterial;
  private key = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cssW * DPR;
    this.canvas.height = this.cssH * DPR;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new SpriteMaterial({ map: this.texture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    this.sprite = new Sprite(this.material);
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 20;
  }

  set(spec: LabelSpec): void {
    const key = `${spec.title}|${spec.line2}|${spec.accent}|${spec.selected}|${spec.compact}`;
    if (key === this.key) return;
    this.key = key;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const tail = 6;
    const titleFont = `700 ${spec.compact ? 11.5 : 13}px ${FONT}`;
    const subFont = `500 ${spec.compact ? 10.5 : 11}px ${FONT}`;
    ctx.font = titleFont;
    const w1 = ctx.measureText(spec.title).width;
    ctx.font = subFont;
    const w2 = ctx.measureText(spec.line2).width;
    const w = Math.min(this.cssW - 4, spec.compact ? w1 + w2 + 26 : Math.max(w1, w2) + 22);
    const h = spec.compact ? 20 : 38;
    const x = (this.cssW - w) / 2;
    const y = this.cssH - tail - h - 1;
    this.boxW = w;
    this.boxH = h + tail;
    // 吹き出し
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, spec.compact ? 5 : 7);
    ctx.fillStyle = spec.selected ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.9)';
    ctx.shadowColor = 'rgba(15,23,42,0.35)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (spec.selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
    }
    // しっぽ
    ctx.beginPath();
    ctx.moveTo(this.cssW / 2 - 5, y + h);
    ctx.lineTo(this.cssW / 2, y + h + tail);
    ctx.lineTo(this.cssW / 2 + 5, y + h);
    ctx.closePath();
    ctx.fillStyle = spec.selected ? '#0f172a' : 'rgba(255,255,255,0.9)';
    ctx.fill();
    // 状態の色帯
    ctx.beginPath();
    roundRect(ctx, x + 4, y + 4, 5, h - 8, 2.5);
    ctx.fillStyle = spec.accent;
    ctx.fill();
    ctx.textBaseline = 'alphabetic';
    if (spec.compact) {
      ctx.fillStyle = '#0f172a';
      ctx.font = titleFont;
      ctx.fillText(spec.title, x + 13, y + 14.5);
      ctx.fillStyle = '#334155';
      ctx.font = subFont;
      ctx.fillText(spec.line2, x + 13 + w1 + 6, y + 14.5, Math.max(10, w - w1 - 22));
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.font = titleFont;
      ctx.fillText(spec.title, x + 14, y + 16, w - 18);
      ctx.fillStyle = '#334155';
      ctx.font = subFont;
      ctx.fillText(spec.line2, x + 14, y + 31, w - 18);
    }
    this.texture.needsUpdate = true;
  }

  /** 画面上の大きさ（CSS px）に合わせてスケールを設定。p11 = 投影行列の [1][1] */
  fit(viewportH: number, p11: number): void {
    const k = 2 / (viewportH * p11);
    this.sprite.scale.set(this.cssW * k, this.cssH * k, 1);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const SHELTER_COLORS: Record<ShelterKind, string> = {
  'tsunami-building': '#0f766e',
  'evac-site': '#15803d',
  highground: '#4d7c0f',
};

export const SHELTER_LABELS: Record<ShelterKind, string> = {
  'tsunami-building': '津波避難ビル',
  'evac-site': '指定緊急避難場所',
  highground: '高台',
};

/** 避難場所アイコン（CSS px 28×28 の角丸四角に白い図柄） */
export function createShelterIcon(kind: ShelterKind): CanvasTexture {
  const S = 28;
  const c = document.createElement('canvas');
  c.width = S * DPR;
  c.height = S * DPR;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.beginPath();
  roundRect(ctx, 1.5, 1.5, S - 3, S - 3, 6);
  ctx.fillStyle = SHELTER_COLORS[kind];
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'tsunami-building') {
    // ビル＋波
    ctx.fillRect(9, 6, 10, 13);
    ctx.fillStyle = SHELTER_COLORS[kind];
    for (let r = 0; r < 3; r++) for (let q = 0; q < 2; q++) ctx.fillRect(11 + q * 4, 8 + r * 4, 2, 2);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(5, 22);
    ctx.quadraticCurveTo(8, 19, 11, 22);
    ctx.quadraticCurveTo(14, 25, 17, 22);
    ctx.quadraticCurveTo(20, 19, 23, 22);
    ctx.stroke();
  } else if (kind === 'highground') {
    // 山＋上向き矢印
    ctx.beginPath();
    ctx.moveTo(4, 23);
    ctx.lineTo(12, 12);
    ctx.lineTo(16, 17);
    ctx.lineTo(19, 14);
    ctx.lineTo(24, 23);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, 10);
    ctx.lineTo(12, 4.5);
    ctx.moveTo(9.5, 7);
    ctx.lineTo(12, 4.5);
    ctx.lineTo(14.5, 7);
    ctx.stroke();
  } else {
    // 走る人（避難場所）
    ctx.beginPath();
    ctx.arc(15.5, 6.5, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(14.5, 10);
    ctx.lineTo(12.5, 16);
    ctx.lineTo(16, 19);
    ctx.lineTo(15, 24);
    ctx.moveTo(12.5, 16);
    ctx.lineTo(9, 19.5);
    ctx.lineTo(6.5, 19);
    ctx.moveTo(14, 11.5);
    ctx.lineTo(18.5, 14);
    ctx.lineTo(21, 12.5);
    ctx.moveTo(13.8, 11);
    ctx.lineTo(10.5, 12.5);
    ctx.lineTo(9, 15);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/** sizeAttenuation=false のスプライトを css px の大きさにするスケール */
export function spriteScaleForPx(px: number, viewportH: number, p11: number): number {
  return (2 * px) / (viewportH * p11);
}
