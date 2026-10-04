import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG } from '@/lib/layout/catalog';
import {
  MAX_LAYOUT_ITEMS,
  nextItemNumber,
  parseSavedItems,
  placeCatalogItem,
  restoreItems,
  sameSavedItems,
  toSavedItems,
  type SavedItem,
} from '@/lib/layout/saved';
import { loadMyLayout, saveMyLayout } from '@/lib/layout/store';

const desk = DEFAULT_CATALOG.find((c) => c.id === 'desk')!;
const saved = (over: Partial<SavedItem> = {}): SavedItem => ({
  id: 'f1',
  furnitureRef: 'desk',
  kind: 'catalog',
  x: 1,
  z: -0.5,
  rotationDeg: 90,
  ...over,
});

describe('parseSavedItems', () => {
  it('올바른 항목은 그대로 읽는다', () => {
    expect(parseSavedItems([saved(), saved({ id: 'f2', furnitureRef: 'chair' })])).toEqual([
      saved(),
      saved({ id: 'f2', furnitureRef: 'chair' }),
    ]);
  });

  it('배열이 아니면 빈 배치', () => {
    expect(parseSavedItems(null)).toEqual([]);
    expect(parseSavedItems({ items: [] })).toEqual([]);
    expect(parseSavedItems('[]')).toEqual([]);
  });

  it('모양이 틀린 항목만 버린다', () => {
    const raw = [
      saved(),
      { id: 'f2', furnitureRef: 'desk', kind: 'catalog', x: '1', z: 0, rotationDeg: 0 },
      { id: 'f3', furnitureRef: 'desk', kind: 'glb', x: 1, z: 0, rotationDeg: 0 },
      { id: 'f4', furnitureRef: 'desk', kind: 'catalog', x: 1e9, z: 0, rotationDeg: 0 },
      { id: 'f5', kind: 'catalog', x: 1, z: 0, rotationDeg: 0 },
      null,
      saved({ id: 'f6' }),
    ];
    expect(parseSavedItems(raw).map((i) => i.id)).toEqual(['f1', 'f6']);
  });

  it('id가 겹치면 처음 것만 남긴다', () => {
    expect(parseSavedItems([saved({ x: 1 }), saved({ x: 2 })])).toEqual([saved({ x: 1 })]);
  });

  it('회전은 0~359°로 맞춘다', () => {
    expect(parseSavedItems([saved({ rotationDeg: 450 }), saved({ id: 'f2', rotationDeg: -90 })]).map((i) => i.rotationDeg)).toEqual([90, 270]);
  });

  it(`${MAX_LAYOUT_ITEMS}개까지만 읽는다`, () => {
    const many = Array.from({ length: MAX_LAYOUT_ITEMS + 5 }, (_, i) => saved({ id: `f${i + 1}` }));
    expect(parseSavedItems(many)).toHaveLength(MAX_LAYOUT_ITEMS);
  });
});

describe('toSavedItems · restoreItems', () => {
  it('저장 형식에는 치수·이름을 넣지 않고 좌표는 mm로 반올림한다', () => {
    const placed = placeCatalogItem(desk, 'f1', { x: 1.23456, z: -0.00049, rotationDeg: 360 });
    expect(toSavedItems([placed])).toEqual([{ id: 'f1', furnitureRef: 'desk', kind: 'catalog', x: 1.235, z: 0, rotationDeg: 0 }]);
  });

  it('저장했다가 되살리면 같은 가구가 같은 자리에 놓인다', () => {
    const placed = [
      placeCatalogItem(desk, 'f1', { x: 1.25, z: -0.5, rotationDeg: 90 }),
      placeCatalogItem(DEFAULT_CATALOG[0], 'f2', { x: -1, z: 0.75, rotationDeg: 0 }),
    ];
    const { items, missing } = restoreItems(parseSavedItems(JSON.parse(JSON.stringify(toSavedItems(placed)))), DEFAULT_CATALOG);
    expect(missing).toBe(0);
    expect(items).toEqual(placed);
  });

  it('카탈로그에 없는 가구와 내 가구(아직 지원 전)는 건너뛰고 수를 센다', () => {
    const { items, missing } = restoreItems(
      [saved(), saved({ id: 'f2', furnitureRef: 'gone' }), saved({ id: 'f3', kind: 'user', furnitureRef: 'desk' })],
      DEFAULT_CATALOG,
    );
    expect(items.map((i) => i.id)).toEqual(['f1']);
    expect(missing).toBe(2);
  });

  it('되살린 가구는 카탈로그의 현재 치수를 쓴다', () => {
    const { items } = restoreItems([saved()], [{ ...desk, w: 1.4 }]);
    expect(items[0].w).toBe(1.4);
  });
});

