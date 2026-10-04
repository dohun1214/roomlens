import { describe, expect, it } from 'vitest';
import { CompleteUploadInput, CreateRoomInput, firstIssueMessage, RoomId, UploadUrlInput } from '@/lib/rooms/schemas';
import { MAX_SPLAT_BYTES } from '@/lib/upload/splatFile';

const roomId = '3f0c1a52-1b2c-4d3e-8f90-123456789abc';

describe('CreateRoomInput', () => {
  it('제목 앞뒤 공백을 지우고 설명 기본값은 빈 문자열', () => {
    expect(CreateRoomInput.parse({ title: '  내 자취방 ', consent: true })).toEqual({
      title: '내 자취방',
      description: '',
      consent: true,
      source: 'scaniverse',
      credit: '',
    });
  });

  it('직접 찍은 방이 기본값이고 출처는 비워도 된다', () => {
    expect(CreateRoomInput.parse({ title: '내 방', consent: true })).toMatchObject({ source: 'scaniverse', credit: '' });
  });

  it('데이터셋 방은 출처·라이선스가 있어야 한다', () => {
    const missing = CreateRoomInput.safeParse({ title: '샘플 방', consent: true, source: 'dataset', credit: '   ' });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(firstIssueMessage(missing.error)).toContain('출처');
    expect(
      CreateRoomInput.parse({ title: '샘플 방', consent: true, source: 'dataset', credit: ' Studio 11 by milanoski, CC BY 4.0 ' }),
    ).toMatchObject({ source: 'dataset', credit: 'Studio 11 by milanoski, CC BY 4.0' });
  });

  it('알 수 없는 종류와 너무 긴 출처는 거부', () => {
    expect(CreateRoomInput.safeParse({ title: '방', consent: true, source: 'worldlabs' }).success).toBe(false);
    expect(CreateRoomInput.safeParse({ title: '방', consent: true, source: 'dataset', credit: '가'.repeat(301) }).success).toBe(false);
  });

  it('동의하지 않으면 거부하고 이유를 알려준다', () => {
    const result = CreateRoomInput.safeParse({ title: '내 방', consent: false });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIssueMessage(result.error)).toContain('동의');
    expect(CreateRoomInput.safeParse({ title: '내 방' }).success).toBe(false);
  });

  it('빈 제목·너무 긴 제목 거부', () => {
    expect(CreateRoomInput.safeParse({ title: '   ', consent: true }).success).toBe(false);
    expect(CreateRoomInput.safeParse({ title: '가'.repeat(61), consent: true }).success).toBe(false);
    expect(CreateRoomInput.safeParse({ title: '가'.repeat(60), consent: true }).success).toBe(true);
  });

  it('본문이 JSON이 아닐 때(null)도 예외 없이 실패로 처리', () => {
    expect(CreateRoomInput.safeParse(null).success).toBe(false);
  });
});

describe('UploadUrlInput', () => {
  const base = { roomId, kind: 'splat', format: 'spz', size: 20_000_000 };

  it('정상 입력', () => {
    expect(UploadUrlInput.safeParse(base).success).toBe(true);
    expect(UploadUrlInput.safeParse({ ...base, size: MAX_SPLAT_BYTES }).success).toBe(true);
  });

  it('크기: 0, 소수, 100MB 초과 거부', () => {
    expect(UploadUrlInput.safeParse({ ...base, size: 0 }).success).toBe(false);
    expect(UploadUrlInput.safeParse({ ...base, size: 10.5 }).success).toBe(false);
    expect(UploadUrlInput.safeParse({ ...base, size: MAX_SPLAT_BYTES + 1 }).success).toBe(false);
  });

  it('형식·종류·방 id 검사', () => {
    expect(UploadUrlInput.safeParse({ ...base, format: 'glb' }).success).toBe(false);
    expect(UploadUrlInput.safeParse({ ...base, kind: 'photo' }).success).toBe(false);
    expect(UploadUrlInput.safeParse({ ...base, roomId: '../../etc' }).success).toBe(false);
  });
});

describe('CompleteUploadInput / RoomId', () => {
  it('형식만 받는다', () => {
    expect(CompleteUploadInput.safeParse({ splatFormat: 'ply' }).success).toBe(true);
    expect(CompleteUploadInput.safeParse({ splatFormat: 'exe' }).success).toBe(false);
    expect(CompleteUploadInput.safeParse({}).success).toBe(false);
  });

  it('방 id는 uuid만', () => {
    expect(RoomId.safeParse(roomId).success).toBe(true);
    expect(RoomId.safeParse('abc').success).toBe(false);
  });
});
