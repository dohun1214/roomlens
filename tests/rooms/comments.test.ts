import { describe, expect, it } from 'vitest';
import { MAX_COMMENT_LENGTH, parseCommentBody, relativeTime } from '@/lib/rooms/comments';

describe('parseCommentBody', () => {
  it('앞뒤 공백을 빼고 줄바꿈을 맞춘다', () => {
    expect(parseCommentBody('  소파 위치 좋네요  \r\n')).toEqual({ ok: true, body: '소파 위치 좋네요' });
    expect(parseCommentBody('첫 줄 \r\n둘째 줄')).toEqual({ ok: true, body: '첫 줄\n둘째 줄' });
  });
  it('빈 줄은 두 줄까지만 남긴다', () => {
    expect(parseCommentBody('위\n\n\n\n\n아래')).toEqual({ ok: true, body: '위\n\n아래' });
  });
  it('비었으면 실패', () => {
    expect(parseCommentBody('   \n\t ').ok).toBe(false);
    expect(parseCommentBody('').ok).toBe(false);
  });
  it('너무 길면 실패, 딱 맞으면 성공', () => {
    expect(parseCommentBody('가'.repeat(MAX_COMMENT_LENGTH)).ok).toBe(true);
    const long = parseCommentBody('가'.repeat(MAX_COMMENT_LENGTH + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain(String(MAX_COMMENT_LENGTH));
  });
  it('다듬은 뒤 길이로 잰다', () => {
    expect(parseCommentBody(`  ${'가'.repeat(MAX_COMMENT_LENGTH)}  `).ok).toBe(true);
  });
});

describe('relativeTime', () => {
  // 2026-10-19 15:00 KST
  const now = new Date('2026-10-19T06:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it('1분 안은 방금', () => {
    expect(relativeTime(ago(0), now)).toBe('방금');
    expect(relativeTime(ago(59_000), now)).toBe('방금');
  });
  it('분과 시간', () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5분 전');
    expect(relativeTime(ago(59 * 60_000), now)).toBe('59분 전');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3시간 전');
  });
  it('하루가 넘으면 한국 날짜로 어제', () => {
    // 2026-10-18 13:00 KST
    expect(relativeTime('2026-10-18T04:00:00Z', now)).toBe('어제');
  });
  it('한국 시간 자정을 기준으로 날짜를 나눈다', () => {
    // UTC로는 10/17 16:00이지만 한국은 10/18 01:00 → 어제
    expect(relativeTime('2026-10-17T16:00:00Z', new Date('2026-10-19T02:00:00Z'))).toBe('어제');
  });
  it('그보다 오래되면 날짜, 올해가 아니면 연도까지', () => {
    expect(relativeTime('2026-10-12T03:00:00Z', now)).toBe('10/12');
    expect(relativeTime('2025-12-31T03:00:00Z', now)).toBe('2025/12/31');
  });
  it('미래 시각(시계 차이)은 방금, 잘못된 값은 빈 글자', () => {
    expect(relativeTime(new Date(now.getTime() + 30_000).toISOString(), now)).toBe('방금');
    expect(relativeTime('nope', now)).toBe('');
  });
});
