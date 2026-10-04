import { describe, expect, it } from 'vitest';
import { parseSavedCalibration, startPoseForRoom, toCalibrationColumns } from '@/lib/rooms/calibration';

const transform = { s: 1.02, q: [0, 0.7071, 0, 0.7071], t: [0.5, -0.1, 2], flipX: true };
const polygon = [
  [-2.85, -2.5],
  [2.85, -2.5],
  [2.85, 2.5],
  [-2.85, 2.5],
];

describe('parseSavedCalibration', () => {
  it('저장된 값을 읽는다', () => {
    expect(parseSavedCalibration(transform, polygon)).toEqual({
      transform: { s: 1.02, q: [0, 0.7071, 0, 0.7071], t: [0.5, -0.1, 2] },
      flipX: true,
      floorPolygon: polygon,
    });
  });

  it('flipX가 없으면 false', () => {
    const withoutFlip = { s: transform.s, q: transform.q, t: transform.t };
    expect(parseSavedCalibration(withoutFlip, polygon)?.flipX).toBe(false);
  });

  it('보정하지 않은 방(null)은 null', () => {
    expect(parseSavedCalibration(null, null)).toBeNull();
    expect(parseSavedCalibration(transform, null)).toBeNull();
    expect(parseSavedCalibration(null, polygon)).toBeNull();
  });

  it('형식이 맞지 않으면 null (누가 이상한 값을 넣어도 뷰어가 깨지지 않게)', () => {
    expect(parseSavedCalibration({ ...transform, s: 0 }, polygon)).toBeNull();
    expect(parseSavedCalibration({ ...transform, s: -1 }, polygon)).toBeNull();
    expect(parseSavedCalibration({ ...transform, q: [0, 0, 0] }, polygon)).toBeNull();
    expect(parseSavedCalibration({ ...transform, q: [0, 0, 0, 0] }, polygon)).toBeNull();
    expect(parseSavedCalibration({ ...transform, t: ['a', 0, 0] }, polygon)).toBeNull();
    expect(parseSavedCalibration(transform, [[0, 0], [1, 1]])).toBeNull(); // 꼭짓점 2개
    expect(parseSavedCalibration(transform, 'polygon')).toBeNull();
    expect(parseSavedCalibration({ ...transform, s: Number.POSITIVE_INFINITY }, polygon)).toBeNull();
  });

  it('저장 → 읽기 왕복', () => {
    const saved = parseSavedCalibration(transform, polygon);
    if (!saved) throw new Error('읽기 실패');
    const columns = toCalibrationColumns(saved);
    expect(columns.transform).toEqual(transform);
    expect(parseSavedCalibration(columns.transform, columns.floor_polygon)).toEqual(saved);
  });
});

describe('startPoseForRoom', () => {
  it('방 가운데를 눈높이에서 바라보고, 긴 쪽(X)으로 물러난다', () => {
    const pose = startPoseForRoom(polygon as [number, number][]);
    expect(pose.target).toEqual([0, 1.1, 0]);
    expect(pose.position[0]).toBeCloseTo(5.7 * 0.3);
    expect(pose.position[1]).toBe(1.5);
    expect(pose.position[2]).toBe(0);
  });

  it('Z가 더 긴 방은 Z로 물러난다', () => {
    const pose = startPoseForRoom([[0, 0], [2, 0], [2, 6], [0, 6]]);
    expect(pose.target).toEqual([1, 1.1, 3]);
    expect(pose.position[0]).toBe(1);
    expect(pose.position[2]).toBeCloseTo(3 + 6 * 0.3);
  });

  it('카메라가 방 안에 있다', () => {
    const pose = startPoseForRoom(polygon as [number, number][]);
    expect(Math.abs(pose.position[0])).toBeLessThan(2.85);
    expect(Math.abs(pose.position[2])).toBeLessThan(2.5);
  });
});
