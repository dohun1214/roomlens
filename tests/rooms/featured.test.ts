import { describe, expect, it } from 'vitest';
import { pickFeatured, shortTitle, sizeLabel } from '@/lib/rooms/featured';

describe('pickFeatured', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  it('정한 방을 정한 순서대로', () => {
    expect(pickFeatured(rows, ['d', 'b'], 2).map((r) => r.id)).toEqual(['d', 'b']);
  });
  it('없는 방은 건너뛰고 나머지로 채운다', () => {
    expect(pickFeatured(rows, ['x', 'c'], 3).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
  it('공개 방이 적으면 있는 만큼만', () => {
    expect(pickFeatured([{ id: 'a' }], ['a', 'b'], 4)).toHaveLength(1);
  });
});

describe('shortTitle / sizeLabel', () => {
  it('끝의 괄호를 뗀다', () => {
    expect(shortTitle('한국식 거실 (생성한 방)')).toBe('한국식 거실');
    expect(shortTitle('침실 (Bedroom)')).toBe('침실');
    expect(shortTitle('(이름)')).toBe('(이름)');
  });
  it('긴 쪽 먼저, 0.1 m 단위', () => {
    expect(sizeLabel([[0, 0], [3.46, 0], [3.46, 5.83], [0, 5.83]])).toBe('5.8 × 3.5 m');
    expect(sizeLabel([[0, 0], [1, 0]])).toBeNull();
  });
});
