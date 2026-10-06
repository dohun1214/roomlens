'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEFAULT_CATALOG, type CatalogItem } from '@/lib/layout/catalog';
import { doorZone } from '@/lib/layout/access';
import { blocksAccess } from '@/lib/layout/accessSide';
import type { AiResultView } from '@/lib/ai/suggestClient';
import { MAX_SUGGEST_ITEMS } from '@/lib/ai/layoutSuggest';
import { MAX_REQUEST_LENGTH } from '@/lib/ai/roomSummary';
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
import FurnitureGlyph from '@/components/ui/FurnitureGlyph';
import Icon from '@/components/ui/Icon';
import { AiBadge, PanelBody, PanelFooter, PanelTitle, SaveStatePill, SectionTitle, StageLayer, ToolPanel, type Slots } from '@/components/viewer/workspace';
import { furnitureTone, sizeLabel } from '@/lib/layout/furnitureLook';
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
const NO_LAYOUTS: LayoutChoice[] = [];
const NO_KEYS: string[] = [];

/** 배치를 고르는 칸에 보여줄 것 */
export type LayoutChoice = { id: string; name: string; createdBy: 'user' | 'ai' };
const EMPTY_MINE_FORM: UserFurnitureForm = { name: '', width: '', depth: '', height: '' };

type Drag = { id: string; pointerId: number; offset: Point2; current: Footprint };

/**
 * 보정된 방(바닥 y=0, 단위 m) 위에 박스 가구를 놓고 바닥 평면에서 끈다.
 * 가구는 roomGroup이 아니라 scene에 직접 넣는다 (방 좌표 = 월드 좌표).
 * 겹치거나 방 밖으로 나갔거나 문 앞·통로를 막는 가구는 빨갛게, 창문을 가리는 가구는 노랗게 표시하고 이유를 알려준다.
 * onSave가 있으면 저장 버튼을 보여주고, initialItems(저장된 배치)로 시작한다.
 * 배치를 바꾸거나(내 배치 ↔ AI 배치) 새로 추천받으면 부모가 key를 바꿔 이 층을 새로 만든다.
 */
