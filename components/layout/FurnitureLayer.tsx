'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { DEFAULT_CATALOG, type CatalogItem } from '@/lib/layout/catalog';
import { doorZone } from '@/lib/layout/access';
import { checkLayout, findFreeSpot, violatingIds, warningIds } from '@/lib/layout/check';
import type { Opening } from '@/lib/rooms/openings';
import {
  MAX_LAYOUT_ITEMS,
  nextItemNumber,
  placeCatalogItem,
  restoreItems,
  sameSavedItems,
  toSavedItems,
  type PlacedItem,
  type SavedItem,
} from '@/lib/layout/saved';
import { placeOnFloor, rayFloorPoint, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { pointerToNdc } from '@/lib/three/pickPoint';
import type { Engine } from '@/components/viewer/engine';
import FloorPlan from './FloorPlan';

type Item = PlacedItem;

const EDGE_COLOR = 0xffffff;
const SELECTED_EDGE_COLOR = 0xffe14d;
const VIOLATION_EDGE_COLOR = 0xff3b30;
const VIOLATION_EMISSIVE = 0x7a1010;
const WARNING_EDGE_COLOR = 0xffc233;
const WARNING_EMISSIVE = 0x4a3800;
const NO_OPENINGS: Opening[] = [];

type Drag = { id: string; pointerId: number; offset: Point2; current: Footprint };

/**
 * 보정된 방(바닥 y=0, 단위 m) 위에 박스 가구를 놓고 바닥 평면에서 끈다.
 * 가구는 roomGroup이 아니라 scene에 직접 넣는다 (방 좌표 = 월드 좌표).
 * 겹치거나 방 밖으로 나갔거나 문 앞·통로를 막는 가구는 빨갛게, 창문을 가리는 가구는 노랗게 표시하고 이유를 알려준다.
 * onSave가 있으면 저장 버튼을 보여주고, initialItems(저장된 배치)로 시작한다.
 */
export default function FurnitureLayer({
  engineRef,
  floorPolygon,
  catalog = DEFAULT_CATALOG,
  openings = NO_OPENINGS,
  initialItems,
  onSave,
  loginHint = false,
}: {
  engineRef: RefObject<Engine | null>;
  floorPolygon: Point2[];
  /** 놓을 수 있는 가구 목록. 방 화면은 DB의 카탈로그를 넘긴다 */
  catalog?: CatalogItem[];
  /** 방의 문·창문. 문 앞·통로·창문 가림 검사에 쓴다 */
  openings?: Opening[];
  /** 저장된 배치. 처음 한 번만 읽는다 */
  initialItems?: SavedItem[];
  /** 배치를 저장한다. 성공하면 true */
  onSave?: (items: SavedItem[]) => Promise<boolean>;
  /** 로그인하면 저장할 수 있다는 안내를 보여줄지 */
  loginHint?: boolean;
}) {
  const [restored] = useState(() => restoreItems(initialItems ?? [], catalog));
  const [items, setItems] = useState<Item[]>(restored.items);
  // 마지막으로 저장한 배치 (지금 배치와 다르면 "저장 안 됨")
  const [savedItems, setSavedItems] = useState<SavedItem[]>(() => toSavedItems(restored.items));
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'error'>('idle');
  // 3D 위에 2D 평면도를 덮어 보여줄지
  const [showPlan, setShowPlan] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemsRef = useRef<Item[]>([]);
  const groupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const violations = useMemo(() => checkLayout(items, floorPolygon, openings), [items, floorPolygon, openings]);
  const badIds = useMemo(() => violatingIds(violations), [violations]);
  const warnIds = useMemo(() => warningIds(violations), [violations]);
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const hasDoor = openings.some((o) => o.type === 'door');
  const currentSaved = useMemo(() => toSavedItems(items), [items]);
  const dirty = !sameSavedItems(currentSaved, savedItems);
  const saveState = savePhase === 'saving' ? 'saving' : !dirty ? 'saved' : savePhase === 'error' ? 'error' : 'dirty';
  const full = items.length >= MAX_LAYOUT_ITEMS;

  // 가구 음영용 조명 (스플랫에는 영향을 주지 않는다)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(2, 5, 3);
    engine.scene.add(hemisphere, sun);
    return () => {
      engine.scene.remove(hemisphere, sun);
    };
  }, [engineRef]);

  // 가구 메시 만들기
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];

    for (const item of items) {
      const bad = badIds.has(item.id);
      const warn = warnIds.has(item.id);
      const geometry = new THREE.BoxGeometry(item.w, item.h, item.d);
      const material = new THREE.MeshLambertMaterial({ color: item.color, emissive: bad ? VIOLATION_EMISSIVE : warn ? WARNING_EMISSIVE : 0x000000 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, item.h / 2, item.z);
      mesh.rotation.y = THREE.MathUtils.degToRad(item.rotationDeg);
      mesh.userData.id = item.id;

      const edgeGeometry = new THREE.EdgesGeometry(geometry);
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: bad ? VIOLATION_EDGE_COLOR : warn ? WARNING_EDGE_COLOR : item.id === selectedId ? SELECTED_EDGE_COLOR : EDGE_COLOR,
      });
      mesh.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
      group.add(mesh);
      disposables.push(geometry, material, edgeGeometry, edgeMaterial);
    }

    engine.scene.add(group);
    groupRef.current = group;
    return () => {
      engine.scene.remove(group);
      groupRef.current = null;
      disposables.forEach((d) => d.dispose());
    };
  }, [engineRef, items, selectedId, badIds, warnIds]);

  // 바닥 평면 드래그
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const el = engine.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    let drag: Drag | null = null;

    const floorPointAt = (e: PointerEvent) => {
      raycaster.setFromCamera(pointerToNdc(e, el), engine.camera);
      return rayFloorPoint(raycaster.ray.origin, raycaster.ray.direction);
    };

    const onDown = (e: PointerEvent) => {
      const group = groupRef.current;
      if (e.button !== 0 || !group) return;
      raycaster.setFromCamera(pointerToNdc(e, el), engine.camera);
      const hit = raycaster.intersectObjects(group.children, false)[0];
      if (!hit) return; // 가구가 아니면 화면 돌리기로 넘긴다
      const item = itemsRef.current.find((i) => i.id === hit.object.userData.id);
      if (!item) return;

      // OrbitControls가 이 포인터를 보지 못하게 해서, 가구를 끄는 동안 화면이 돌지 않게 한다
      e.stopImmediatePropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const floor = rayFloorPoint(raycaster.ray.origin, raycaster.ray.direction) ?? [item.x, item.z];
      drag = {
        id: item.id,
        pointerId: e.pointerId,
        offset: [item.x - floor[0], item.z - floor[1]], // 잡은 위치를 유지
        current: item,
      };
      setSelectedId(item.id);
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const floor = floorPointAt(e);
      if (!floor) return;
      drag.current = placeOnFloor(
        { ...drag.current, x: floor[0] + drag.offset[0], z: floor[1] + drag.offset[1] },
        floorPolygon,
      );
      // 끄는 동안에는 메시만 옮기고, 손을 뗄 때 상태에 반영한다
      const mesh = groupRef.current?.children.find((m) => m.userData.id === drag?.id);
      if (mesh) {
        mesh.position.x = drag.current.x;
        mesh.position.z = drag.current.z;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const { id, current } = drag;
      drag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, x: current.x, z: current.z } : i)));
    };

    // capture 단계에 걸어 OrbitControls의 리스너보다 먼저 실행되게 한다
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [engineRef, floorPolygon]);

  const add = (entry: CatalogItem) => {
    if (itemsRef.current.length >= MAX_LAYOUT_ITEMS) return;
    const id = `f${nextItemNumber(itemsRef.current)}`;
    // 방 가운데부터 찾아, 다른 가구와 겹치지 않고 문 앞도 아닌 가장 가까운 빈자리에 놓는다
    const doorZones = openings.flatMap((o) => (o.type === 'door' ? [doorZone(o, floorPolygon)] : [])).filter((zone) => zone !== null);
    const placed = findFreeSpot(entry, [...itemsRef.current, ...doorZones], floorPolygon);
    setItems((prev) => [...prev, placeCatalogItem(entry, id, placed)]);
    setSelectedId(id);
  };

  const rotate = () => {
    setItems((prev) =>
      prev.map((i) =>
        i.id === selectedId
          ? { ...i, ...placeOnFloor({ ...i, rotationDeg: (i.rotationDeg + 90) % 360 }, floorPolygon) }
          : i,
      ),
    );
  };

  const remove = () => {
    setItems((prev) => prev.filter((i) => i.id !== selectedId));
    setSelectedId(null);
  };

  const save = async () => {
    if (!onSave || savePhase === 'saving') return;
    const snapshot = currentSaved;
    setSavePhase('saving');
    const ok = await onSave(snapshot);
    if (ok) setSavedItems(snapshot);
    setSavePhase(ok ? 'idle' : 'error');
  };

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <>
      {showPlan && (
        <div className="absolute inset-0 bg-neutral-900/95" data-testid="plan-overlay">
          <div className="absolute inset-x-2 bottom-16 top-2 sm:right-[17.5rem]">
            <FloorPlan
              floorPolygon={floorPolygon}
              items={items}
              openings={openings}
              badIds={badIds}
              warnIds={warnIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={(id, x, z) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, x, z } : i)))}
            />
          </div>
        </div>
      )}
      <div
        className="absolute right-2 top-2 max-h-[calc(100%-4.5rem)] w-64 max-w-[calc(100%-1rem)] space-y-2 overflow-y-auto rounded bg-black/75 p-3 text-xs text-white"
        data-testid="furniture-panel"
        data-json={JSON.stringify(
          items.map(({ id, kind, furnitureRef, name, x, z, w, d, h, rotationDeg }) => ({ id, kind, furnitureRef, name, x, z, w, d, h, rotationDeg })),
        )}
        data-violations={JSON.stringify(violations)}
      >
        <div className="flex items-center justify-between">
          <strong>가구 배치</strong>
          <button className="rounded bg-white/20 px-2 py-0.5" onClick={() => setShowPlan((prev) => !prev)} data-testid="plan-toggle" aria-pressed={showPlan}>
            {showPlan ? '3D로 보기' : '평면도'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {catalog.map((entry) => (
            <button key={entry.id} className="rounded bg-white/20 px-2 py-1 disabled:opacity-40" disabled={full} onClick={() => add(entry)}>
              + {entry.nameKo}
            </button>
          ))}
        </div>
        {selected ? (
          <div className="space-y-1">
            <div className="font-mono">
              <div>{selected.name}</div>
              <div>
                {(selected.w * 100).toFixed(0)} × {(selected.d * 100).toFixed(0)} × {(selected.h * 100).toFixed(0)} cm
              </div>
              <div>
                위치 x {selected.x.toFixed(2)}, z {selected.z.toFixed(2)} · {selected.rotationDeg}°
              </div>
            </div>
            <div className="flex gap-1">
              <button className="rounded bg-white/20 px-2 py-1" onClick={rotate}>
                90° 회전
              </button>
              <button className="rounded bg-white/20 px-2 py-1" onClick={remove}>
                삭제
              </button>
            </div>
          </div>
        ) : (
          <p className="opacity-80">가구를 추가한 뒤 끌어서 옮기세요. 평면도에서도 끌 수 있습니다. 5cm 단위로 움직이고 벽 가까이에서는 벽에 붙습니다.</p>
        )}
        {items.length > 0 && (
          <div data-testid="layout-violations" data-count={violations.length} data-errors={errorCount} data-warnings={violations.length - errorCount}>
            {violations.length === 0 ? (
              <p className="text-emerald-300">배치에 문제가 없습니다.</p>
            ) : (
              <ul className="space-y-0.5">
                {violations.map((v) => (
                  <li key={`${v.itemId}|${v.type}|${v.otherId ?? ''}`} className={v.severity === 'error' ? 'text-red-300' : 'text-amber-300'} data-type={v.type}>
                    {v.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {items.length > 0 && !hasDoor && (
          <p className="opacity-80" data-testid="layout-door-hint">
            문을 넣으면 문 앞과 통로(60cm)도 검사합니다.
          </p>
        )}
        {full && <p className="opacity-80">가구는 {MAX_LAYOUT_ITEMS}개까지 놓을 수 있습니다.</p>}
        {restored.missing > 0 && (
          <p className="text-amber-300" data-testid="layout-missing">
            저장된 가구 {restored.missing}개는 목록에서 사라져 불러오지 못했습니다.
          </p>
        )}
        {onSave && (items.length > 0 || savedItems.length > 0) && (
          <div className="flex items-center justify-between gap-2 border-t border-white/20 pt-2">
            <span data-testid="layout-save-state" data-state={saveState}>
              {saveState === 'saved' && '배치 저장됨'}
              {saveState === 'dirty' && '저장 안 됨'}
              {saveState === 'saving' && '저장하는 중…'}
              {saveState === 'error' && '저장하지 못했습니다'}
            </span>
            {saveState !== 'saved' && (
              <button
                className="rounded bg-emerald-600 px-2 py-1 disabled:opacity-50"
                data-testid="layout-save"
                disabled={saveState === 'saving'}
                onClick={save}
              >
                {saveState === 'error' ? '다시 저장' : '배치 저장'}
              </button>
            )}
          </div>
        )}
        {!onSave && loginHint && items.length > 0 && (
          <p className="border-t border-white/20 pt-2 opacity-80" data-testid="layout-login-hint">
            <a className="underline" href="/account">
              로그인
            </a>
            하면 배치를 저장할 수 있습니다. 지금은 새로고침하면 사라집니다.
          </p>
        )}
      </div>
    </>
  );
}
