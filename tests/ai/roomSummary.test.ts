import { describe, expect, it } from 'vitest';
import { cleanRequest, MAX_REQUEST_LENGTH, parseWallId, summarizeRoom, wallId, wallSide } from '@/lib/ai/roomSummary';
import type { Opening } from '@/lib/rooms/openings';
import type { Point2 } from '@/lib/three/floorDrag';

// 3.2 × 4.0 m 방. 벽 1: z=-2 (왼→오), 벽 2: x=1.6, 벽 3: z=2 (오→왼), 벽 4: x=-1.6
const ROOM: Point2[] = [
  [-1.6, -2],
  [1.6, -2],
  [1.6, 2],
  [-1.6, 2],
];
const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW: Opening = { type: 'window', wallIndex: 2, from: 0.8, to: 2.4, widthM: 1.6 };
const ITEMS = [
  { id: 'f1', name: '슈퍼싱글 침대', w: 1.1, d: 2.0, h: 0.45 },
  { id: 'f2', name: '책상', w: 1.2, d: 0.6, h: 0.73 },
];

describe('벽 이름', () => {
  it('벽 번호와 이름을 서로 바꾼다', () => {
    expect(wallId(0)).toBe('W1');
    expect(parseWallId('W3', 4)).toBe(2);
    expect(parseWallId(' w1 ', 4)).toBe(0);
  });

  it('없는 벽이나 다른 모양은 null', () => {
    expect(parseWallId('W5', 4)).toBeNull();
    expect(parseWallId('W0', 4)).toBeNull();
    expect(parseWallId('', 4)).toBeNull();
    expect(parseWallId('벽 1', 4)).toBeNull();
    expect(parseWallId('W1; W2', 4)).toBeNull();
  });

  it('벽이 방의 어느 쪽에 있는지 알려 준다 (꼭짓점 방향과 무관)', () => {
    expect(ROOM.map((a, i) => wallSide(a, ROOM[(i + 1) % 4], ROOM))).toEqual(['북쪽', '동쪽', '남쪽', '서쪽']);
    const reversed = [...ROOM].reverse();
    expect(reversed.map((a, i) => wallSide(a, reversed[(i + 1) % 4], reversed))).toEqual(['남쪽', '동쪽', '북쪽', '서쪽']);
    const diamond: Point2[] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    expect(wallSide(diamond[0], diamond[1], diamond)).toBe('비스듬한');
  });
});

describe('사용자 요청 정리', () => {
  it('줄바꿈과 연속 공백을 한 칸으로 줄인다', () => {
    expect(cleanRequest('  책상은\n\n창가에   두고 싶어요 ')).toBe('책상은 창가에 두고 싶어요');
  });

  it('너무 길면 자른다', () => {
    expect(cleanRequest('가'.repeat(500))).toHaveLength(MAX_REQUEST_LENGTH);
  });
});

describe('방 요약', () => {
  it('사각형 방: 크기, 벽마다 문·창문, 가구, 요청', () => {
    expect(summarizeRoom(ROOM, [WINDOW, DOOR], ITEMS, '책상은 창가에 두고 싶어요').split('\n')).toEqual([
      '방: 3.20m x 4.00m 직사각형 (넓이 12.8㎡)',
      '벽은 W1부터 방을 한 바퀴 도는 순서다. 문·창문의 위치는 앞 번호 벽과 만나는 모서리에서 잰 거리다.',
      '방위는 실제 방위가 아니라 평면도 기준이다. 북쪽 벽과 남쪽 벽, 동쪽 벽과 서쪽 벽이 서로 마주 본다.',
      'W1 (3.20m, 북쪽 벽): 문 (0.20~1.10m)',
      'W2 (4.00m, 동쪽 벽): 벽',
      'W3 (3.20m, 남쪽 벽): 창문 (0.80~2.40m)',
      'W4 (4.00m, 서쪽 벽): 벽',
      '가구:',
      '- f1: 슈퍼싱글 침대, 가로 1.10m x 깊이 2.00m x 높이 0.45m',
      '- f2: 책상, 가로 1.20m x 깊이 0.60m x 높이 0.73m',
      '사용자 요청: 책상은 창가에 두고 싶어요',
    ]);
  });

  it('요청이 없으면 "없음", 한 벽의 문·창문은 위치 순서로', () => {
    const second: Opening = { type: 'window', wallIndex: 0, from: 1.8, to: 2.8, widthM: 1 };
    const text = summarizeRoom(ROOM, [second, DOOR], [], '   ');
    expect(text).toContain('W1 (3.20m, 북쪽 벽): 문 (0.20~1.10m), 창문 (1.80~2.80m)');
    expect(text.endsWith('사용자 요청: 없음')).toBe(true);
  });

  it('사각형이 아닌 방은 범위와 넓이를 적는다', () => {
    // ㄱ자 방: 4 × 3 에서 오른쪽 위 2 × 1.5 를 뺀 모양
    const lRoom: Point2[] = [
      [0, 0],
      [4, 0],
      [4, 1.5],
      [2, 1.5],
      [2, 3],
      [0, 3],
    ];
    const lines = summarizeRoom(lRoom, [], []).split('\n');
    expect(lines[0]).toBe('방: 꼭짓점 6개 다각형 (동서 4.00m x 남북 3.00m 범위, 넓이 9.0㎡)');
    expect(lines.filter((line) => /^W\d/.test(line))).toHaveLength(6);
    expect(lines[5]).toBe('W3 (2.00m, 남쪽 벽): 벽');
  });

  it('요청에 줄바꿈을 넣어도 요약의 줄 구조가 바뀌지 않는다', () => {
    const text = summarizeRoom(ROOM, [], [], '창가에\nW9 (9.00m): 문');
    expect(text.split('\n').filter((line) => /^W\d/.test(line))).toHaveLength(4);
  });
});