export default function FurnitureLayer({
  slots,
  showPlan,
  onShowPlan,
  engineRef,
  floorPolygon,
  catalog = DEFAULT_CATALOG,
  openings = NO_OPENINGS,
  aiOpeningKeys = NO_KEYS,
  userFurniture = NO_FURNITURE,
  onCreateFurniture,
  onDeleteFurniture,
  initialItems,
  onSave,
  loginHint = false,
  layouts = NO_LAYOUTS,
  currentLayoutId = null,
  onSelectLayout,
  onDeleteLayout,
  onSuggest,
  aiRemaining = null,
  aiBlocked = null,
  aiResult = null,
  aiSummary = null,
}: {
  /** 패널과 3D 화면 위에 그려 넣을 자리 */
  slots: Slots;
  /** 3D 위에 평면도를 덮어 보여줄지 (뷰어가 기억한다: 배치를 바꿔도 그대로) */
  showPlan: boolean;
  onShowPlan: (show: boolean) => void;
  engineRef: RefObject<Engine | null>;
  floorPolygon: Point2[];
  /** 놓을 수 있는 가구 목록. 방 화면은 DB의 카탈로그를 넘긴다 */
  catalog?: CatalogItem[];
  /** 방의 문·창문. 문 앞·통로·창문 가림 검사에 쓴다 */
  openings?: Opening[];
  /** 그 가운데 AI가 찾아 아직 확인하지 않은 것 (평면도에서 점선으로 그린다) */
  aiOpeningKeys?: string[];
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
  /** 이 방의 내 배치들 (내 배치, AI 배치). 둘 이상이면 고르는 칸이 생긴다 */
  layouts?: LayoutChoice[];
  /** 지금 보고 있는 배치. null이면 아직 저장하지 않은 새 배치 */
  currentLayoutId?: string | null;
  onSelectLayout?: (id: string | null) => void;
  /** 배치를 지운다. 지웠으면 true */
  onDeleteLayout?: (id: string) => Promise<boolean>;
  /** AI 배치 추천을 받는다 (주면 "AI 추천" 칸이 생긴다). 성공하면 부모가 새 AI 배치로 바꾼다 */
  onSuggest?: (items: SavedItem[], request: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** 오늘 남은 AI 횟수 (모르면 null) */
  aiRemaining?: number | null;
  /** AI 추천을 지금 쓸 수 없는 이유 (예: 보정을 저장하지 않음) */
  aiBlocked?: string | null;
  /** 방금 받은 추천의 결과 (지금 보고 있는 배치의 것일 때만) */
  aiResult?: AiResultView | null;
  /** 저장된 AI 배치에 붙어 있는 글 (전체 의도와 가구별 이유) */
  aiSummary?: string | null;
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
  // 불러온 3D 모델 틀 (주소 → 틀, 받는 중이거나 실패했으면 null). 다 받으면 modelVersion을 올려 다시 그린다
  const [modelCache] = useState(() => new Map<string, ModelTemplate | null>());
  const [modelVersion, setModelVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // AI 추천: 요청 글 입력칸을 펼쳤는지, 요청 글, 진행 상태, 실패 이유
  const [aiOpen, setAiOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [confirmLayoutDelete, setConfirmLayoutDelete] = useState(false);
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
    // 방 가운데부터 찾아, 다른 가구와 겹치지 않고 문 앞도 아닌 가장 가까운 빈자리에 놓는다.
    // 되도록 가구의 쓰는 쪽(책상·수납의 앞 등)이 서로 막히지 않는 자리를 고른다
    const others = itemsRef.current;
    const doorZones = openings.flatMap((o) => (o.type === 'door' ? [doorZone(o, floorPolygon)] : [])).filter((zone) => zone !== null);
    const placed = findFreeSpot(entry, [...others, ...doorZones], floorPolygon, (spot) => !blocksAccess({ ...spot, id, category: entry.category, clearance: entry.clearance }, others, floorPolygon));
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

  const save = async (): Promise<boolean> => {
    if (!onSave || savePhase === 'saving') return false;
    const snapshot = currentSaved;
    setSavePhase('saving');
    const ok = await onSave(snapshot);
    if (ok) setSavedItems(snapshot);
    setSavePhase(ok ? 'idle' : 'error');
    return ok;
  };

  /** 다른 배치로 바꾸기 전에, 저장하지 않은 것이 있으면 먼저 저장한다 (잃지 않게) */
  const saveIfDirty = async (): Promise<boolean> => !dirty || !onSave || (await save());

  const selectLayout = async (id: string | null) => {
    if (!onSelectLayout || layoutBusy || id === currentLayoutId) return;
    setLayoutBusy(true);
    const ok = await saveIfDirty();
    setLayoutBusy(false);
    if (ok) onSelectLayout(id);
  };

  const deleteLayout = async () => {
    if (!onDeleteLayout || !currentLayoutId || layoutBusy) return;
    setLayoutBusy(true);
    await onDeleteLayout(currentLayoutId);
    setLayoutBusy(false);
    setConfirmLayoutDelete(false);
  };

  const suggest = async () => {
    if (!onSuggest || aiBusy) return;
    setAiBusy(true);
    setAiMessage(null);
    if (!(await saveIfDirty())) {
      setAiBusy(false);
      setAiMessage('지금 배치를 저장하지 못해 추천을 시작하지 않았습니다. 다시 해 주세요.');
      return;
    }
    const result = await onSuggest(currentSaved, aiRequest);
    // 성공하면 부모가 새 AI 배치로 바꾸면서 이 층을 새로 만든다
    setAiBusy(false);
    if (!result.ok) setAiMessage(result.message);
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
  const currentLayout = layouts.find((l) => l.id === currentLayoutId) ?? null;
  const hasOwnLayout = layouts.some((l) => l.createdBy === 'user');
  const aiHint =
    aiBlocked ??
    (items.length === 0 ? '가구를 먼저 놓으면 AI가 다시 배치해 줍니다.' : items.length > MAX_SUGGEST_ITEMS ? `가구가 ${MAX_SUGGEST_ITEMS}개를 넘으면 추천받을 수 없습니다.` : aiRemaining === 0 ? '오늘 쓸 수 있는 AI 횟수를 모두 썼습니다. 내일 다시 해 주세요.' : null);

  const dims = (w: number, d: number, h: number) => `${Math.round(w * 100)} × ${Math.round(d * 100)} × ${Math.round(h * 100)} cm`;
  const stateOf = (id: string) => (badIds.has(id) ? 'error' : warnIds.has(id) ? 'warning' : 'ok');
  const showSave = Boolean(onSave) && (items.length > 0 || savedItems.length > 0);
  const hasChooser = Boolean(onSelectLayout) && layouts.length > 0;
  const fieldClass = 'field h-10 rounded-[10px] px-3 text-sm';

  return (
    <>
      <StageLayer slots={slots}>
        {showPlan && (
          <div className="absolute inset-0 bg-surface" data-testid="plan-overlay">
            <div className="absolute inset-x-3 top-[68px] bottom-40 sm:bottom-32 lg:inset-x-6 lg:bottom-[120px]">
              <FloorPlan
                floorPolygon={floorPolygon}
                items={items}
                openings={openings}
                aiOpeningKeys={aiOpeningKeys}
                badIds={badIds}
                warnIds={warnIds}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={(id, x, z) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, x, z } : i)))}
              />
            </div>
          </div>
        )}

        {/* 3D ↔ 평면도 */}
        <button
          type="button"
          role="switch"
          aria-checked={showPlan}
          aria-label="평면도로 보기"
          className="absolute top-3 left-3 flex rounded-xl bg-surface p-1 text-[13px] shadow-float"
          onClick={() => onShowPlan(!showPlan)}
          data-testid="plan-toggle"
        >
          <span className={`flex h-9 items-center rounded-[9px] px-4 ${showPlan ? 'font-medium text-sub' : 'bg-ink font-semibold text-white'}`}>3D</span>
          <span className={`flex h-9 items-center rounded-[9px] px-4 ${showPlan ? 'bg-ink font-semibold text-white' : 'font-medium text-sub'}`}>평면도</span>
        </button>

        {/* 고른 가구: 이름·치수, 회전, 삭제 */}
        {selected && (
          <div
            className="absolute bottom-24 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 sm:bottom-16 lg:bottom-14 items-center gap-2.5 rounded-[14px] bg-surface py-1.5 pr-1.5 pl-2.5 whitespace-nowrap shadow-float sm:gap-3"
            data-testid="selection-bar"
            data-id={selected.id}
          >
            <FurnitureGlyph furnitureRef={selected.furnitureRef} category={selected.category} size={34} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-bold">{selected.name}</span>
              <span className="font-mono text-[11px] text-mute" title={`위치 x ${selected.x.toFixed(2)}, z ${selected.z.toFixed(2)} · ${selected.rotationDeg}°`}>
                {dims(selected.w, selected.d, selected.h)}
              </span>
            </span>
            <span className="h-7 w-px bg-line" aria-hidden="true" />
            <button className="btn btn-soft h-11 px-3.5 text-[13px]" onClick={rotate}>
              <Icon name="rotate" />
              90° 회전
            </button>
            <button className="btn btn-danger h-11 px-3.5 text-[13px]" onClick={remove}>
              삭제
            </button>
          </div>
        )}
      </StageLayer>

      <ToolPanel
        slots={slots}
        tool="furniture"
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
        <PanelBody>
          <div className="flex flex-col gap-3">
            <PanelTitle
              right={
                showSave && (
                  <SaveStatePill
                    state={saveState}
                    testId="layout-save-state"
                    labels={{ saved: '배치 저장됨', dirty: '저장 안 됨', saving: '저장하는 중…', error: '저장하지 못했습니다' }}
                  />
                )
              }
            >
              가구 배치
            </PanelTitle>

            {(hasChooser || (showSave && saveState !== 'saved')) && (
              <div className="flex flex-col gap-2" data-testid={hasChooser ? 'layout-chooser' : undefined} data-current={hasChooser ? (currentLayoutId ?? '') : undefined} data-count={hasChooser ? layouts.length : undefined}>
                <div className="flex gap-2">
                  {hasChooser && (
                    <div className="relative min-w-0 flex-1">
                      {currentLayout?.createdBy === 'ai' && <AiBadge className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />}
                      <select
                        className={`h-11 w-full appearance-none rounded-[10px] border border-line-strong bg-surface pr-9 text-sm font-medium disabled:opacity-50 ${currentLayout?.createdBy === 'ai' ? 'pl-11' : 'pl-3.5'}`}
                        aria-label="배치 고르기"
                        data-testid="layout-select"
                        disabled={layoutBusy || aiBusy}
                        value={currentLayoutId ?? ''}
                        onChange={(e) => selectLayout(e.target.value === '' ? null : e.target.value)}
                      >
                        {/* 직접 만든 배치가 아직 없으면 새로 시작할 수 있게 빈 배치를 둔다 */}
                        {(!hasOwnLayout || currentLayoutId === null) && <option value="">내 배치 (새로 만들기)</option>}
                        {layouts.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevronDown" className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sub" />
                    </div>
                  )}
                  {showSave && saveState !== 'saved' && (
                    <button className="btn btn-primary h-11 px-4 text-[13px]" data-testid="layout-save" disabled={saveState === 'saving'} onClick={() => void save()}>
                      {saveState === 'error' ? '다시 저장' : '배치 저장'}
                    </button>
                  )}
                  {hasChooser && onDeleteLayout && currentLayout && !confirmLayoutDelete && (
                    <button className="btn btn-soft h-11 px-3.5 text-[13px]" disabled={layoutBusy || aiBusy} onClick={() => setConfirmLayoutDelete(true)} data-testid="layout-delete">
                      지우기
                    </button>
                  )}
                </div>
                {confirmLayoutDelete && currentLayout && (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn" data-testid="layout-delete-confirm">
                    <span className="mr-auto">&ldquo;{currentLayout.name}&rdquo;을(를) 지울까요?</span>
                    <button className="btn btn-danger h-9 bg-danger px-3 text-white hover:bg-[#8f231b]" disabled={layoutBusy} onClick={deleteLayout} data-testid="layout-delete-yes">
                      지우기
                    </button>
                    <button className="btn btn-outline h-9 px-3" onClick={() => setConfirmLayoutDelete(false)}>
                      취소
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {aiResult ? (
            <div className="flex flex-col gap-3" data-testid="ai-result" data-layout-id={aiResult.layoutId}>
              <SectionTitle
                right={
                  aiResult.failures.length === 0 && aiResult.unmet.length === 0 ? (
                    <span className="pill bg-ok-soft font-medium text-ok">모두 놓음 · 검사 통과</span>
                  ) : (
                    <span className="pill bg-warn-soft font-medium text-warn">확인할 것 {aiResult.failures.length + aiResult.unmet.length}</span>
                  )
                }
              >
                AI 추천 결과
              </SectionTitle>
              {aiResult.summary && (
                <p className="rounded-[14px_14px_14px_4px] bg-accent-soft p-3.5 text-sm text-pretty text-[#1a2140]" data-testid="ai-result-summary">
                  {aiResult.summary}
                </p>
              )}
              {aiResult.reasons.length > 0 && (
                <ul className="flex flex-col gap-3" data-testid="ai-result-reasons">
                  {aiResult.reasons.map((r) => {
                    const item = items.find((i) => i.id === r.itemId);
                    return (
                      <li key={r.itemId} className="flex gap-3">
                        <FurnitureGlyph furnitureRef={item?.furnitureRef ?? ''} category={item?.category ?? ''} />
                        <span className="flex min-w-0 flex-col gap-px">
                          <button className="self-start text-left font-bold underline decoration-line-strong decoration-dotted underline-offset-4" onClick={() => setSelectedId(r.itemId)}>
                            {r.name}
                          </button>
                          <span className="text-[13px] text-body">{r.reason}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {aiResult.failures.length > 0 && (
                <ul className="flex flex-col gap-1.5 text-[13px]" data-testid="ai-result-failures">
                  {aiResult.failures.map((f) => (
                    <li key={f.itemId} className="rounded-[10px] bg-danger-tint px-3 py-2 text-danger">
                      놓지 못함 — {f.message}
                    </li>
                  ))}
                </ul>
              )}
              {aiResult.unmet.length > 0 && (
                <ul className="flex flex-col gap-1.5 text-[13px]" data-testid="ai-result-unmet">
                  {aiResult.unmet.map((u, index) => (
                    <li key={`${u.itemId}|${index}`} className="rounded-[10px] bg-warn-tint px-3 py-2 text-warn">
                      {u.message}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-sub">가구를 끌어서 고칠 수 있습니다. AI의 추천은 참고용입니다.</p>
            </div>
          ) : (
            aiSummary && (
              <div className="flex flex-col gap-2.5" data-testid="ai-saved-summary">
                <SectionTitle>AI가 추천한 배치</SectionTitle>
                <p className="rounded-[14px_14px_14px_4px] bg-accent-soft p-3.5 text-[13px] whitespace-pre-line text-[#1a2140]">{aiSummary}</p>
              </div>
            )
          )}

          <div className="flex flex-col gap-2.5">
            <SectionTitle right={<span className="font-mono text-[11px] text-mute">가로 × 깊이 cm</span>}>가구 추가</SectionTitle>
            <div className="grid grid-cols-2 gap-2" data-testid="furniture-catalog">
              {catalog.map((entry) => (
                <button
                  key={entry.id}
                  className="flex h-[52px] items-center gap-2.5 rounded-xl border border-line bg-surface px-2 text-left hover:border-line-strong hover:bg-accent-tint disabled:opacity-40"
                  disabled={full}
                  onClick={() => add(entry)}
                  aria-label={`+ ${entry.nameKo}`}
                  title={dims(entry.w, entry.d, entry.h)}
                >
                  <FurnitureGlyph furnitureRef={entry.id} category={entry.category} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold">{entry.nameKo}</span>
                    <span className="font-mono text-[11px] text-mute">{sizeLabel(entry.w, entry.d)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {onCreateFurniture && (
            <div className="flex flex-col gap-2.5" data-testid="user-furniture">
              <SectionTitle>내 가구</SectionTitle>
              {mine.length > 0 && (
                <div className="grid grid-cols-2 gap-2" data-testid="user-furniture-list">
                  {mine.map((entry) => (
                    <span key={entry.id} className="flex h-[52px] items-stretch overflow-hidden rounded-xl border border-line bg-surface">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 text-left hover:bg-accent-tint disabled:opacity-40"
                        disabled={full}
                        onClick={() => add(entry)}
                        aria-label={`+ ${entry.nameKo}`}
                        title={dims(entry.w, entry.d, entry.h)}
                      >
                        <FurnitureGlyph furnitureRef={entry.id} category={entry.category} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] font-semibold">{entry.nameKo}</span>
                          <span className="font-mono text-[11px] text-mute">{sizeLabel(entry.w, entry.d)}</span>
                        </span>
                      </button>
                      <button className="flex w-8 shrink-0 items-center justify-center border-l border-line text-mute hover:bg-danger-soft hover:text-danger" onClick={() => setConfirmDeleteId(entry.id)} aria-label={`${entry.nameKo} 지우기`}>
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {confirmDeleteId && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn" data-testid="user-furniture-confirm">
                  <span className="w-full">&ldquo;{mine.find((f) => f.id === confirmDeleteId)?.nameKo}&rdquo;을(를) 지울까요? 방에 놓인 것도 사라집니다.</span>
                  <button className="btn btn-danger h-9 bg-danger px-3 text-white hover:bg-[#8f231b]" disabled={mineBusy} onClick={() => deleteMine(confirmDeleteId)} data-testid="user-furniture-confirm-yes">
                    지우기
                  </button>
                  <button className="btn btn-outline h-9 px-3" onClick={() => setConfirmDeleteId(null)}>
                    취소
                  </button>
                </div>
              )}
              {mineFormOpen ? (
                <div className="flex flex-col gap-2 rounded-xl bg-ground p-3" data-testid="user-furniture-form">
                  <input
                    className={fieldClass}
                    placeholder="이름 (예: 수납장)"
                    aria-label="내 가구 이름"
                    maxLength={USER_FURNITURE_NAME_MAX}
                    value={mineForm.name}
                    onChange={(e) => setMineForm({ ...mineForm, name: e.target.value })}
                    data-testid="user-furniture-name"
                  />
                  <div className="flex items-center gap-1.5">
                    {(['width', 'depth', 'height'] as const).map((key) => (
                      <input
                        key={key}
                        className={`${fieldClass} w-0 flex-1 px-2.5`}
                        inputMode="decimal"
                        placeholder={{ width: '가로', depth: '깊이', height: '높이' }[key]}
                        aria-label={{ width: '가로 (cm)', depth: '깊이 (cm)', height: '높이 (cm)' }[key]}
                        value={mineForm[key]}
                        onChange={(e) => setMineForm({ ...mineForm, [key]: e.target.value })}
                        data-testid={`user-furniture-${key}`}
                      />
                    ))}
                    <span className="font-mono text-xs text-sub">cm</span>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn btn-primary h-10 flex-1 text-[13px]" disabled={mineBusy} onClick={createMine} data-testid="user-furniture-create">
                      만들기
                    </button>
                    <button
                      className="btn btn-outline h-10 px-4 text-[13px]"
                      onClick={() => {
                        setMineFormOpen(false);
                        setMineMessage(null);
                      }}
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                mine.length < MAX_USER_FURNITURE && (
                  <button className="flex h-[42px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-field text-[13px] font-medium text-sub hover:bg-soft" onClick={() => setMineFormOpen(true)} data-testid="user-furniture-open">
                    <Icon name="plus" />
                    직접 만들기 (이름·치수)
                  </button>
                )
              )}
              {mineMessage && (
                <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="user-furniture-message">
                  {mineMessage}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <SectionTitle
              right={
                items.length > 0 &&
                violations.length > 0 && (
                  <span className="flex gap-1.5">
                    {errorCount > 0 && <span className="pill bg-danger-soft font-medium text-danger">문제 {errorCount}</span>}
                    {violations.length - errorCount > 0 && <span className="pill bg-warn-soft font-medium text-warn">경고 {violations.length - errorCount}</span>}
                  </span>
                )
              }
            >
              놓인 가구 <span className="font-mono font-medium text-mute">{items.length}</span>
            </SectionTitle>
            {items.length === 0 ? (
              <p className="text-[13px] text-sub">가구를 추가한 뒤 끌어서 옮기세요. 평면도에서도 끌 수 있습니다. 5cm 단위로 움직이고 벽 가까이에서는 벽에 붙습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="placed-list">
                {items.map((item) => {
                  const state = stateOf(item.id);
                  const on = item.id === selectedId;
                  return (
                    <li key={item.id}>
                      <button
                        className={`flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left ${on ? 'bg-accent-soft' : 'hover:bg-soft'}`}
                        onClick={() => setSelectedId(on ? null : item.id)}
                        aria-pressed={on}
                        data-id={item.id}
                        data-state={state}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: furnitureTone(item.category).dot }} aria-hidden="true" />
                        <span className={`min-w-0 flex-1 truncate ${on ? 'font-semibold' : ''}`}>{item.name}</span>
                        {state === 'error' && <span className="text-xs font-medium text-danger">문제</span>}
                        {state === 'warning' && <span className="text-xs font-medium text-warn">경고</span>}
                        {state === 'ok' && on && <span className="text-xs font-medium text-accent-strong">선택됨</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {items.length > 0 && (
              <div data-testid="layout-violations" data-count={violations.length} data-errors={errorCount} data-warnings={violations.length - errorCount}>
                {violations.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-[10px] bg-ok-soft px-3 py-2 text-[13px] text-ok">
                    <Icon name="check" />
                    배치에 문제가 없습니다.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-[13px]">
                    {violations.map((v) => (
                      <li
                        key={`${v.itemId}|${v.type}|${v.otherId ?? ''}`}
                        className={`rounded-[10px] px-3 py-2 ${v.severity === 'error' ? 'bg-danger-tint text-danger' : 'bg-warn-tint text-warn'}`}
                        data-type={v.type}
                        data-severity={v.severity}
                      >
                        {v.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {items.length > 0 && !hasDoor && (
              <p className="text-xs text-sub" data-testid="layout-door-hint">
                문을 넣으면 문 앞과 통로(60cm)도 검사합니다.
              </p>
            )}
            {full && <p className="text-xs text-sub">가구는 {MAX_LAYOUT_ITEMS}개까지 놓을 수 있습니다.</p>}
            {restored.missing > 0 && (
              <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="layout-missing">
                저장된 가구 {restored.missing}개는 목록에서 사라져 불러오지 못했습니다.
              </p>
            )}
          </div>

          {loginHint && (
            <div className="flex flex-col gap-1.5 rounded-xl bg-ground p-3.5 text-[13px] text-body">
              {!onCreateFurniture && <p data-testid="user-furniture-login-hint">로그인하면 치수를 넣어 내 가구를 만들 수 있습니다.</p>}
              {!onSuggest && <p data-testid="ai-login-hint">로그인하면 AI에게 가구 배치를 추천받을 수 있습니다.</p>}
              {!onSave && items.length > 0 && (
                <p data-testid="layout-login-hint">
                  <a className="font-semibold text-accent underline" href="/account">
                    로그인
                  </a>
                  하면 배치를 저장할 수 있습니다. 지금은 새로고침하면 사라집니다.
                </p>
              )}
            </div>
          )}
        </PanelBody>

        {onSuggest && (
          <PanelFooter tone="accent" data-testid="ai-suggest" data-remaining={aiRemaining ?? ''} data-busy={aiBusy}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-bold text-accent-deep">
                <AiBadge />
                AI 배치 추천
              </span>
              {aiRemaining !== null && <span className="text-xs text-accent-strong">오늘 {aiRemaining}회 남음</span>}
            </div>
            {aiHint && (
              <p className="text-[13px] text-[#1a2140]" data-testid="ai-hint">
                {aiHint}
              </p>
            )}
            {aiOpen && !aiHint ? (
              <div className="flex flex-col gap-2" data-testid="ai-form">
                <textarea
                  className="field h-[68px] resize-none rounded-[10px] border-accent-line px-3 py-2 text-sm"
                  placeholder="바라는 점이 있으면 적어 주세요 (예: 책상은 창가에). 비워 두어도 됩니다"
                  aria-label="바라는 점"
                  maxLength={MAX_REQUEST_LENGTH}
                  value={aiRequest}
                  disabled={aiBusy}
                  onChange={(e) => setAiRequest(e.target.value)}
                  data-testid="ai-request"
                />
                <p className="text-xs text-[#1a2140]">지금 놓인 가구 {items.length}개를 AI가 다시 배치합니다. 결과는 &ldquo;AI 배치&rdquo;로 따로 저장되고, 지금 배치는 그대로 남습니다.</p>
                <div className="flex gap-2">
                  <button className="btn btn-primary h-11 flex-1 text-sm" disabled={aiBusy} onClick={suggest} data-testid="ai-run">
                    {aiBusy ? 'AI가 배치하는 중… (5~30초)' : '추천받기'}
                  </button>
                  {!aiBusy && (
                    <button className="btn h-11 bg-surface px-4 text-sm hover:bg-soft" onClick={() => setAiOpen(false)}>
                      닫기
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button className="btn btn-primary h-11 text-sm" disabled={aiHint !== null} onClick={() => setAiOpen(true)} data-testid="ai-open">
                AI 추천
              </button>
            )}
            {aiMessage && (
              <p className="rounded-[10px] bg-surface px-3 py-2 text-[13px] text-danger" data-testid="ai-message">
                {aiMessage}
              </p>
            )}
          </PanelFooter>
        )}
      </ToolPanel>
    </>
  );
}
