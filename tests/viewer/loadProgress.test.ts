import { describe, expect, it } from 'vitest';
import { loadingBarValue, loadingLabel, progressFromBytes } from '@/lib/viewer/loadProgress';

describe('progressFromBytes', () => {
  it('받는 중에는 내림한 퍼센트', () => {
    expect(progressFromBytes(0, 1000)).toEqual({ phase: 'download', percent: 0 });
    expect(progressFromBytes(456, 1000)).toEqual({ phase: 'download', percent: 45 });
    expect(progressFromBytes(999, 1000)).toEqual({ phase: 'download', percent: 99 });
  });

  it('다 받으면 준비 단계로 넘어간다', () => {
    expect(progressFromBytes(1000, 1000)).toEqual({ phase: 'prepare', percent: 100 });
    expect(progressFromBytes(1200, 1000)).toEqual({ phase: 'prepare', percent: 100 });
  });

  it('전체 크기를 모르면 퍼센트 없이 받는 중', () => {
    expect(progressFromBytes(500, 0)).toEqual({ phase: 'download', percent: null });
    expect(progressFromBytes(500, Number.NaN)).toEqual({ phase: 'download', percent: null });
    expect(progressFromBytes(-1, 1000)).toEqual({ phase: 'download', percent: null });
  });
});

describe('loadingLabel / loadingBarValue', () => {
  it('받는 중: 퍼센트 표시', () => {
    expect(loadingLabel({ phase: 'download', percent: 45 })).toBe('3D 파일 받는 중… 45%');
    expect(loadingBarValue({ phase: 'download', percent: 45 })).toBe(45);
  });

  it('크기를 모를 때: 퍼센트 없이, 막대는 값 없음(움직이는 막대)', () => {
    expect(loadingLabel({ phase: 'download', percent: null })).toBe('3D 파일 받는 중…');
    expect(loadingBarValue({ phase: 'download', percent: null })).toBeUndefined();
  });

  it('준비 중: 막대는 가득', () => {
    expect(loadingLabel({ phase: 'prepare', percent: 100 })).toBe('3D 준비 중…');
    expect(loadingBarValue({ phase: 'prepare', percent: null })).toBe(100);
  });
});
