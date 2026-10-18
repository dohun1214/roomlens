import { describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '@/lib/layout/catalog';
import type { SavedItem } from '@/lib/layout/saved';
import { LAYOUT_NAME_MAX, loadSharedLayout, parseLayoutParam, remapFurniture, setLayoutPublic, sharedCopyName, sharedLayoutPath, usedBorrowed } from '@/lib/layout/share';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FURN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const item = (over: Partial<SavedItem> = {}): SavedItem => ({ id: 'f1', furnitureRef: 'desk', kind: 'catalog', x: 0, z: 0, rotationDeg: 0, ...over });
const furniture = (id: string): CatalogItem => ({ id, kind: 'user', nameKo: '내 책장', category: 'etc', w: 0.8, d: 0.3, h: 1.8, clearance: 0 });

describe('공유 링크', () => {
  it('방 주소에 배치 id를 붙인다', () => {
    expect(sharedLayoutPath('room-1', ID)).toBe(`/rooms/room-1?layout=${ID}`);
  });
  it('uuid만 배치 id로 읽는다', () => {
    expect(parseLayoutParam(ID)).toBe(ID);
    expect(parseLayoutParam(ID.toUpperCase())).toBe(ID);
    expect(parseLayoutParam([ID, 'x'])).toBe(ID);
    expect(parseLayoutParam('abc')).toBeNull();
    expect(parseLayoutParam(`${ID}'--`)).toBeNull();
    expect(parseLayoutParam(undefined)).toBeNull();
  });
});

describe('sharedCopyName', () => {
  it('"OO님의 배치"', () => {
    expect(sharedCopyName('민지')).toBe('민지님의 배치');
    expect(sharedCopyName('  ')).toBe('다른 사람님의 배치');
  });
  it('40자를 넘지 않게 닉네임을 줄인다', () => {
    const name = sharedCopyName('가'.repeat(38));
    expect(name.length).toBeLessThanOrEqual(LAYOUT_NAME_MAX);
    expect(name.endsWith('…님의 배치')).toBe(true);
  });
});

describe('남의 가구 바꾸기', () => {
  const items = [item(), item({ id: 'f2', kind: 'user', furnitureRef: FURN }), item({ id: 'f3', kind: 'user', furnitureRef: 'mine-1' })];
  it('남의 가구는 내 사본으로, 카탈로그와 원래 내 가구는 그대로', () => {
    expect(remapFurniture(items, new Set([FURN]), new Map([[FURN, 'copy-1']]))).toEqual([items[0], { ...items[1], furnitureRef: 'copy-1' }, items[2]]);
  });
  it('사본을 못 만든 가구는 뺀다', () => {
    expect(remapFurniture(items, new Set([FURN]), new Map())).toEqual([items[0], items[2]]);
  });
  it('배치에 실제로 쓰인 남의 가구만 고른다', () => {
    expect(usedBorrowed(items, [furniture(FURN), furniture('unused')]).map((f) => f.id)).toEqual([FURN]);
    expect(usedBorrowed([item()], [furniture(FURN)])).toEqual([]);
  });
});

// supabase 클라이언트 흉내: 호출 순서대로 미리 정한 결과를 돌려준다
function fakeClient(results: { data: unknown; error: unknown }[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'select', 'update', 'eq', 'in']) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    });
  }
  const next = () => results.shift() ?? { data: null, error: null };
  builder.maybeSingle = vi.fn(async () => next());
  builder.then = (resolve: (value: unknown) => void) => resolve(next());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: builder as any, calls };
}
const callsOf = (calls: { method: string; args: unknown[] }[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('setLayoutPublic', () => {
  it('공개 여부를 바꾸고, 바뀌었으면 true', async () => {
    const ok = fakeClient([{ data: { id: ID }, error: null }]);
    expect(await setLayoutPublic(ok.client, ID, true)).toBe(true);
    expect(callsOf(ok.calls, 'update')).toEqual([[{ is_public: true }]]);
    expect(await setLayoutPublic(fakeClient([{ data: null, error: null }]).client, ID, true)).toBe(false);
    expect(await setLayoutPublic(fakeClient([{ data: null, error: { message: 'x' } }]).client, ID, false)).toBe(false);
  });
});

describe('loadSharedLayout', () => {
  it('배치·닉네임·쓰인 가구를 읽는다', async () => {
    const { client, calls } = fakeClient([
      { data: { id: ID, name: '내 배치', owner_id: 'u1', items: [item(), item({ id: 'f2', kind: 'user', furnitureRef: FURN }), { bad: true }] }, error: null },
      { data: { nickname: '민지' }, error: null },
      { data: [{ id: FURN, name: '내 책장', category: 'etc', width_m: 0.8, depth_m: 0.3, height_m: 1.8 }], error: null },
    ]);
    const shared = await loadSharedLayout(client, 'room-1', ID);
    expect(shared).toEqual({ id: ID, name: '내 배치', ownerId: 'u1', ownerName: '민지', items: [item(), item({ id: 'f2', kind: 'user', furnitureRef: FURN })], furniture: [furniture(FURN)] });
    expect(callsOf(calls, 'eq').slice(0, 2)).toEqual([
      ['id', ID],
      ['room_id', 'room-1'],
    ]);
    expect(callsOf(calls, 'in')).toEqual([['id', [FURN]]]);
  });
  it('남의 가구가 없으면 가구는 읽지 않는다', async () => {
    const { client, calls } = fakeClient([
      { data: { id: ID, name: '배치', owner_id: 'u1', items: [item()] }, error: null },
      { data: null, error: null },
    ]);
    const shared = await loadSharedLayout(client, 'room-1', ID);
    expect(shared?.ownerName).toBe('알 수 없음');
    expect(shared?.furniture).toEqual([]);
    expect(callsOf(calls, 'in')).toEqual([]);
  });
  it('볼 수 없으면 null', async () => {
    expect(await loadSharedLayout(fakeClient([{ data: null, error: null }]).client, 'room-1', ID)).toBeNull();
  });
});
