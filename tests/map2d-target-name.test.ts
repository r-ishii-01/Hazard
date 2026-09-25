/**
 * 地図の札に出す短い避難先の名前（src/map2d/targetName.ts）。
 * 避難先の名前（src/people/plan.ts）は選んだ根拠を含む長い文なので、札には種類・標高・読み違えると危ない注意だけを残す。
 */
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL_MAX_CHARS, shortTargetName } from '../src/map2d/targetName';

describe('shortTargetName', () => {
  it('最寄りの高台は種類と標高だけにする', () => {
    expect(shortTargetName('最寄りの高台（公式の浸水想定区域の外・計算でも浸水なし・標高 7.8 m）')).toBe('最寄りの高台（標高 7.8 m）');
    expect(shortTargetName('最寄りの高台（公式の浸水想定区域の外・標高 12.0 m・計算途中の結果で浸水なし）')).toBe('最寄りの高台（標高 12.0 m）');
    expect(shortTargetName('最寄りの高台（公式の浸水想定区域の外・標高 9.1 m・想定津波高 T.P.10.0 m + 1 m 以上）')).toBe('最寄りの高台（標高 9.1 m）');
  });

  it('公式の浸水想定区域の外か確かめていないことは札にも残す', () => {
    const name =
      '避難場所に到達できないため最寄りの高台（標高 9.1 m・想定津波高 T.P.10.0 m + 1 m 以上。公式の津波浸水想定を読み込めなかったため、公式の浸水想定区域の外かは未確認）';
    expect(shortTargetName(name)).toBe('最寄りの高台（標高 9.1 m・公式区域外か未確認）');
  });

  it('近くで最も高い地点は「安全とは限らない」を残す', () => {
    expect(shortTargetName('安全な高台に到達できないため近くで最も高い地点（標高 3.2 m・安全とは限りません）')).toBe('近くで最も高い地点（標高 3.2 m・安全とは限らない）');
  });

  it('現在地は標高だけにする', () => {
    expect(shortTargetName('現在地（公式の浸水想定区域の外・計算でも浸水なし・標高 15.4 m）')).toBe('現在地（標高 15.4 m）');
  });

  it('避難場所の名前はそのまま（長ければ切る）', () => {
    expect(shortTargetName('鵠沼小学校')).toBe('鵠沼小学校');
    const long = 'あいうえおかきくけこさしすせそたちつてとなにぬねの';
    const s = shortTargetName(long);
    expect([...s].length).toBe(TARGET_LABEL_MAX_CHARS);
    expect(s.endsWith('…')).toBe(true);
    expect(shortTargetName('')).toBe('');
  });
});
