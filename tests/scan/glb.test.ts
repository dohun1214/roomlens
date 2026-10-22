import { describe, expect, it } from 'vitest';
import { checkGlb, scanModelKey } from '@/lib/scan/glb';

const glb = (length: number, { magic = 0x46546c67, version = 2, declared = length } = {}) => {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, version, true);
  view.setUint32(8, declared, true);
  return bytes;
};

describe('checkGlb', () => {
  it('머리말이 맞는 GLB는 통과', () => {
    expect(checkGlb(glb(100))).toEqual({ ok: true });
  });
  it('GLB가 아니거나, 버전이 다르거나, 잘렸거나, 너무 크면 이유와 함께 거부', () => {
    expect(checkGlb(glb(100, { magic: 0x12345678 }))).toMatchObject({ ok: false, message: expect.stringContaining('GLB 파일이 아닙니다') });
    expect(checkGlb(glb(100, { version: 1 }))).toMatchObject({ ok: false });
    expect(checkGlb(glb(100, { declared: 200 }))).toMatchObject({ ok: false, message: expect.stringContaining('잘렸습니다') });
    expect(checkGlb(glb(100), 50)).toMatchObject({ ok: false, message: expect.stringContaining('너무 큽니다') });
    expect(checkGlb(new Uint8Array(4))).toMatchObject({ ok: false });
  });
});

describe('scanModelKey', () => {
  it('내 가구 모델은 사용자 폴더 아래', () => {
    expect(scanModelKey('u1', 'f1')).toBe('furniture/user/u1/f1.glb');
  });
});