describe('nextItemNumber · sameSavedItems', () => {
  it('가장 큰 번호 다음 수', () => {
    expect(nextItemNumber([])).toBe(1);
    expect(nextItemNumber([{ id: 'f2' }, { id: 'f10' }, { id: 'f3' }])).toBe(11);
    expect(nextItemNumber([{ id: 'ai-1' }, { id: 'f2x' }])).toBe(1);
  });

  it('같은 배치인지 비교', () => {
    expect(sameSavedItems([saved()], [saved()])).toBe(true);
    expect(sameSavedItems([], [])).toBe(true);
    expect(sameSavedItems([saved()], [saved({ x: 1.05 })])).toBe(false);
    expect(sameSavedItems([saved()], [saved({ rotationDeg: 180 })])).toBe(false);
    expect(sameSavedItems([saved()], [])).toBe(false);
    expect(sameSavedItems([saved(), saved({ id: 'f2' })], [saved({ id: 'f2' }), saved()])).toBe(false);
  });
});

// supabase 클라이언트 흉내: 호출 순서대로 미리 정한 결과를 돌려준다
function fakeClient(results: { data: unknown; error: unknown }[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'select', 'insert', 'update', 'eq', 'order', 'limit']) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    });
  }
  builder.maybeSingle = vi.fn(async () => results.shift() ?? { data: null, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: builder as any, calls };
}
const callsOf = (calls: { method: string; args: unknown[] }[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('loadMyLayout', () => {
  it('내 배치를 최근 것부터 하나 읽고 items를 검증한다', async () => {
    const { client, calls } = fakeClient([{ data: { id: 'L1', items: [saved(), { bad: true }] }, error: null }]);
    expect(await loadMyLayout(client, 'room-1', 'user-1')).toEqual({ id: 'L1', items: [saved()] });
    expect(callsOf(calls, 'eq')).toEqual([
      ['room_id', 'room-1'],
      ['owner_id', 'user-1'],
    ]);
    expect(callsOf(calls, 'order')).toEqual([['updated_at', { ascending: false }]]);
  });

  it('없으면 null', async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    expect(await loadMyLayout(client, 'room-1', 'user-1')).toBeNull();
  });
});

describe('saveMyLayout', () => {
  it('처음 저장하면 새로 만든다 (주인은 DB가 채운다)', async () => {
    const { client, calls } = fakeClient([{ data: { id: 'L1' }, error: null }]);
    expect(await saveMyLayout(client, 'room-1', null, [saved()])).toBe('L1');
    expect(callsOf(calls, 'insert')).toEqual([[{ room_id: 'room-1', items: [saved()] }]]);
    expect(callsOf(calls, 'update')).toEqual([]);
  });

  it('이미 있으면 그 배치를 고친다', async () => {
    const { client, calls } = fakeClient([{ data: { id: 'L1' }, error: null }]);
    expect(await saveMyLayout(client, 'room-1', 'L1', [])).toBe('L1');
    expect(callsOf(calls, 'update')).toEqual([[{ items: [] }]]);
    expect(callsOf(calls, 'eq')).toEqual([['id', 'L1']]);
    expect(callsOf(calls, 'insert')).toEqual([]);
  });

  it('고치려던 배치가 사라졌으면 새로 만든다', async () => {
    const { client, calls } = fakeClient([
      { data: null, error: null },
      { data: { id: 'L2' }, error: null },
    ]);
    expect(await saveMyLayout(client, 'room-1', 'L1', [saved()])).toBe('L2');
    expect(callsOf(calls, 'insert')).toHaveLength(1);
  });

  it('오류면 null', async () => {
    const update = fakeClient([{ data: null, error: { message: 'x' } }]);
    expect(await saveMyLayout(update.client, 'room-1', 'L1', [])).toBeNull();
    expect(callsOf(update.calls, 'insert')).toEqual([]);
    const insert = fakeClient([{ data: null, error: { message: 'x' } }]);
    expect(await saveMyLayout(insert.client, 'room-1', null, [])).toBeNull();
  });
});
