/**
 * 2D 地図モジュール専用の最小限のスタイル（クラス名は m2d- で始める）。
 * 全体のレイアウト・配色は UI 担当の CSS に任せ、ここでは地図上の要素だけを扱う。
 */
const CSS = `
.m2d-root { position: absolute; inset: 0; overflow: hidden; }
.m2d-root .maplibregl-map { font: 12px/1.4 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif; }
/* 出典は長いので、左下の縮尺と重ならない幅で折り返す */
.m2d-root .maplibregl-ctrl-bottom-right { max-width: calc(100% - 150px); }
.m2d-root .maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib.maplibregl-compact-show { max-width: 100%; }
.m2d-root .maplibregl-ctrl-attrib-inner { overflow-wrap: anywhere; }
.m2d-root.m2d-placing .maplibregl-canvas-container.maplibregl-interactive,
.m2d-root.m2d-placing .maplibregl-canvas { cursor: crosshair; }

/* 通知（範囲外クリックなど）と配置モードのヒント */
.m2d-hint, .m2d-toast {
  position: absolute; left: 50%; transform: translateX(-50%); z-index: 4;
  max-width: calc(100% - 96px); box-sizing: border-box;
  padding: 5px 12px; border-radius: 999px; font-size: 12.5px; line-height: 1.4;
  pointer-events: none; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.m2d-hint {
  top: 10px; background: rgba(255,255,255,.96); color: #0f172a; box-shadow: 0 1px 4px rgba(15,23,42,.25); border: 1px solid #cbd5e1;
  pointer-events: auto; white-space: normal; overflow: visible; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0 2px;
  width: max-content; max-width: calc(100% - 110px); padding: 4px 6px 4px 12px;
}
.m2d-hint b { color: #0369a1; }
.m2d-hint__more { color: #475569; }
.m2d-hint__done {
  margin-left: 6px; font: inherit; font-size: 12px; font-weight: 600; line-height: 1.2; color: #fff; background: #0369a1;
  border: 0; border-radius: 999px; padding: 4px 10px; cursor: pointer;
}
.m2d-hint__done:hover { background: #075985; }
.m2d-hint__done:focus-visible { outline: 2px solid #0ea5e9; outline-offset: 2px; }
@media (max-width: 520px) {
  .m2d-hint { max-width: calc(100% - 64px); left: 8px; transform: none; border-radius: 12px; }
  .m2d-hint__more { display: none; }
  .m2d-toast { max-width: calc(100% - 64px); left: 8px; transform: none; white-space: normal; border-radius: 10px; }
}
.m2d-toast { top: 10px; background: rgba(15,23,42,.9); color: #fff; opacity: 0; transition: opacity .18s ease; }
.m2d-toast.m2d-show { opacity: 1; }
.m2d-hint[hidden] { display: none; }

/* タイル（背景地図など）を取得できないときの案内（取得できるようになるまで出したまま） */
.m2d-notice {
  position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 4; box-sizing: border-box;
  width: max-content; max-width: min(560px, calc(100% - 110px)); display: flex; align-items: center; gap: 8px;
  padding: 6px 6px 6px 12px; border-radius: 10px; border: 1px solid #fdba74; background: #fff7ed; color: #7c2d12;
  box-shadow: 0 1px 4px rgba(15,23,42,.25); font-size: 12.5px; line-height: 1.45; pointer-events: auto;
}
.m2d-notice[hidden] { display: none; }
.m2d-notice__retry {
  flex: none; font: inherit; font-size: 12px; font-weight: 600; line-height: 1.2; color: #fff; background: #9a3412;
  border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer;
}
.m2d-notice__retry:hover { background: #7c2d12; }
.m2d-notice__retry:focus-visible { outline: 2px solid #0ea5e9; outline-offset: 2px; }
@media (max-width: 520px) {
  .m2d-notice { left: 8px; transform: none; max-width: calc(100% - 64px); }
}

/* 計算範囲ラベル */
.m2d-domain-label {
  pointer-events: none; font-size: 11px; font-weight: 600; color: #1e293b; white-space: nowrap;
  background: rgba(255,255,255,.82); border: 1px dashed #334155; border-radius: 3px; padding: 0 5px; margin: 4px 0 0 4px;
}

/* 主な地点 */
.m2d-poi {
  pointer-events: none; font-size: 11px; color: #334155; white-space: nowrap; font-weight: 500;
  text-shadow: 0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff;
}
.m2d-poi::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #475569; margin-right: 3px; vertical-align: 1px; }
.m2d-zlow .m2d-poi { display: none; }
.m2d-basemap-labeled .m2d-poi--station { display: none; }

/* 避難場所 */
.m2d-shelter { width: 24px; height: 24px; cursor: pointer; }
.m2d-shelter__dot {
  width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff;
  background: var(--m2d-c, #15803d); border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.45);
  transition: transform .12s ease;
}
.m2d-shelter__dot svg { width: 14px; height: 14px; display: block; }
.m2d-shelter:hover .m2d-shelter__dot, .m2d-shelter:focus-visible .m2d-shelter__dot { transform: scale(1.18); }
.m2d-shelter:focus-visible { outline: none; }
.m2d-shelter:focus-visible .m2d-shelter__dot { box-shadow: 0 0 0 3px #0ea5e9; }
.m2d-shelter--target .m2d-shelter__dot { box-shadow: 0 0 0 3px rgba(250,204,21,.95), 0 1px 3px rgba(0,0,0,.45); }
.m2d-zlow .m2d-shelter__dot { transform: scale(.62); }
.m2d-zlow .m2d-shelter__dot svg { visibility: hidden; }
.m2d-popup .maplibregl-popup-content { padding: 8px 12px 9px; border-radius: 8px; font-size: 12px; line-height: 1.5; color: #0f172a; max-width: 260px; }
.m2d-popup h4 { margin: 0 18px 2px 0; font-size: 13.5px; line-height: 1.35; }
.m2d-popup .m2d-pk { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 999px; color: #fff; margin-bottom: 3px; }
.m2d-popup p { margin: 2px 0 0; }
.m2d-popup .m2d-src { color: #64748b; font-size: 10.5px; margin-top: 4px; }

/* 人物 */
.m2d-person { width: 34px; height: 34px; cursor: pointer; }
.m2d-person.m2d-drag { cursor: grab; }
.m2d-person__disc {
  position: absolute; inset: 0; border-radius: 50%; background: #fff; box-sizing: border-box;
  border: 3px solid var(--m2d-ring, #64748b); display: grid; place-items: center; color: var(--m2d-kind, #1e293b);
  box-shadow: 0 1px 4px rgba(0,0,0,.45); transition: transform .12s ease, box-shadow .12s ease;
}
.m2d-person__disc svg { width: 24px; height: 24px; display: block; }
.m2d-person__badge {
  position: absolute; right: -5px; top: -5px; width: 17px; height: 17px; border-radius: 50%; box-sizing: border-box;
  background: var(--m2d-ring, #64748b); border: 1.5px solid #fff; color: var(--m2d-ink, #fff); display: grid; place-items: center;
}
.m2d-person__badge svg { width: 13px; height: 13px; display: block; }
.m2d-person__label {
  position: absolute; top: 37px; left: 50%; transform: translateX(-50%); white-space: nowrap; pointer-events: none;
  font-size: 11px; line-height: 1.35; color: #0f172a; background: rgba(255,255,255,.93); border-radius: 4px;
  padding: 0 4px; box-shadow: 0 0 0 1px rgba(15,23,42,.18);
}
.m2d-person__depth { display: inline-block; margin-left: 3px; padding: 0 4px; border-radius: 3px; color: var(--m2d-ink, #fff); background: var(--m2d-ring, #64748b); font-weight: 700; }
.m2d-person--selected { z-index: 3; }
.m2d-person--selected .m2d-person__disc { transform: scale(1.18); box-shadow: 0 0 0 3px #fff, 0 0 0 6px #facc15, 0 2px 6px rgba(0,0,0,.5); }
.m2d-person--selected .m2d-person__label { font-weight: 700; box-shadow: 0 0 0 1.5px #ca8a04; }
.m2d-person:focus-visible { outline: none; }
.m2d-person:focus-visible .m2d-person__disc { box-shadow: 0 0 0 3px #0ea5e9; }
.m2d-person--danger .m2d-person__disc::after, .m2d-person--critical .m2d-person__disc::after {
  content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 3px solid var(--m2d-ring);
  animation: m2d-pulse 1.1s ease-out infinite; pointer-events: none;
}
.m2d-person--critical .m2d-person__disc::after { animation-duration: .8s; }
@keyframes m2d-pulse { from { transform: scale(1); opacity: .9; } to { transform: scale(1.9); opacity: 0; } }
/* 地名検索で選んだ場所の目印 */
.m2d-search { display: flex; flex-direction: column; align-items: center; pointer-events: none; }
.m2d-search__label {
  display: flex; align-items: center; gap: 2px; max-width: 220px; margin-bottom: 2px; padding: 2px 2px 2px 8px;
  border-radius: 999px; background: rgba(15,23,42,.9); color: #fff; font-size: 12px; font-weight: 700; line-height: 1.35;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: auto;
}
.m2d-search__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m2d-search__close {
  flex: none; width: 22px; height: 22px; border: 0; border-radius: 50%; background: transparent; color: #fff;
  font: 700 15px/1 system-ui, sans-serif; cursor: pointer; display: grid; place-items: center;
}
.m2d-search__close:hover { background: rgba(255,255,255,.18); }
.m2d-search__close:focus-visible { outline: 2px solid #38bdf8; outline-offset: 1px; }
.m2d-search__pin { width: 32px; height: 42px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
.m2d-search__pin svg { display: block; }

/* 現在地 */
.m2d-userloc { width: 22px; height: 22px; display: grid; place-items: center; pointer-events: auto; cursor: default; }
.m2d-userloc__dot {
  position: relative; width: 16px; height: 16px; border-radius: 50%; background: #2563eb; border: 3px solid #fff;
  box-sizing: border-box; box-shadow: 0 1px 4px rgba(0,0,0,.45);
}
.m2d-userloc__dot::after {
  content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid #2563eb; opacity: 0;
  animation: m2d-userloc 1.8s ease-out infinite;
}
@keyframes m2d-userloc { from { transform: scale(.8); opacity: .8; } to { transform: scale(2.2); opacity: 0; } }

/*
 * 狭い画面・タッチ操作: 指で押しやすい大きさに（40px 以上。見た目の大きさが変わらない印は押せる範囲だけ広げる）。
 * ズームのボタンの高さは、下の「場所を探す」ボタンと重ならない範囲で最大 40px（index.ts の fitControls が --m2d-zoom-h を設定）。
 */
@media (max-width: 819.98px), (pointer: coarse) {
  .m2d-root .maplibregl-ctrl-top-right .maplibregl-ctrl { margin: 8px 8px 0 0; }
  .m2d-root .maplibregl-ctrl-group button { width: 40px; height: var(--m2d-zoom-h, 29px); }
  /* 出典の開閉ボタン（右下）。上端は、下中央の状態表示（HUD、下から 34px）より下に収める */
  .m2d-root .maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib.maplibregl-compact { margin: 0 6px 2px 0; min-height: 28px; padding-right: 32px; border-radius: 16px; }
  .m2d-root .maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib.maplibregl-compact-show { padding-right: 36px; }
  .m2d-root .maplibregl-ctrl-attrib-button { width: 32px; height: 32px; border-radius: 16px; background-position: center; background-repeat: no-repeat; }
  .m2d-shelter { width: 40px; height: 40px; display: grid; place-items: center; }
  .m2d-person::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; }
  .m2d-hint__done { min-height: 40px; padding: 8px 14px; }
  .m2d-notice__retry { min-height: 40px; padding: 8px 14px; }
  .m2d-search__close { width: 40px; height: 40px; margin: -9px -8px -9px -4px; }
}

@media (prefers-reduced-motion: reduce) {
  .m2d-userloc__dot::after { animation: none; }
  .m2d-person--danger .m2d-person__disc::after, .m2d-person--critical .m2d-person__disc::after { animation: none; transform: scale(1.35); opacity: .6; }
  .m2d-toast { transition: none; }
}
`;

let injected = false;

/** スタイルを一度だけ <head> に追加する */
export function injectMap2dStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.dataset.module = 'map2d';
  el.textContent = CSS;
  document.head.appendChild(el);
}
