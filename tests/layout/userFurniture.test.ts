import { describe, expect, it, vi } from 'vitest';
import { categoryColor, DEFAULT_CATALOG } from '@/lib/layout/catalog';
import { parseSavedItems, placeCatalogItem, restoreItems, toSavedItems } from '@/lib/layout/saved';
import {
  createUserFurniture,
  deleteUserFurniture,
  fromUserFurnitureRow,
  loadUserFurniture,
  parseUserFurnitureForm,
  type UserFurnitureForm,
} from '@/lib/layout/userFurniture';

const form = (over: Partial<UserFurnitureForm> = {}): UserFurnitureForm => ({ name: '수납장', width: '80', depth: '40', height: '120', ...over });
const message = (f: UserFurnitureForm) => {
  const r = parseUserFurnitureForm(f);
  return r.ok ? null : r.message;
};
const ROW = { id: 'u-1', name: '수납장', category: 'etc', width_m: 0.8, depth_m: 0.4, height_m: 1.2 };

describe('parseUserFurnitureForm', () => {
  it('cm로 넣은 치수를 m로 바꾼다', () => {
    expect(parseUserFurnitureForm(form())).toEqual({ ok: true, value: { name: '수납장', w: 0.8, d: 0.4, h: 1.2 } });
  });

  it('이름 앞뒤 공백을 지우고, 치수는 1cm 단위로 맞춘다', () => {
    expect(parseUserFurnitureForm(form({ name: '  내 책상 ', width: ' 120.4 ', depth: '59.6' }))).toEqual({
      ok: true,
      value: { name: '내 책상', w: 1.2, d: 0.6, h: 1.2 },
    });
  });

  it('이름이 없거나 길면 거부', () => {
    expect(message(form({ name: '   ' }))).toBe('이름을 넣어 주세요.');
    expect(message(form({ name: '가'.repeat(21) }))).toBe('이름은 20자까지 쓸 수 있습니다.');
    expect(message(form({ name: '가'.repeat(20) }))).toBeNull();
  });

  it('치수가 숫자가 아니거나 범위를 벗어나면 어느 값인지 알려준다', () => {
    expect(message(form({ width: '' }))).toBe('가로를 숫자(cm)로 넣어 주세요.');
    expect(message(form({ depth: '넓게' }))).toBe('깊이를 숫자(cm)로 넣어 주세요.');
    expect(message(form({ width: '9' }))).toBe('가로는 10~500 cm 사이여야 합니다.');
    expect(message(form({ depth: '501' }))).toBe('깊이는 10~500 cm 사이여야 합니다.');
    expect(message(form({ height: '4' }))).toBe('높이는 5~300 cm 사이여야 합니다.');
    expect(message(form({ height: '-10' }))).toBe('높이는 5~300 cm 사이여야 합니다.');
    expect(message(form({ width: '10', depth: '500', height: '5' }))).toBeNull();
  });
});

describe('fromUserFurnitureRow', () => {
  it("가구 목록 항목으로 바꾼다 (kind는 'user')", () => {
    expect(fromUserFurnitureRow(ROW)).toEqual({ id: 'u-1', kind: 'user', nameKo: '수납장', category: 'etc', w: 0.8, d: 0.4, h: 1.2, clearance: 0 });
  });

  it('DB가 숫자를 글자로 돌려줘도 숫자로 바꾼다', () => {
    const item = fromUserFurnitureRow({ ...ROW, width_m: '0.80' as unknown as number });
    expect(item.w).toBe(0.8);
  });
});

