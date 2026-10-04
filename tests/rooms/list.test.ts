import { describe, expect, it } from 'vitest';
import { formatRoomDate, roomBadges, toRoomCards, type RoomListRow } from '@/lib/rooms/list';

const row = (over: Partial<RoomListRow> = {}): RoomListRow => ({
  id: 'r1',
  owner_id: 'u1',
  title: '내 방',
  description: '',
  is_public: false,
  status: 'ready',
  source: 'scaniverse',
  created_at: '2026-10-04T16:30:00Z',
  ...over,
});

describe('formatRoomDate', () => {
  it('한국 시간 기준 날짜로 보여준다 (UTC 10/4 16:30 = 한국 10/5 01:30)', () => {
    expect(formatRoomDate('2026-10-04T16:30:00Z')).toBe('2026. 10. 5.');
  });

  it('잘못된 값은 빈 문자열', () => {
    expect(formatRoomDate('not a date')).toBe('');
  });
});

describe('roomBadges', () => {
  it('공개 방 목록: 직접 찍은 방은 표시 없음, 데이터셋만 표시', () => {
    expect(roomBadges(row({ is_public: true }), false)).toEqual([]);
    expect(roomBadges(row({ is_public: true, source: 'dataset' }), false)).toEqual(['데이터셋']);
  });

  it('내 방 목록: 공개 여부와 올리는 중 상태를 표시', () => {
    expect(roomBadges(row(), true)).toEqual(['비공개']);
    expect(roomBadges(row({ is_public: true }), true)).toEqual(['공개']);
    expect(roomBadges(row({ status: 'uploading' }), true)).toEqual(['비공개', '올리는 중']);
    expect(roomBadges(row({ status: 'failed', source: 'dataset' }), true)).toEqual(['비공개', '올리기 실패', '데이터셋']);
  });
});

describe('toRoomCards', () => {
  it('닉네임을 붙이고, 없으면 "알 수 없음"', () => {
    const cards = toRoomCards([row(), row({ id: 'r2', owner_id: 'u2' })], new Map([['u1', '도훈']]), false);
    expect(cards.map((c) => [c.id, c.ownerNickname])).toEqual([
      ['r1', '도훈'],
      ['r2', '알 수 없음'],
    ]);
    expect(cards[0].createdLabel).toBe('2026. 10. 5.');
  });

  it('받은 순서를 그대로 유지한다', () => {
    const cards = toRoomCards([row({ id: 'b' }), row({ id: 'a' })], new Map(), true);
    expect(cards.map((c) => c.id)).toEqual(['b', 'a']);
  });
});
