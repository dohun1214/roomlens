'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEFAULT_CATALOG, type CatalogItem } from '@/lib/layout/catalog';
import { doorZone } from '@/lib/layout/access';
import { checkLayout, findFreeSpot, violatingIds, warningIds } from '@/lib/layout/check';
import {
  MAX_USER_FURNITURE,
  parseUserFurnitureForm,
  USER_FURNITURE_NAME_MAX,
  type UserFurnitureForm,
  type UserFurnitureValue,
} from '@/lib/layout/userFurniture';
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
import { disposeModelTemplate, instantiateModel, makeModelTemplate, type ModelTemplate } from '@/lib/three/furnitureModel';
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
const NO_FURNITURE: CatalogItem[] = [];
const EMPTY_MINE_FORM: UserFurnitureForm = { name: '', width: '', depth: '', height: '' };

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
  userFurniture = NO_FURNITURE,
  onCreateFurniture,
  onDeleteFurniture,
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
  /** 내가 만들어 둔 가구. 처음 한 번만 읽는다 */
  userFurniture?: CatalogItem[];
  /** 내 가구를 만든다 (주면 "내 가구" 칸이 생긴다). 실패하면 null */
  onCreateFurniture?: (value: UserFurnitureValue) => Promise<CatalogItem | null>;
  /** 내 가구를 지운다. 지웠으면 true */
  onDeleteFurniture?: (id: string) => Promise<boolean>;
  /** 저장된 배치. 처음 한 번만 읽는다 */
  initialItems?: SavedItem[];
  /** 배치를 저장한다. 성공하면 true */
  onSave?: (items: SavedItem[]) => Promise<boolean>;
  /** 로그인하면 저장할 수 있다는 안내를 보여줄지 */
  loginHint?: boolean;
}) {
  const [restored] = useState(() => restoreItems(initialItems ?? [], catalog, userFurniture));
  const [mine, setMine] = useState<CatalogItem[]>(userFurniture);
  const [mineFormOpen, setMineFormOpen] = useState(false);
  const [mineForm, setMineForm] = useState<UserFurnitureForm>(EMPTY_MINE_FORM);
  const [mineMessage, setMineMessage] = useState<string | null>(null);
  const [mineBusy, setMineBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>(restored.items);
  // 마지막으로 저장한 배치 (지금 배치와 다르면 "저장 안 됨")
  const [savedItems, setSavedItems] = useState<SavedItem[]>(() => toSavedItems(restored.items));
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'error'>('idle');
  // 3D 위에 2D 평면도를 덮어 보여줄지
  const [showPlan, setShowPlan] = useState(false);
  // 가구 목록을 접어 패널을 작게 (좁은 화면에서 평면도를 가리지 않게)
  const [compact, setCompact] = useState(false);
  // 불러온 3D 모델 틀 (주소 → 틀, 받는 중이거나 실패했으면 null). 다 받으면 modelVersion을 올려 다시 그린다
  const [modelCache] = useState(() => new Map<string, ModelTemplate | null>());
  const [modelVersion, setModelVersion] = useState(0);
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

  // 가구 3D 모델 불러오기: 놓인 가구가 쓰는 모델을 한 번씩만 받아 틀로 만들어 둔다.
  // 받는 동안과 받지 못했을 때는 상자로 보인다
  useEffect(() => {
    for (const item of items) {
      const url = item.modelUrl;
      if (!url || modelCache.has(url)) continue;
      modelCache.set(url, null);
      new GLTFLoader().load(
        url,
        (gltf) => {
          const template = makeModelTemplate(gltf.scene);
          if (!template) return;
          modelCache.set(url, template);
          setModelVersion((v) => v + 1);
        },
        undefined,
        () => {}, // 실패하면 상자로 둔다
      );
    }
  }, [items, modelCache]);

  useEffect(
    () => () => {
      for (const template of modelCache.values()) if (template) disposeModelTemplate(template);
    },
    [modelCache],
  );

  // 가구 메시 만들기
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];

    for (const item of items) {
      const bad = badIds.has(item.id);
      const warn = warnIds.has(item.id);
      const template = item.modelUrl ? modelCache.get(item.modelUrl) : null;
      const geometry = new THREE.BoxGeometry(item.w, item.h, item.d);
      // 3D 모델이 있으면 상자는 잡기·표시용이다: 평소에는 보이지 않고, 문제·경고일 때만 반투명하게 덧씌운다
      const material = template
        ? new THREE.MeshLambertMaterial({
            color: bad ? VIOLATION_EDGE_COLOR : WARNING_EDGE_COLOR,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            visible: bad || warn,
          })
        : new THREE.MeshLambertMaterial({ color: item.color, emissive: bad ? VIOLATION_EMISSIVE : warn ? WARNING_EMISSIVE : 0x000000 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, item.h / 2, item.z);
      mesh.rotation.y = THREE.MathUtils.degToRad(item.rotationDeg);
      mesh.userData.id = item.id;

      const edgeGeometry = new THREE.EdgesGeometry(geometry);
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: bad ? VIOLATION_EDGE_COLOR : warn ? WARNING_EDGE_COLOR : item.id === selectedId ? SELECTED_EDGE_COLOR : EDGE_COLOR,
      });
      const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      // 모델이 있으면 외곽선은 고른 가구와 문제 있는 가구에만
      edges.visible = !template || bad || warn || item.id === selectedId;
      mesh.add(edges);
      if (template) {
        // 상자의 중심이 원점이므로 모델(바닥 가운데가 원점)은 높이의 절반만큼 내린다
        const model = instantiateModel(template, item.w, item.h, item.d);
        model.position.y = -item.h / 2;
        mesh.add(model);
      }
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
  }, [engineRef, items, selectedId, badIds, warnIds, modelCache, modelVersion]);

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

  const createMine = async () => {
    if (!onCreateFurniture || mineBusy) return;
    const parsed = parseUserFurnitureForm(mineForm);
    if (!parsed.ok) {
      setMineMessage(parsed.message);
      return;
    }
    setMineBusy(true);
    const created = await onCreateFurniture(parsed.value);
    setMineBusy(false);
    if (!created) {
      setMineMessage('만들지 못했습니다. 잠시 뒤에 다시 해 주세요.');
      return;
    }
    setMine((prev) => [...prev, created]);
    setMineForm(EMPTY_MINE_FORM);
    setMineFormOpen(false);
    setMineMessage(null);
  };

  const deleteMine = async (id: string) => {
    if (!onDeleteFurniture || mineBusy) return;
    setMineBusy(true);
    const ok = await onDeleteFurniture(id);
    setMineBusy(false);
    setConfirmDeleteId(null);
    if (!ok) {
      setMineMessage('지우지 못했습니다. 잠시 뒤에 다시 해 주세요.');
      return;
    }
    setMine((prev) => prev.filter((f) => f.id !== id));
    // 방에 놓여 있던 그 가구도 함께 치운다
    setItems((prev) => prev.filter((i) => !(i.kind === 'user' && i.furnitureRef === id)));
    setMineMessage(null);
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
          items.map(({ id, kind, furnitureRef, name, x, z, w, d, h, rotationDeg, modelUrl }) => ({
            id,
            kind,
            furnitureRef,
            name,
            x,
            z,
            w,
            d,
            h,
            rotationDeg,
            // 3D 모델로 그려지고 있는지 (없거나 아직 받는 중이면 상자)
            model: Boolean(modelUrl && modelCache.get(modelUrl)),
          })),
        )}
        data-violations={JSON.stringify(violations)}
      >
        <div className="flex items-center justify-between gap-1">
          <strong className="mr-auto">가구 배치</strong>
          <button className="rounded bg-white/20 px-2 py-0.5" onClick={() => setShowPlan((prev) => !prev)} data-testid="plan-toggle" aria-pressed={showPlan}>
            {showPlan ? '3D로 보기' : '평면도'}
          </button>
          <button className="rounded bg-white/20 px-2 py-0.5" onClick={() => setCompact((prev) => !prev)} data-testid="panel-compact" aria-pressed={compact}>
            {compact ? '펼치기' : '접기'}
          </button>
        </div>
        <div className={compact ? 'hidden' : 'flex flex-wrap gap-1'} data-testid="furniture-catalog">
          {catalog.map((entry) => (
            <button key={entry.id} className="rounded bg-white/20 px-2 py-1 disabled:opacity-40" disabled={full} onClick={() => add(entry)}>
              + {entry.nameKo}
            </button>
          ))}
        </div>
        {onCreateFurniture && (
          <div className={compact ? 'hidden' : 'space-y-1 border-t border-white/20 pt-2'} data-testid="user-furniture">
            <div className="flex items-center justify-between">
              <span className="opacity-80">내 가구</span>
              {!mineFormOpen && mine.length < MAX_USER_FURNITURE && (
                <button className="rounded bg-white/20 px-2 py-0.5" onClick={() => setMineFormOpen(true)} data-testid="user-furniture-open">
                  직접 만들기
                </button>
              )}
            </div>
            {mine.length > 0 && (
              <div className="flex flex-wrap gap-1" data-testid="user-furniture-list">
                {mine.map((entry) => (
                  <span key={entry.id} className="inline-flex overflow-hidden rounded bg-white/20">
                    <button className="px-2 py-1 disabled:opacity-40" disabled={full} onClick={() => add(entry)} title={`${Math.round(entry.w * 100)} × ${Math.round(entry.d * 100)} × ${Math.round(entry.h * 100)} cm`}>
                      + {entry.nameKo}
                    </button>
                    <button className="border-l border-white/20 px-1.5 py-1" onClick={() => setConfirmDeleteId(entry.id)} aria-label={`${entry.nameKo} 지우기`}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {confirmDeleteId && (
              <div className="flex flex-wrap items-center gap-1 text-amber-300" data-testid="user-furniture-confirm">
                <span>&ldquo;{mine.find((f) => f.id === confirmDeleteId)?.nameKo}&rdquo;을(를) 지울까요? 방에 놓인 것도 사라집니다.</span>
                <button className="rounded bg-red-600 px-2 py-0.5 text-white disabled:opacity-50" disabled={mineBusy} onClick={() => deleteMine(confirmDeleteId)} data-testid="user-furniture-confirm-yes">
                  지우기
                </button>
                <button className="rounded bg-white/20 px-2 py-0.5 text-white" onClick={() => setConfirmDeleteId(null)}>
                  취소
                </button>
              </div>
            )}
            {mineFormOpen && (
              <div className="space-y-1" data-testid="user-furniture-form">
                <input
                  className="w-full rounded bg-white/10 px-2 py-1"
                  placeholder="이름 (예: 수납장)"
                  maxLength={USER_FURNITURE_NAME_MAX}
                  value={mineForm.name}
                  onChange={(e) => setMineForm({ ...mineForm, name: e.target.value })}
                  data-testid="user-furniture-name"
                />
                <div className="flex items-center gap-1">
                  {(['width', 'depth', 'height'] as const).map((key) => (
                    <input
                      key={key}
                      className="w-0 flex-1 rounded bg-white/10 px-2 py-1"
                      inputMode="decimal"
                      placeholder={{ width: '가로', depth: '깊이', height: '높이' }[key]}
                      aria-label={{ width: '가로 (cm)', depth: '깊이 (cm)', height: '높이 (cm)' }[key]}
                      value={mineForm[key]}
                      onChange={(e) => setMineForm({ ...mineForm, [key]: e.target.value })}
                      data-testid={`user-furniture-${key}`}
                    />
                  ))}
                  <span>cm</span>
                </div>
                <div className="flex gap-1">
                  <button className="rounded bg-emerald-600 px-2 py-1 disabled:opacity-50" disabled={mineBusy} onClick={createMine} data-testid="user-furniture-create">
                    만들기
                  </button>
                  <button
                    className="rounded bg-white/20 px-2 py-1"
                    onClick={() => {
                      setMineFormOpen(false);
                      setMineMessage(null);
                    }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
            {mineMessage && (
              <p className="text-amber-300" data-testid="user-furniture-message">
                {mineMessage}
              </p>
            )}
          </div>
        )}
        {!onCreateFurniture && loginHint && (
          <p className={compact ? 'hidden' : 'opacity-80'} data-testid="user-furniture-login-hint">
            로그인하면 치수를 넣어 내 가구를 만들 수 있습니다.
          </p>
        )}
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
          <p className={compact ? 'hidden' : 'opacity-80'}>가구를 추가한 뒤 끌어서 옮기세요. 평면도에서도 끌 수 있습니다. 5cm 단위로 움직이고 벽 가까이에서는 벽에 붙습니다.</p>
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
