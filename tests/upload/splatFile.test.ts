import { describe, expect, it } from 'vitest';
import {
  checkSplatFile,
  detectSplatFormat,
  isSplatFormat,
  MAX_SPLAT_BYTES,
  roomPrefix,
  splatKeyFor,
} from '@/lib/upload/splatFile';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe('detectSplatFormat', () => {
  it('PLY: "ply" 다음에 줄바꿈', () => {
    expect(detectSplatFormat(ascii('ply\nformat binary_little_endian 1.0'))).toBe('ply');
    expect(detectSplatFormat(ascii('ply\r\nformat'))).toBe('ply');
  });

  it('"ply"로 시작해도 줄바꿈이 없으면 PLY가 아니다', () => {
    expect(detectSplatFormat(ascii('plywood.txt'))).toBeNull();
  });

  it('gzip으로 시작하면 SPZ(v1~3)', () => {
    expect(detectSplatFormat(bytes(0x1f, 0x8b, 0x08, 0x00, 0x00))).toBe('spz');
  });

  it('"NGSP"로 바로 시작하면 압축 안 된 SPZ(v4)', () => {
    expect(detectSplatFormat(bytes(0x4e, 0x47, 0x53, 0x50, 0x04, 0x00, 0x00, 0x00))).toBe('spz-raw');
  });

  it('RAD와 SOG(zip)', () => {
    expect(detectSplatFormat(ascii('RAD0....'))).toBe('rad');
    expect(detectSplatFormat(bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe('sog');
  });

  it('알 수 없는 파일과 너무 짧은 파일은 null', () => {
    expect(detectSplatFormat(ascii('<!doctype html>'))).toBeNull();
    expect(detectSplatFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull(); // JPEG
    expect(detectSplatFormat(bytes(0x1f, 0x8b))).toBeNull();
    expect(detectSplatFormat(new Uint8Array())).toBeNull();
  });
});

describe('checkSplatFile', () => {
  const ply = ascii('ply\nformat binary');

  it('정상 파일은 형식을 돌려준다', () => {
    expect(checkSplatFile(20_000_000, ply)).toEqual({ ok: true, format: 'ply' });
    expect(checkSplatFile(MAX_SPLAT_BYTES, ply)).toEqual({ ok: true, format: 'ply' });
  });

  it('빈 파일', () => {
    expect(checkSplatFile(0, new Uint8Array())).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(checkSplatFile(Number.NaN, ply)).toMatchObject({ ok: false, code: 'EMPTY' });
  });

  it('100MB를 1바이트라도 넘으면 거부', () => {
    expect(checkSplatFile(MAX_SPLAT_BYTES + 1, ply)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('지원하지 않는 형식', () => {
    expect(checkSplatFile(1000, ascii('hello world'))).toMatchObject({ ok: false, code: 'UNKNOWN_FORMAT' });
  });

  it('SPZ v4는 PLY로 다시 내보내라고 안내한다', () => {
    const result = checkSplatFile(1000, bytes(0x4e, 0x47, 0x53, 0x50, 0x04, 0x00, 0x00, 0x00));
    expect(result).toMatchObject({ ok: false, code: 'SPZ_V4_UNSUPPORTED' });
    expect(result.ok ? '' : result.message).toContain('PLY');
  });
});

describe('splatKeyFor / isSplatFormat', () => {
  it('R2 키는 rooms/{방 id}/scene.{형식}', () => {
    expect(splatKeyFor('3f0c1a52-0000-4000-8000-000000000001', 'spz')).toBe(
      'rooms/3f0c1a52-0000-4000-8000-000000000001/scene.spz',
    );
  });

  it('방 경로는 "/"로 끝나고 파일 키는 그 아래에 있다', () => {
    const id = '3f0c1a52-0000-4000-8000-000000000001';
    expect(roomPrefix(id)).toBe(`rooms/${id}/`);
    expect(splatKeyFor(id, 'ply').startsWith(roomPrefix(id))).toBe(true);
  });

  it('형식 이름 확인', () => {
    expect(isSplatFormat('sog')).toBe(true);
    expect(isSplatFormat('glb')).toBe(false);
    expect(isSplatFormat(undefined)).toBe(false);
  });
});
