import { describe, expect, it } from 'vitest';
import { centerCrop, checkThumbnail, MAX_THUMBNAIL_BYTES, MIN_THUMBNAIL_BYTES, thumbnailKeyFor, thumbnailSrc } from '@/lib/rooms/thumbnail';

const jpeg = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

describe('checkThumbnail', () => {
  it('알맞은 크기의 JPEG만 받는다', () => {
    expect(checkThumbnail(jpeg(50_000))).toEqual({ ok: true });
    expect(checkThumbnail(jpeg(MAX_THUMBNAIL_BYTES)).ok).toBe(true);
    expect(checkThumbnail(jpeg(MAX_THUMBNAIL_BYTES + 1)).ok).toBe(false);
    expect(checkThumbnail(jpeg(MIN_THUMBNAIL_BYTES - 1)).ok).toBe(false);
  });
  it('JPEG가 아니면 실패 (PNG 머리말)', () => {
    const png = new Uint8Array(50_000);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    const check = checkThumbnail(png);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain('JPEG');
  });
});

describe('대표 사진 키와 주소', () => {
  it('방 폴더 안에 시각을 붙인 이름', () => {
    expect(thumbnailKeyFor('room-1', 1760000000000)).toBe('rooms/room-1/thumbnail-1760000000000.jpg');
  });
  it('주소의 v는 키의 시각 (바뀌면 새 주소)', () => {
    expect(thumbnailSrc('room-1', 'rooms/room-1/thumbnail-1760000000000.jpg')).toBe('/rooms/room-1/thumbnail?v=1760000000000');
    expect(thumbnailSrc('room-1', 'rooms/room-1/other.jpg')).toBe('/rooms/room-1/thumbnail?v=0');
    expect(thumbnailSrc('room-1', null)).toBeNull();
    expect(thumbnailSrc('room-1', '')).toBeNull();
  });
});

describe('centerCrop', () => {
  it('넓은 그림은 양옆을 자른다', () => {
    expect(centerCrop(2000, 800, 1.6)).toEqual({ x: 360, y: 0, w: 1280, h: 800 });
  });
  it('세로 그림은 위아래를 자른다 (폰)', () => {
    expect(centerCrop(780, 1200, 1.6)).toEqual({ x: 0, y: 356, w: 780, h: 488 });
  });
  it('비율이 같으면 그대로, 빈 그림은 0', () => {
    expect(centerCrop(1600, 1000, 1.6)).toEqual({ x: 0, y: 0, w: 1600, h: 1000 });
    expect(centerCrop(0, 100, 1.6)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
