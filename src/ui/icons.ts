/** UI 用の小さな線画アイコン（24×24、currentColor）。 */

const PATHS = {
  play: '<path d="M7 4.6v14.8l12.4-7.4z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/>',
  help: '<circle cx="12" cy="12" r="9.3"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2 1-1.2 1.8v.5"/><circle cx="12" cy="17.1" r=".9" fill="currentColor" stroke="none"/>',
  wave: '<path d="M2.5 15.2c2.3 0 3.3-2.7 5.6-2.7s3.3 2.7 5.6 2.7 3.3-2.7 5.6-2.7c1.2 0 2.2.7 2.2.7"/><path d="M2.5 19.6c2.3 0 3.3-2.3 5.6-2.3s3.3 2.3 5.6 2.3 3.3-2.3 5.6-2.3c1.2 0 2.2.6 2.2.6"/><path d="M4.2 10.6C5.3 6.4 8.5 4 12.3 4c2.4 0 4.1.9 5 2.4-2.6-.5-4.9.9-4.9 3.5"/>',
  retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.2h8.6l.9-12.2"/><path d="M10.2 10.8v5.2M13.8 10.8v5.2"/>',
  user: '<circle cx="12" cy="7.6" r="3.4"/><path d="M5.2 20.2c.7-3.9 3.4-6.2 6.8-6.2s6.1 2.3 6.8 6.2"/>',
  users:
    '<circle cx="9" cy="8" r="3.1"/><path d="M3.2 19.5c.6-3.5 2.9-5.6 5.8-5.6s5.2 2.1 5.8 5.6"/><path d="M15.2 5.2a3.1 3.1 0 0 1 0 5.8M17.3 14.3c1.9.7 3.1 2.5 3.5 5.2"/>',
  layers: '<path d="M12 3.5l8.8 4.8L12 13 3.2 8.3z"/><path d="M3.2 12.4L12 17.1l8.8-4.7"/><path d="M3.2 16.3L12 21l8.8-4.7"/>',
  info: '<circle cx="12" cy="12" r="9.3"/><path d="M12 10.8v6"/><circle cx="12" cy="7.5" r=".95" fill="currentColor" stroke="none"/>',
  alert: '<path d="M12 3.8l9.2 16H2.8z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  quake: '<path d="M2 12h3.2l2-5.5 3.2 11 3-9 2.2 5.5 1.8-2H22"/>',
  pin: '<path d="M12 21s-6.3-5.8-6.3-10.8a6.3 6.3 0 0 1 12.6 0C18.3 15.2 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.2"/>',
  chevronDown: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  chevronUp: '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5"/><path d="M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10"/>',
  clock: '<circle cx="12" cy="12" r="9.3"/><path d="M12 7v5.3l3.4 2"/>',
  drop: '<path d="M12 3.5s6 6.3 6 10.7a6 6 0 0 1-12 0c0-4.4 6-10.7 6-10.7z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor" stroke="none"/>',
  map: '<path d="M9 4.5L3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8z"/><path d="M9 4.5v12.7M15 6.8v12.7"/>',
  cube: '<path d="M12 3.3l7.8 4.4v8.6L12 20.7l-7.8-4.4V7.7z"/><path d="M4.2 7.7L12 12l7.8-4.3M12 12v8.7"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  mountain: '<path d="M2.5 19.5L9 8.5l3.6 6 2.4-3.5 6.5 8.5z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** アイコンの SVG 要素を作る（装飾扱い: aria-hidden） */
export function icon(name: IconName, size = 20, cls = 'icon'): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="${cls}">${PATHS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}
