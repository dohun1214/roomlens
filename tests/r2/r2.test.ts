import { beforeAll, describe, expect, it } from 'vitest';

// presigned URL은 네트워크 없이 서명 계산만으로 만들어지므로 가짜 키로 형식을 확인할 수 있다.
let r2: typeof import('@/lib/r2');

beforeAll(async () => {
  process.env.R2_ACCOUNT_ID = 'testaccount';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-access-key';
  process.env.R2_BUCKET = 'test-bucket';
  r2 = await import('@/lib/r2');
});

describe('presignPut', () => {
  it('R2 주소·키·만료 1시간', async () => {
    const url = new URL(await r2.presignPut('rooms/abc/scene.spz', 'application/octet-stream', 1234));
    expect(url.host).toBe('test-bucket.testaccount.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/rooms/abc/scene.spz');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('Content-Type과 Content-Length가 서명에 들어간다 (다른 크기·형식으로는 못 올림)', async () => {
    const url = new URL(await r2.presignPut('rooms/abc/scene.spz', 'application/octet-stream', 1234));
    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(signed).toContain('content-type');
    expect(signed).toContain('content-length');
    expect(signed).toContain('host');
  });

  it('크기가 다르면 서명도 다르다', async () => {
    const a = new URL(await r2.presignPut('k', 'application/octet-stream', 100));
    const b = new URL(await r2.presignPut('k', 'application/octet-stream', 101));
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'));
  });

  it('체크섬 파라미터가 붙지 않는다 (붙으면 브라우저 업로드가 서명 불일치로 실패)', async () => {
    const url = await r2.presignPut('rooms/abc/scene.spz', 'application/octet-stream', 1234);
    expect(url.toLowerCase()).not.toContain('checksum');
  });
});

describe('presignGet', () => {
  it('host만 서명하고 만료는 1시간', async () => {
    const url = new URL(await r2.presignGet('rooms/abc/scene.spz'));
    expect(url.pathname).toBe('/rooms/abc/scene.spz');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});

describe('deletePrefix', () => {
  it('"/"로 끝나지 않는 prefix는 거부한다 (옆 방 파일까지 지우는 일 방지)', async () => {
    await expect(r2.deletePrefix('rooms/abc')).rejects.toThrow('잘못된 prefix');
    await expect(r2.deletePrefix('')).rejects.toThrow('잘못된 prefix');
    await expect(r2.deletePrefix('/')).rejects.toThrow('잘못된 prefix');
  });
});