describe('배치에 놓기 · 저장 · 되살리기', () => {
  const mine = fromUserFurnitureRow(ROW);

  it("내 가구를 놓으면 kind가 'user'이고 저장 항목도 그렇다", () => {
    const placed = placeCatalogItem(mine, 'f1', { x: 1, z: -0.5, rotationDeg: 90 });
    expect(placed).toMatchObject({ kind: 'user', furnitureRef: 'u-1', name: '수납장', w: 0.8, d: 0.4, h: 1.2, color: categoryColor('etc') });
    expect(toSavedItems([placed])).toEqual([{ id: 'f1', furnitureRef: 'u-1', kind: 'user', x: 1, z: -0.5, rotationDeg: 90 }]);
  });

  it('카탈로그 가구와 섞어 저장했다가 되살린다', () => {
    const placed = [
      placeCatalogItem(DEFAULT_CATALOG[3], 'f1', { x: 0, z: 0, rotationDeg: 0 }),
      placeCatalogItem(mine, 'f2', { x: 1, z: -0.5, rotationDeg: 90 }),
    ];
    const saved = parseSavedItems(JSON.parse(JSON.stringify(toSavedItems(placed))));
    expect(restoreItems(saved, DEFAULT_CATALOG, [mine])).toEqual({ items: placed, missing: 0 });
  });

  it('지운 내 가구는 건너뛰고 수를 센다. 카탈로그와 id가 같아도 섞이지 않는다', () => {
    const saved = parseSavedItems([
      { id: 'f1', furnitureRef: 'u-gone', kind: 'user', x: 0, z: 0, rotationDeg: 0 },
      { id: 'f2', furnitureRef: 'desk', kind: 'user', x: 0, z: 0, rotationDeg: 0 },
      { id: 'f3', furnitureRef: 'u-1', kind: 'catalog', x: 0, z: 0, rotationDeg: 0 },
    ]);
    expect(restoreItems(saved, DEFAULT_CATALOG, [mine])).toEqual({ items: [], missing: 3 });
  });
});

// supabase 클라이언트 흉내: 호출 순서대로 미리 정한 결과를 돌려준다
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'select', 'insert', 'delete', 'eq', 'order']) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    });
  }
  // 목록은 limit에서, 한 건은 maybeSingle에서 끝난다
  builder.limit = vi.fn(async () => result);
  builder.maybeSingle = vi.fn(async () => result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: builder as any, calls };
}
const argsOf = (calls: { method: string; args: unknown[] }[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('읽기 · 만들기 · 지우기', () => {
  it('내 가구를 만든 순서대로 읽는다', async () => {
    const { client, calls } = fakeClient({ data: [ROW, { ...ROW, id: 'u-2', name: '선반' }], error: null });
    const list = await loadUserFurniture(client, 'user-1');
    expect(list.map((f) => [f.id, f.nameKo, f.kind])).toEqual([
      ['u-1', '수납장', 'user'],
      ['u-2', '선반', 'user'],
    ]);
    expect(argsOf(calls, 'from')).toEqual([['user_furniture']]);
    expect(argsOf(calls, 'eq')).toEqual([['owner_id', 'user-1']]);
    expect(argsOf(calls, 'order')).toEqual([['created_at']]);
  });

  it('읽지 못하면 빈 목록', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'x' } });
    expect(await loadUserFurniture(client, 'user-1')).toEqual([]);
  });

  it('만들기: 이름과 치수만 보낸다 (주인·분류는 DB가 채운다)', async () => {
    const { client, calls } = fakeClient({ data: ROW, error: null });
    expect(await createUserFurniture(client, { name: '수납장', w: 0.8, d: 0.4, h: 1.2 })).toMatchObject({ id: 'u-1', kind: 'user', w: 0.8 });
    expect(argsOf(calls, 'insert')).toEqual([[{ name: '수납장', width_m: 0.8, depth_m: 0.4, height_m: 1.2 }]]);
  });

  it('만들기 실패면 null', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'x' } });
    expect(await createUserFurniture(client, { name: '수납장', w: 0.8, d: 0.4, h: 1.2 })).toBeNull();
  });

  it('지우기: 지워진 행이 있어야 true', async () => {
    const ok = fakeClient({ data: { id: 'u-1' }, error: null });
    expect(await deleteUserFurniture(ok.client, 'u-1')).toBe(true);
    expect(argsOf(ok.calls, 'eq')).toEqual([['id', 'u-1']]);
    const none = fakeClient({ data: null, error: null });
    expect(await deleteUserFurniture(none.client, 'u-1')).toBe(false);
  });
});
