import { describe, expect, it } from 'vitest';
import { uploadRoom, UploadError, type UploadDeps, type UploadStage } from '@/lib/upload/uploadRoom';

const ROOM = '3f0c1a52-1b2c-4d3e-8f90-123456789abc';
const plyHead = new TextEncoder().encode('ply\nformat binary');
const file = (size = 5000) => new Blob([new Uint8Array(size)]);

type Call = { method: string; url: string; body: unknown };

/** 정상 응답을 주는 가짜 네트워크. overrides로 일부만 바꾼다 */
function fakeDeps(overrides: Partial<UploadDeps> & { head?: Uint8Array; responses?: Record<string, { status: number; json: unknown }> } = {}) {
  const calls: Call[] = [];
  const puts: { url: string; headers: Record<string, string>; size: number }[] = [];
  const responses: Record<string, { status: number; json: unknown }> = {
    'POST /api/rooms': { status: 201, json: { room: { id: ROOM } } },
    'POST /api/upload-url': { status: 200, json: { url: 'https://r2.example/put', headers: { 'Content-Type': 'application/octet-stream' } } },
    [`PATCH /api/rooms/${ROOM}`]: { status: 200, json: { room: { id: ROOM, status: 'ready' } } },
    ...overrides.responses,
  };
  const deps: UploadDeps = {
    readHead: async () => overrides.head ?? plyHead,
    fetchJson: async (method, url, body) => {
      calls.push({ method, url, body });
      return responses[`${method} ${url}`] ?? { status: 500, json: null };
    },
    put: async (url, headers, body, onProgress) => {
      puts.push({ url, headers, size: body.size });
      onProgress(0.5);
      return 200;
    },
    ...(overrides.put ? { put: overrides.put } : {}),
    ...(overrides.fetchJson ? { fetchJson: overrides.fetchJson } : {}),
  };
  return { deps, calls, puts };
}

const base = { title: '내 방', description: '', consent: true };

async function failure(promise: Promise<unknown>): Promise<UploadError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof UploadError) return err;
    throw err;
  }
  throw new Error('실패해야 하는데 성공함');
}

describe('uploadRoom', () => {
  it('정상: 방 생성 → 주소 발급 → PUT → 완료 확인 순서로 부른다', async () => {
    const { deps, calls, puts } = fakeDeps();
    const stages: UploadStage[] = [];
    const progress: number[] = [];
    const result = await uploadRoom(
      { ...base, file: file(5000), onStage: (s) => stages.push(s), onProgress: (p) => progress.push(p) },
      deps,
    );

    expect(result).toEqual({ roomId: ROOM, format: 'ply' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/rooms', 'POST /api/upload-url', `PATCH /api/rooms/${ROOM}`]);
    expect(calls[0].body).toEqual({ title: '내 방', description: '', consent: true, source: 'scaniverse', credit: '' });
    expect(calls[1].body).toEqual({ roomId: ROOM, kind: 'splat', format: 'ply', size: 5000 });
    expect(calls[2].body).toEqual({ splatFormat: 'ply' });
    expect(puts).toEqual([{ url: 'https://r2.example/put', headers: { 'Content-Type': 'application/octet-stream' }, size: 5000 }]);
    expect(stages).toEqual(['checking', 'creating', 'signing', 'uploading', 'verifying']);
    expect(progress).toEqual([0, 0.5, 1]);
  });

  it('데이터셋 방은 종류와 출처를 함께 보낸다', async () => {
    const { deps, calls } = fakeDeps();
    await uploadRoom({ ...base, file: file(), source: 'dataset', credit: 'Studio 11 by milanoski, CC BY 4.0' }, deps);
    expect(calls[0].body).toMatchObject({ source: 'dataset', credit: 'Studio 11 by milanoski, CC BY 4.0' });
  });

  it('올릴 수 없는 파일이면 서버를 부르지 않는다', async () => {
    const { deps, calls } = fakeDeps({ head: new TextEncoder().encode('hello world') });
    const err = await failure(uploadRoom({ ...base, file: file() }, deps));
    expect(err.stage).toBe('checking');
    expect(err.roomId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('SPZ v4는 PLY 안내 문구로 실패', async () => {
    const { deps } = fakeDeps({ head: new Uint8Array([0x4e, 0x47, 0x53, 0x50, 4, 0, 0, 0]) });
    expect((await failure(uploadRoom({ ...base, file: file() }, deps))).message).toContain('PLY');
  });

  it('방 생성이 거부되면 서버가 준 문구를 그대로 보여준다', async () => {
    const { deps, puts } = fakeDeps({
      responses: { 'POST /api/rooms': { status: 409, json: { error: { code: 'ROOM_LIMIT', message: '방은 10개까지 만들 수 있습니다.' } } } },
    });
    const err = await failure(uploadRoom({ ...base, file: file() }, deps));
    expect(err.message).toBe('방은 10개까지 만들 수 있습니다.');
    expect(err.stage).toBe('creating');
    expect(puts).toHaveLength(0);
  });

  it('PUT이 실패하면 방 id를 남겨 다시 시도할 수 있게 한다', async () => {
    const { deps, calls } = fakeDeps({ put: async () => 0 });
    const err = await failure(uploadRoom({ ...base, file: file() }, deps));
    expect(err.stage).toBe('uploading');
    expect(err.roomId).toBe(ROOM);
    expect(err.message).toContain('업로드에 실패');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('다시 시도: roomId를 주면 방을 새로 만들지 않는다', async () => {
    const { deps, calls } = fakeDeps();
    await uploadRoom({ ...base, file: file(), roomId: ROOM }, deps);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/upload-url', `PATCH /api/rooms/${ROOM}`]);
  });

  it('완료 확인에서 거부되면 그 문구로 실패', async () => {
    const { deps } = fakeDeps({
      responses: { [`PATCH /api/rooms/${ROOM}`]: { status: 400, json: { error: { code: 'FORMAT_MISMATCH', message: '파일 형식이 요청과 다릅니다.' } } } },
    });
    const err = await failure(uploadRoom({ ...base, file: file() }, deps));
    expect(err.stage).toBe('verifying');
    expect(err.message).toBe('파일 형식이 요청과 다릅니다.');
  });

  it('올리는 중 취소하면 aborted로 표시', async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps({
      put: async () => {
        controller.abort();
        throw new DOMException('취소', 'AbortError');
      },
    });
    const err = await failure(uploadRoom({ ...base, file: file(), signal: controller.signal }, deps));
    expect(err.aborted).toBe(true);
    expect(err.roomId).toBe(ROOM);
  });

  it('네트워크 예외(fetch 실패)도 UploadError로 바꾼다', async () => {
    const { deps } = fakeDeps({
      fetchJson: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const err = await failure(uploadRoom({ ...base, file: file() }, deps));
    expect(err).toBeInstanceOf(UploadError);
    expect(err.stage).toBe('creating');
  });
});
