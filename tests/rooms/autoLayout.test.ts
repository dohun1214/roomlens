import { describe, expect, it } from 'vitest';
import { closeDoorways, estimateRoomLayout, simplifyOrthogonal, traceOutline } from '@/lib/rooms/autoLayout';
import type { Point2 } from '@/lib/three/floorDrag';
import { polygonIoU } from '@/lib/eval/roomPrepScore';
import { FURNITURE, L_ROOM, fakeRoom, iouBack, rotation, type Vec3 } from './fakeRoom';

describe('traceOutline / simplifyOrthogonal', () => {
  it('L자 마스크의 바깥 경계를 직각 다각형으로', () => {
    const nx = 6;
    const nz = 5;
    const mask = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) if (j < 2 || i < 3) mask[j * nx + i] = 1;
    const poly = traceOutline(mask, { nx, nz, x0: 0, z0: 0, cell: 1 });
    expect(poly).toHaveLength(6);
    expect(polygonIoU(poly, [[0, 0], [6, 0], [6, 2], [3, 2], [3, 5], [0, 5]], 0.1)).toBeCloseTo(1, 2);
  });

  it('짧은 턱은 지운다', () => {
    const notched: Point2[] = [[0, 0], [4, 0], [4, 1], [4.1, 1], [4.1, 1.2], [4, 1.2], [4, 3], [0, 3]];
    const out = simplifyOrthogonal(notched, 0.35);
    expect(out).toHaveLength(4);
  });
});

describe('estimateRoomLayout', () => {
  it('똑바로 선 m 단위 L자 방: 벽에 붙은 옷장에 속지 않고 윤곽을 찾는다', () => {
    const id = (p: Vec3) => p;
    const est = estimateRoomLayout(fakeRoom(L_ROOM, 2.5, FURNITURE, id))!;
    expect(est.up[1]).toBeGreaterThan(0.99);
    expect(est.scale).toBe(1);
    expect(est.ceiling - est.floor).toBeCloseTo(2.5, 1);
    expect(est.corners).toHaveLength(6);
    expect(iouBack(est.corners, id, 1, L_ROOM)).toBeGreaterThan(0.95);
  });

  it('뒤집히고 비스듬히 놓인, 단위가 다른 파일도 위쪽과 크기를 찾는다', () => {
    // 방 좌표 → 파일: X축 180° 뒤집고 Y축 30° 돌림, 파일 1단위 = 0.6 m
    const flip = rotation([1, 0, 0], 180);
    const yaw = rotation([0, 1, 0], 30);
    const toFile = (p: Vec3) => flip(yaw(p));
    const fromFile = (p: Vec3) => rotation([0, 1, 0], -30)(rotation([1, 0, 0], -180)(p));
    const est = estimateRoomLayout(fakeRoom(L_ROOM, 2.5, FURNITURE, toFile, 0.6))!;
    // 파일에서의 위쪽은 아래(-Y)
    expect(est.up[1]).toBeLessThan(-0.99);
    // 높이 2.5/0.6 = 4.17 단위 → m 범위 밖이라 2.45 m로 짐작
    expect(est.scaleGuessed).toBe(true);
    expect(est.scale).toBeCloseTo(2.45 / (2.5 / 0.6), 2);
    // 짐작한 크기는 실제(0.6)와 2% 차이: 모양은 그대로
    const unit = 0.6; // 되돌릴 때는 실제 단위
    expect(iouBack(est.corners, fromFile, unit, L_ROOM)).toBeGreaterThan(0.93);
  });
});

describe('closeDoorways', () => {
  it('벽 줄 위의 문 폭 틈은 잇고, 세로로 지나가는 벽 단면끼리는 잇지 않는다', () => {
    const nx = 40;
    const nz = 10;
    const mask = new Uint8Array(nx * nz);
    // 가로 벽 (z=2) 의 x 0~14, 31~39, 그 사이 16칸(0.8 m) 틈 = 문
    for (let i = 0; i < nx; i += 1) if (i < 15 || i > 30) mask[2 * nx + i] = 1;
    // 세로 벽 두 개 (x=5, x=12) 의 단면이 z=6 줄에 한 칸씩
    for (let j = 4; j < nz; j += 1) {
      mask[j * nx + 5] = 1;
      mask[j * nx + 12] = 1;
    }
    closeDoorways(mask, nx, nz, 20, 6);
    expect(Array.from({ length: 16 }, (_, k) => mask[2 * nx + 15 + k]).every((v) => v === 1)).toBe(true);
    expect(mask[6 * nx + 8]).toBe(0);
  });
});
