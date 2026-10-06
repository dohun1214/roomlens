import { describe, expect, it } from 'vitest';
import { countByRoom, formatRoomDate, roomBadges, roomOutline, toRoomCards, type RoomListRow } from '@/lib/rooms/list';

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

const SQUARE = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };

describe('roomOutline', () => {
  it('보정하지 않은 방은 null', () => {
    expect(roomOutline(row())).toBeNull();
    expect(roomOutline(row({ transform: TRANSFORM, floor_polygon: [[0, 0]] }))).toBeNull();
  });

  it('보정한 방: 바닥 모양과 문·창문의 양 끝점', () => {
    const outline = roomOutline(
      row({
        transform: TRANSFORM,
        floor_polygon: SQUARE,
        openings: [
          { type: 'door', wallIndex: 0, from: 0.5, to: 1.4, widthM: 0.9 },
          { type: 'window', wallIndex: 9, from: 0, to: 1, widthM: 1 }, // 없는 벽 → 버림
        ],
      }),
    );
    expect(outline?.polygon).toEqual(SQUARE);
    expect(outline?.openings.length).toBe(1);
    const [door] = outline?.openings ?? [];
    expect(door.type).toBe('door');
    expect(door.a).toEqual([-1.5, -1.5]);
    expect(door.b[0]).toBeCloseTo(-0.6, 9);
    expect(door.b[1]).toBe(-1.5);
  });
});

describe('toRoomCards: 내 방의 상태', () => {
  it('공개 목록에는 상태가 없고 바닥 모양만 있다', () => {
    const [card] = toRoomCards([row({ transform: TRANSFORM, floor_polygon: SQUARE })], new Map(), false);
    expect(card.stats).toBeNull();
    expect(card.outline?.polygon.length).toBe(4);
  });

  it('내 방: 보정 여부, 문·창문 수, 배치 수, 리포트', () => {
    const rows = [
      row({ id: 'a', transform: TRANSFORM, floor_polygon: SQUARE, openings: [{ type: 'door', wallIndex: 0, from: 0.5, to: 1.4, widthM: 0.9 }] }),
      row({ id: 'b' }),
      row({ id: 'c', status: 'uploading' }),
    ];
    const cards = toRoomCards(rows, new Map(), true, { layoutCounts: new Map([['a', 2]]), reportRoomIds: new Set(['a']) });
    expect(cards[0].stats).toEqual({ calibrated: true, openings: 1, layouts: 2, hasReport: true });
    expect(cards[1].stats).toEqual({ calibrated: false, openings: 0, layouts: 0, hasReport: false });
    // 올리다 만 방은 상태를 보여주지 않는다
    expect(cards[2].stats).toBeNull();
  });
});

describe('countByRoom', () => {
  it('방 id별로 센다', () => {
    expect([...countByRoom([{ room_id: 'a' }, { room_id: 'b' }, { room_id: 'a' }])]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(countByRoom(null).size).toBe(0);
  });
});

