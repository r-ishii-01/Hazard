/**
 * 揺れの演出: 再生中で 0 ≤ t < shakingSec の間、2D/3D ビューを CSS の transform で揺らす。
 *
 * - 振幅は INTENSITY_INFO[震度].shake（0〜1）× 最大 14 px。終わりに向けて減衰させる。
 * - 振動は実時間（performance.now）で作る。再生速度を上げても不自然に速くならない。
 * - prefers-reduced-motion のときは揺らさない（HUD の「強い揺れ」表示のみ）。
 * - 演出であり、実際の揺れ方の再現ではない。
 */
import { INTENSITY_INFO } from '../data/intensity';
import type { UIContext } from './context';
import { clamp } from './format';

export const MAX_SHAKE_PX = 14;

const smoothstep = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/** 揺れの包絡線（u = t / shakingSec）: 立ち上がり → 継続 → 終盤で減衰 */
export function shakeEnvelope(u: number): number {
  if (!(u >= 0) || u >= 1) return 0;
  return smoothstep(0, 0.08, u) * (1 - smoothstep(0.6, 1, u));
}

export function mountShake(ctx: UIContext, stage: HTMLElement): void {
  const { store } = ctx;
  const targets = Array.from(stage.querySelectorAll<HTMLElement>('.view'));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active = false;
  let scale = 1;

  const reset = () => {
    if (!active) return;
    active = false;
    stage.classList.remove('is-shaking');
    for (const el of targets) el.style.transform = '';
  };

  const apply = () => {
    const s = store.get();
    const dur = s.params.scenario.shakingSec;
    const t = s.time.t;
    const strength = clamp(INTENSITY_INFO[s.shindo]?.shake ?? 0, 0, 1);
    const on = s.time.playing && t >= 0 && t < dur && strength > 0 && !reduce.matches && !document.hidden;
    const amp = on ? MAX_SHAKE_PX * strength * shakeEnvelope(t / dur) : 0;
    if (amp < 0.05) {
      reset();
      return;
    }
    if (!active) {
      active = true;
      stage.classList.add('is-shaking');
      // 端が見えないよう、最大振幅ぶんだけ少し拡大する（開始時に 1 回だけ寸法を読む）
      const minSide = Math.max(1, Math.min(stage.clientWidth, stage.clientHeight));
      scale = 1 + (2 * MAX_SHAKE_PX * strength + 4) / minSide;
    }
    const now = performance.now() / 1000;
    const TAU = Math.PI * 2;
    const x = amp * (0.62 * Math.sin(TAU * 7.3 * now) + 0.38 * Math.sin(TAU * 11.9 * now + 1.3));
    const y = amp * 0.7 * (0.55 * Math.sin(TAU * 5.2 * now + 0.7) + 0.45 * Math.sin(TAU * 13.1 * now + 2.1));
    const r = (amp / MAX_SHAKE_PX) * 0.35 * Math.sin(TAU * 3.1 * now + 0.4);
    const tf = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(3)}deg) scale(${scale.toFixed(4)})`;
    for (const el of targets) el.style.transform = tf;
  };

  ctx.scope.add(store.select((s) => s.time.t, apply));
  ctx.scope.add(store.select((s) => s.time.playing, apply));
  const onReduce = () => apply();
  reduce.addEventListener('change', onReduce);
  ctx.scope.add(() => reduce.removeEventListener('change', onReduce));
  ctx.scope.add(() => reset());
}
