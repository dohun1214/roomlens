'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { SplatMesh, type PackedSplats } from '@sparkjsdev/spark';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { catalogLabel, catalogThumbnail, DEFAULT_CATALOG, modelCredits, type CatalogItem } from '@/lib/layout/catalog';
import { doorZone } from '@/lib/layout/access';
import { blocksAccess } from '@/lib/layout/accessSide';
import type { AiResultView } from '@/lib/ai/suggestClient';
import { MAX_SUGGEST_ITEMS } from '@/lib/ai/layoutSuggest';
import { MAX_REQUEST_LENGTH } from '@/lib/ai/roomSummary';
import { checkLayout, findFreeSpot, violatingIds, warningIds } from '@/lib/layout/check';
import { lastInsideAlong } from '@/lib/layout/geometry';
import { emptyHistory, historyShortcut, record, redo, undo, type History } from '@/lib/layout/history';
import { angleDelta, normalizeRotation, parseRotationInput, ROTATE_STEP, rotationTowards, snapRotation } from '@/lib/layout/rotation';
import { isTypingTarget } from '@/lib/three/keyboardMove';
import {
  MAX_USER_FURNITURE,
  parseUserFurnitureForm,
  USER_FURNITURE_NAME_MAX,
  type UserFurnitureForm,
  type UserFurnitureValue,
} from '@/lib/layout/userFurniture';
import type { Opening } from '@/lib/rooms/openings';
import { fixtureObstacles, type Fixture } from '@/lib/rooms/fixtures';
import { fillPlanes, hiddenBox, type FixturePieceUrls } from '@/lib/rooms/fixturePiece';
import { uploadFixturePiece } from '@/lib/rooms/fixturePieceClient';
import { extractFixturePiece, hideFixtureEdit, loadSourceSplats, setHiddenFixtures } from '@/lib/three/fixturePiece';
import { buildFillPiece, captureFillPlanes, requestFill } from '@/lib/three/fixtureFill';
import {
  MAX_LAYOUT_ITEMS,
  movedFixtureIds,
  nextItemNumber,
  placeCatalogItem,
  placeFixtureItem,
  restoreItems,
  sameSavedItems,
  toSavedItems,
  type PlacedItem,
  type SavedItem,
} from '@/lib/layout/saved';
import { placeOnFloor, rayFloorPoint, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { disposeModelTemplate, instantiateModel, makeModelTemplate, type ModelTemplate } from '@/lib/three/furnitureModel';
import { pointerToNdc } from '@/lib/three/pickPoint';
import { flyTo, furnitureViewpoint } from '@/lib/three/focusView';
import { makeShadowTexture, shadowSize } from '@/lib/three/softShadow';
import type { Engine } from '@/components/viewer/engine';
import FurnitureGlyph from '@/components/ui/FurnitureGlyph';
import FurnitureThumb from '@/components/ui/FurnitureThumb';
import Icon from '@/components/ui/Icon';
import { AiBadge, PanelBody, PanelFooter, PanelTitle, SaveStatePill, SectionTitle, StageLayer, ToolPanel, type Slots } from '@/components/viewer/workspace';
import { furnitureTone, sizeLabel } from '@/lib/layout/furnitureLook';
import ScanFurnitureForm from './ScanFurnitureForm';
import FloorPlan from './FloorPlan';
import LayoutShareBox from './LayoutShareBox';

type Item = PlacedItem;

const EDGE_COLOR = 0xffffff;
const SELECTED_EDGE_COLOR = 0xffe14d;
const VIOLATION_EDGE_COLOR = 0xff3b30;
const VIOLATION_EMISSIVE = 0x7a1010;
const WARNING_EDGE_COLOR = 0xffc233;
const WARNING_EMISSIVE = 0x4a3800;
/** 가구 밑 그림자의 진하기와 바닥에서 띄우는 높이 (m, 바닥과 겹쳐 깜빡이지 않게) */
const SHADOW_OPACITY = 0.45;
const SHADOW_LIFT = 0.004;
const NO_OPENINGS: Opening[] = [];
const NO_FIXTURES: Fixture[] = [];
const NO_FURNITURE: CatalogItem[] = [];
const NO_LAYOUTS: LayoutChoice[] = [];
const NO_KEYS: string[] = [];
const NO_PIECES: FixturePieceUrls = {};

/** 배치를 고르는 칸에 보여줄 것 */
export type LayoutChoice = { id: string; name: string; createdBy: 'user' | 'ai'; isPublic?: boolean };
const EMPTY_MINE_FORM: UserFurnitureForm = { name: '', width: '', depth: '', height: '' };

type Drag = {
  id: string;
  pointerId: number;
  offset: Point2;
  current: Footprint;
  /** Shift+끌기로 돌리는 중이면: 잡을 때 포인터 방향과 가구 각도 */
  rotate: { startPointer: number; startDeg: number } | null;
};

/**
 * 보정된 방(바닥 y=0, 단위 m) 위에 박스 가구를 놓고 바닥 평면에서 끈다.
 * 가구는 roomGroup이 아니라 scene에 직접 넣는다 (방 좌표 = 월드 좌표).
 * 겹치거나 방 밖으로 나갔거나 문 앞·통로를 막는 가구는 빨갛게, 창문을 가리는 가구는 노랗게 표시하고 이유를 알려준다.
 * onSave가 있으면 저장 버튼을 보여주고, initialItems(저장된 배치)로 시작한다.
 * 배치를 바꾸거나(내 배치 ↔ AI 배치) 새로 추천받으면 부모가 key를 바꿔 이 층을 새로 만든다.
 */
/** 방 좌표의 한 점이 지금 3D 화면 안(가장자리 10% 제외)에 보이는지 */
function inView(engine: Engine, x: number, y: number, z: number): boolean {
  const p = new THREE.Vector3(x, y, z).project(engine.camera);
  return p.z > -1 && p.z < 1 && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9;
}

export default function FurnitureLayer({
  slots,
  showPlan,
  onShowPlan,
  engineRef,
  floorPolygon,
  catalog = DEFAULT_CATALOG,
  openings = NO_OPENINGS,
  aiOpeningKeys = NO_KEYS,
  fixtures = NO_FIXTURES,
  onDrawFixture,
  userFurniture = NO_FURNITURE,
  onCreateFurniture,
  onDeleteFurniture,
  onCreateScanFurniture,
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
  borrowedFurniture = NO_FURNITURE,
  sharedFrom = null,
  sharedMissing = false,
  share,
  onUnsavedChange,
  aiPrefill = null,
  pieceUrls = NO_PIECES,
  prepare,
  onMovedFixtures,
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
  /** 방에 원래 있는 가구. 새 가구는 피해서 놓고, 겹치면 문제로 알린다 ("치울 가구"는 없는 것으로 본다) */
  fixtures?: Fixture[];
  /** 평면도에서 원래 가구 사각형을 그리는 중이면 그린 두 모서리를 받는다 */
  onDrawFixture?: (a: Point2, b: Point2) => void;
  /** 내가 만들어 둔 가구. 처음 한 번만 읽는다 */
  userFurniture?: CatalogItem[];
  /** 내 가구를 만든다 (주면 "내 가구" 칸이 생긴다). 실패하면 null */
  onCreateFurniture?: (value: UserFurnitureValue) => Promise<CatalogItem | null>;
  /** 내 가구를 지운다. 지웠으면 true */
  onDeleteFurniture?: (id: string) => Promise<boolean>;
  /** 3D 스캔(다듬은 GLB)으로 내 가구를 만든다 */
  onCreateScanFurniture?: (glb: Blob, value: UserFurnitureValue) => Promise<{ ok: true; item: CatalogItem } | { ok: false; message: string }>;
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
  /** 남이 공유한 배치에 쓰인 그 사람의 가구 (그리기만 하고 "내 가구"에는 넣지 않는다) */
  borrowedFurniture?: CatalogItem[];
  /** 남이 공유한 배치를 보고 있으면 그 사람과 배치 이름. 저장하면 내 배치가 된다 */
  sharedFrom?: { ownerName: string; layoutName: string } | null;
  /** 공유 링크로 왔지만 그 배치를 볼 수 없을 때 (비공개로 바뀌었거나 지워졌음) */
  sharedMissing?: boolean;
  /** 지금 배치를 링크로 공유하기 (주면 저장된 내 배치에 "공유" 버튼이 생긴다) */
  share?: { roomId: string; roomPublic: boolean; onSetPublic: (layoutId: string, next: boolean) => Promise<boolean> };
  /** 저장할 수 있는데 저장하지 않은 배치가 있는지 알려 준다 (나갈 때 묻기). 공유받은 배치를 둘러보는 것은 빼고 */
  onUnsavedChange?: (unsaved: boolean) => void;
  /** 방 분석에서 넘어온 AI 추천 요청 글. nonce가 바뀔 때마다 요청 칸을 열고 글을 넣는다 */
  aiPrefill?: { text: string; nonce: number } | null;
  /** 옮길 수 있게 떼어 낸 원래 가구 조각의 읽기 주소 (원래 가구 id → 주소) */
  pieceUrls?: FixturePieceUrls;
  /** 로그인했으면: 아직 떼어 내지 않은 원래 가구를 원할 때 이 자리에서 떼어 내 올린다 (방 3D 파일 주소) */
  prepare?: {
    roomId: string;
    sourceUrl: string;
    /** 방 주인이면 이미 떼어 냈거나 채운 것도 다시 할 수 있다 (다른 사람은 처음 한 번만) */
    isOwner: boolean;
    /** 떼어 낸 조각이나 채운 빈자리를 올렸을 때 (서버가 적은 원래 가구와 새 읽기 주소) */
    onPrepared: (fixture: Fixture, urls: { piece?: string; fill?: string }) => void;
    /** 빈자리 채우기로 AI를 쓴 뒤 남은 횟수 */
    onAiRemaining?: (remaining: number) => void;
  };
  /** 이 배치에서 옮긴 원래 가구 id가 바뀔 때 (원래 가구 도구가 원래 자리의 상자를 그리지 않게) */
  onMovedFixtures?: (ids: string[]) => void;
}) {
  const [restored] = useState(() =>
    restoreItems(
      initialItems ?? [],
      catalog,
      [...userFurniture, ...borrowedFurniture],
      fixtures,
      Object.fromEntries(Object.entries(pieceUrls).flatMap(([id, urls]) => (urls.piece ? [[id, urls.piece]] : []))),
    ),
  );
  const [mine, setMine] = useState<CatalogItem[]>(userFurniture);
  const [mineFormOpen, setMineFormOpen] = useState(false);
  const [mineForm, setMineForm] = useState<UserFurnitureForm>(EMPTY_MINE_FORM);
  const [scanOpen, setScanOpen] = useState(false);
  const [mineMessage, setMineMessage] = useState<string | null>(null);
  const [mineBusy, setMineBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>(restored.items);
  // 마지막으로 저장한 배치 (지금 배치와 다르면 "저장 안 됨")
  // 남이 공유한 배치는 아직 내 것이 아니므로 "저장 안 됨"으로 시작한다
  const [savedItems, setSavedItems] = useState<SavedItem[]>(() => (sharedFrom ? [] : toSavedItems(restored.items)));
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
  const aiFormRef = useRef<HTMLDivElement>(null);
  const [prefillNonce, setPrefillNonce] = useState(0);
  if (aiPrefill && aiPrefill.nonce !== prefillNonce) {
    // 넘어온 요청 글을 칸에 넣는다 (그리는 중에 상태를 맞추는 React 방식)
    setPrefillNonce(aiPrefill.nonce);
    setAiRequest(aiPrefill.text.slice(0, MAX_REQUEST_LENGTH));
    setAiOpen(true);
    setAiMessage(null);
  }
  // 넘어온 요청 칸이 보이게 하고 글을 고칠 수 있게 초점을 준다
  useEffect(() => {
    if (prefillNonce === 0) return;
    const form = aiFormRef.current;
    form?.scrollIntoView({ block: 'nearest' });
    form?.querySelector('textarea')?.focus();
  }, [prefillNonce]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [confirmLayoutDelete, setConfirmLayoutDelete] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // 끌거나 돌리는 중인 가구의 지금 자리 (손을 떼기 전). 이것으로 바로 검사해 보여 준다
  const [live, setLive] = useState<{ id: string; pose: Footprint } | null>(null);
  const [angleText, setAngleText] = useState<string | null>(null);
  const itemsRef = useRef<Item[]>(restored.items);
  // 단축키(R)가 쓰는 지금 고른 가구와 돌리기 함수
  const selectedRef = useRef<string | null>(null);
  const rotateToRef = useRef<(id: string, deg: number) => void>(() => {});
  const groupRef = useRef<THREE.Group | null>(null);
  // 되돌리기·다시하기 기록 (화면에는 단계 수만 쓴다)
  const [history, setHistory] = useState<History<Item[]>>(emptyHistory);
  const historyRef = useRef(history);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /** 배치를 바꾼다. 바뀌기 전 배치를 되돌리기 기록에 남긴다 (실제로 달라진 것이 없으면 남기지 않는다) */
  const commit = useCallback((change: (prev: Item[]) => Item[]) => {
    const prev = itemsRef.current;
    const next = change(prev);
    if (next === prev || (next.length === prev.length && sameSavedItems(toSavedItems(next), toSavedItems(prev)))) return;
    itemsRef.current = next;
    historyRef.current = record(historyRef.current, prev);
    setHistory(historyRef.current);
    setItems(next);
  }, []);

  /** 되돌리기·다시하기 */
  const step = useCallback((kind: 'undo' | 'redo') => {
    const out = (kind === 'undo' ? undo : redo)(historyRef.current, itemsRef.current);
    if (!out) return;
    itemsRef.current = out.value;
    historyRef.current = out.history;
    setHistory(out.history);
    setItems(out.value);
  }, []);

  // 단축키: 가구 도구를 쓰는 중이고 입력 칸에 글을 쓰고 있지 않을 때
  const furnitureActive = slots.active === 'furniture';
  useEffect(() => {
    if (!furnitureActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      // R: 고른 가구를 오른쪽으로 15°, Shift+R: 왼쪽으로 (한글 입력 상태에서도 되게 code로 본다)
      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey && selectedRef.current) {
        e.preventDefault();
        const item = itemsRef.current.find((i) => i.id === selectedRef.current);
        if (item) rotateToRef.current(item.id, item.rotationDeg + (e.shiftKey ? -ROTATE_STEP : ROTATE_STEP));
        return;
      }
      const kind = historyShortcut(e);
      if (!kind) return;
      e.preventDefault();
      step(kind);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [furnitureActive, step]);

  // 이 배치에서 옮긴 원래 가구: 원래 자리는 비고, 옮긴 자리는 배치의 가구로 검사한다
  const movedKey = useMemo(() => [...movedFixtureIds(items)].sort().join(','), [items]);
  const movedIds = useMemo(() => new Set(movedKey ? movedKey.split(',') : []), [movedKey]);
  const obstacles = useMemo(() => fixtureObstacles(fixtures, movedIds), [fixtures, movedIds]);
  useEffect(() => {
    onMovedFixtures?.(movedKey ? movedKey.split(',') : []);
  }, [movedKey, onMovedFixtures]);
  useEffect(() => () => onMovedFixtures?.([]), [onMovedFixtures]);
  const violations = useMemo(() => checkLayout(items, floorPolygon, openings, obstacles), [items, floorPolygon, openings, obstacles]);
  const badIds = useMemo(() => violatingIds(violations), [violations]);
  const warnIds = useMemo(() => warningIds(violations), [violations]);
  // 끄는 동안의 검사: 끄는 가구만 지금 자리로 바꿔 다시 검사한다
  const liveViolations = useMemo(() => {
    if (!live) return null;
    const moved = items.map((i) => (i.id === live.id ? { ...i, ...live.pose } : i));
    return checkLayout(moved, floorPolygon, openings, obstacles);
  }, [live, items, floorPolygon, openings, obstacles]);
  const shownBadIds = useMemo(() => (liveViolations ? violatingIds(liveViolations) : badIds), [liveViolations, badIds]);
  const shownWarnIds = useMemo(() => (liveViolations ? warningIds(liveViolations) : warnIds), [liveViolations, warnIds]);
  const liveMessages = live && liveViolations ? liveViolations.filter((v) => v.itemId === live.id || v.otherId === live.id) : null;
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const hasDoor = openings.some((o) => o.type === 'door');
  const currentSaved = useMemo(() => toSavedItems(items), [items]);
  const dirty = !sameSavedItems(currentSaved, savedItems);
  const unsaved = dirty && Boolean(onSave) && !sharedFrom;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  // 가구 층이 바뀌거나 사라지면(다른 배치로 바꿈) 알림을 거둔다
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);
  const saveState = savePhase === 'saving' ? 'saving' : !dirty ? 'saved' : savePhase === 'error' ? 'error' : 'dirty';
  const full = items.length >= MAX_LAYOUT_ITEMS;
  const credits = useMemo(() => modelCredits(catalog), [catalog]);

  // 가구 음영용 조명 (스플랫에는 영향을 주지 않는다).
  // 실사 모델(PBR 재질)도 이 두 빛만으로 맞췄다: 실내 환경 맵을 더하면 흰 가구가 하얗게 날아가 스플랫 방보다 튄다
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

  // 가구 밑의 부드러운 그림자 그림 (가구마다 함께 쓴다)
  const shadowTexture = useMemo(() => makeShadowTexture(), []);
  useEffect(() => () => shadowTexture.dispose(), [shadowTexture]);

  // 가구 3D 모델 불러오기: 놓인 가구가 쓰는 모델을 한 번씩만 받아 틀로 만들어 둔다.
  // 받는 동안과 받지 못했을 때는 상자로 보인다
  useEffect(() => {
    for (const item of items) {
      const url = item.modelUrl;
      if (!url || modelCache.has(url)) continue;
      modelCache.set(url, null);
      new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
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

  // 옮긴 원래 가구의 3D 조각 (주소 → 스플랫 메시). 가구 상자를 다시 만들 때마다 새 상자에 옮겨 단다
  const [pieceMeshes] = useState(() => new Map<string, SplatMesh>());
  useEffect(
    () => () => {
      for (const mesh of pieceMeshes.values()) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      // 개발 모드에서는 효과를 한 번 걷었다가 다시 붙이므로, 버린 메시를 다시 쓰지 않게 비운다
      pieceMeshes.clear();
    },
    [pieceMeshes],
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
      // 옮긴 원래 가구: 떼어 낸 스캔 조각을 그린다 (방 화면의 원래 자리는 숨긴다)
      const pieceUrl = item.kind === 'fixture' ? pieceUrls[item.furnitureRef]?.piece : undefined;
      let piece = pieceUrl ? pieceMeshes.get(pieceUrl) : undefined;
      if (pieceUrl && !piece) {
        piece = new SplatMesh({ url: pieceUrl, editable: false });
        pieceMeshes.set(pieceUrl, piece);
      }
      const visual = Boolean(template || piece);
      const geometry = new THREE.BoxGeometry(item.w, item.h, item.d);
      // 3D 모델·스캔 조각이 있으면 상자는 잡기·표시용이다: 평소에는 보이지 않고, 문제·경고일 때만 반투명하게 덧씌운다
      const material = visual
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
      edges.userData.edges = true;
      // 모델이 있으면 외곽선은 고른 가구와 문제 있는 가구에만
      edges.visible = !visual || bad || warn || item.id === selectedId;
      mesh.add(edges);
      if (piece) {
        // 조각은 원래 가구 가운데·바닥이 원점이다 (상자 중심은 높이의 절반 위)
        piece.position.set(0, -item.h / 2, 0);
        piece.rotation.set(0, 0, 0);
        mesh.add(piece);
      }
      if (template) {
        // 상자의 중심이 원점이므로 모델(바닥 가운데가 원점)은 높이의 절반만큼 내린다
        const model = instantiateModel(template, item.w, item.h, item.d);
        model.position.y = -item.h / 2;
        mesh.add(model);
      }
      if (visual) {
        // 바닥에 닿은 느낌이 나도록 밑에 그림자를 깐다 (바닥보다 살짝 위, 가구와 함께 돈다)
        const shadowGeometry = new THREE.PlaneGeometry(...shadowSize(item.w, item.d));
        const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, color: 0x000000, transparent: true, opacity: SHADOW_OPACITY, depthWrite: false });
        const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = -item.h / 2 + SHADOW_LIFT;
        shadow.renderOrder = -1;
        mesh.add(shadow);
        disposables.push(shadowGeometry, shadowMaterial);
      }
      group.add(mesh);
      disposables.push(geometry, material, edgeGeometry, edgeMaterial);
    }
    engine.scene.add(group);
    groupRef.current = group;
    return () => {
      // 조각은 다음에 다시 쓰므로 떼어 내기만 한다
      for (const mesh of pieceMeshes.values()) mesh.removeFromParent();
      engine.scene.remove(group);
      groupRef.current = null;
      disposables.forEach((d) => d.dispose());
    };
  }, [engineRef, items, selectedId, badIds, warnIds, modelCache, modelVersion, shadowTexture, pieceUrls, pieceMeshes]);

  // 옮긴 원래 가구의 원래 자리는 방 스플랫에서 숨긴다 (조각이 있는 것만)
  useEffect(() => {
    const splat = engineRef.current?.splat;
    if (!splat) return;
    const moved = fixtures.filter((f) => movedIds.has(f.id) && f.piece && pieceUrls[f.id]?.piece);
    const edit = hideFixtureEdit(
      moved.map((fixture) => ({ fixture, filled: Boolean(fixture.fill && pieceUrls[fixture.id]?.fill) })),
      floorPolygon,
    );
    setHiddenFixtures(splat, edit);
    return () => setHiddenFixtures(splat, null);
  }, [engineRef, fixtures, movedIds, pieceUrls, floorPolygon]);

  // 옮긴 원래 가구의 빈자리를 채운 조각: 원래 자리(원래 가구 좌표)에 그린다
  const [fillMeshes] = useState(() => new Map<string, SplatMesh>());
  useEffect(
    () => () => {
      for (const mesh of fillMeshes.values()) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      fillMeshes.clear();
    },
    [fillMeshes],
  );
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const group = new THREE.Group();
    for (const f of fixtures) {
      const url = movedIds.has(f.id) && f.fill ? pieceUrls[f.id]?.fill : undefined;
      if (!url) continue;
      let mesh = fillMeshes.get(url);
      if (!mesh) {
        mesh = new SplatMesh({ url, editable: false });
        fillMeshes.set(url, mesh);
      }
      mesh.position.set(f.x, 0, f.z);
      mesh.rotation.set(0, THREE.MathUtils.degToRad(f.rotationDeg), 0);
      group.add(mesh);
    }
    engine.scene.add(group);
    return () => {
      for (const mesh of fillMeshes.values()) mesh.removeFromParent();
      engine.scene.remove(group);
    };
  }, [engineRef, fixtures, movedIds, pieceUrls, fillMeshes]);

  // 끄는 동안: 메시를 다시 만들지 않고 끄는 가구의 테두리 색만 바꾼다 (문제 빨강, 경고 노랑, 괜찮으면 고른 색)
  useEffect(() => {
    if (!live) return;
    const mesh = groupRef.current?.children.find((m) => m.userData.id === live.id);
    const edges = mesh?.children.find((c) => c.userData.edges) as THREE.LineSegments | undefined;
    if (!edges) return;
    const material = edges.material as THREE.LineBasicMaterial;
    const color = shownBadIds.has(live.id) ? VIOLATION_EDGE_COLOR : shownWarnIds.has(live.id) ? WARNING_EDGE_COLOR : SELECTED_EDGE_COLOR;
    material.color.setHex(color);
    edges.visible = true;
  }, [live, shownBadIds, shownWarnIds]);

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
        // Shift를 누르고 끌면 그 자리에서 돌린다 (처음 각도에서 끈 만큼)
        rotate: e.shiftKey ? { startPointer: rotationTowards(floor[0] - item.x, floor[1] - item.z), startDeg: item.rotationDeg } : null,
      };
      setSelectedId(item.id);
    };

    // 화면 갱신마다 한 번만 검사 상태를 바꾼다
    let frame = 0;
    const showLive = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (drag) setLive({ id: drag.id, pose: { x: drag.current.x, z: drag.current.z, w: drag.current.w, d: drag.current.d, rotationDeg: drag.current.rotationDeg } });
      });
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const floor = floorPointAt(e);
      if (!floor) return;
      if (drag.rotate) {
        const pointer = rotationTowards(floor[0] - drag.current.x, floor[1] - drag.current.z);
        const deg = snapRotation(drag.rotate.startDeg + angleDelta(pointer, drag.rotate.startPointer));
        drag.current = placeOnFloor({ ...drag.current, rotationDeg: deg }, floorPolygon);
      } else {
        drag.current = placeOnFloor(
          { ...drag.current, x: floor[0] + drag.offset[0], z: floor[1] + drag.offset[1] },
          floorPolygon,
        );
      }
      // 끄는 동안에는 메시만 옮기고, 손을 뗄 때 상태에 반영한다
      const mesh = groupRef.current?.children.find((m) => m.userData.id === drag?.id);
      if (mesh) {
        mesh.position.x = drag.current.x;
        mesh.position.z = drag.current.z;
        mesh.rotation.y = THREE.MathUtils.degToRad(drag.current.rotationDeg);
      }
      showLive();
    };

    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const { id, current } = drag;
      drag = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setLive(null);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      commit((prev) => prev.map((i) => (i.id === id ? { ...i, x: current.x, z: current.z, rotationDeg: current.rotationDeg } : i)));
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
      if (frame) cancelAnimationFrame(frame);
    };
  }, [engineRef, floorPolygon, commit]);

  /** 가구 테두리를 잠깐 깜빡여 어디 있는지 알린다 (메시를 다시 만들지 않고 테두리만 켜고 끈다) */
  const blink = (id: string) => {
    let count = 0;
    const timer = window.setInterval(() => {
      const mesh = groupRef.current?.children.find((m) => m.userData.id === id);
      const edges = mesh?.children.find((c) => c.userData.edges) as THREE.LineSegments | undefined;
      count += 1;
      if (edges) edges.visible = count % 2 === 1 || count >= 6;
      if (count >= 6) window.clearInterval(timer);
    }, 160);
  };

  /** 가구로 시점 옮기기: 고르고, 평면도를 보고 있었으면 3D로 돌아가 그 가구를 내려다보는 자리로 날아간다 */
  const focusOn = (item: Pick<Item, 'id' | 'x' | 'z' | 'w' | 'd' | 'h'>) => {
    const engine = engineRef.current;
    setSelectedId(item.id);
    if (!engine) return;
    if (showPlan) onShowPlan(false);
    const view = furnitureViewpoint(item, floorPolygon, [engine.camera.position.x, engine.camera.position.z]);
    void flyTo(engine, view).then(() => blink(item.id));
  };

  const add = (entry: CatalogItem) => {
    if (itemsRef.current.length >= MAX_LAYOUT_ITEMS) return;
    const id = `f${nextItemNumber(itemsRef.current)}`;
    // 방 가운데부터 찾아, 다른 가구와 겹치지 않고 문 앞도 아닌 가장 가까운 빈자리에 놓는다.
    // 되도록 가구의 쓰는 쪽(책상·수납의 앞 등)이 서로 막히지 않는 자리를 고른다
    const others = itemsRef.current;
    const doorZones = openings.flatMap((o) => (o.type === 'door' ? [doorZone(o, floorPolygon)] : [])).filter((zone) => zone !== null);
    // 방에 원래 있는 가구 자리도 피한다
    const avoid = [...others, ...obstacles, ...doorZones];
    const prefer = (spot: Footprint) => !blocksAccess({ ...spot, id, category: entry.category, clearance: entry.clearance }, [...others, ...obstacles], floorPolygon);
    let placed = findFreeSpot(entry, avoid, floorPolygon, prefer);
    // 3D로 보는 중인데 그 자리가 화면 밖이면(창문을 가까이 보고 있을 때 등) 추가된 줄 모른다 → 화면 가운데 바닥부터 찾는다
    const engine = engineRef.current;
    if (engine && !showPlan && !inView(engine, placed.x, entry.h / 2, placed.z)) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, 0), engine.camera);
      const eye: Point2 = [engine.camera.position.x, engine.camera.position.z];
      // 화면 가운데 광선이 바닥에 닿는 곳(바닥을 안 보면 2m 앞). 벽 너머면 벽 바로 앞까지 당긴다
      const ahead = rayFloorPoint(ray.ray.origin, ray.ray.direction) ?? [eye[0] + ray.ray.direction.x * 2, eye[1] + ray.ray.direction.z * 2];
      const start = floorPolygon ? lastInsideAlong(eye, ahead, floorPolygon) : ahead;
      if (start) placed = findFreeSpot(entry, avoid, floorPolygon, prefer, start);
    }
    const item = placeCatalogItem(entry, id, placed);
    commit((prev) => [...prev, item]);
    setSelectedId(id);
    // 그래도 화면 밖이면(방 밖을 보고 있었거나 빈자리가 멀 때) 그 가구로 시점을 옮긴다
    if (engine && !showPlan && !inView(engine, item.x, item.h / 2, item.z)) focusOn(item);
  };

  /** 고른 가구를 deg로 돌린다 (벽에 붙어 있었으면 다시 붙인다) */
  const rotateTo = useCallback(
    (id: string, deg: number) => {
      commit((prev) => prev.map((i) => (i.id === id ? { ...i, ...placeOnFloor({ ...i, rotationDeg: normalizeRotation(deg) }, floorPolygon) } : i)));
    },
    [commit, floorPolygon],
  );
  useEffect(() => {
    rotateToRef.current = rotateTo;
    selectedRef.current = selectedId;
  }, [rotateTo, selectedId]);
  const rotateBy = (delta: number) => {
    const item = itemsRef.current.find((i) => i.id === selectedId);
    if (item) rotateTo(item.id, item.rotationDeg + delta);
  };
  const rotate = () => rotateBy(90);

  const remove = () => {
    commit((prev) => prev.filter((i) => i.id !== selectedId));
    setSelectedId(null);
  };

  // 원래 가구 옮기기: 처음에는 원래 자리에 놓고 고른 상태로 둔다 (끌어서 옮긴다). 지우면 제자리로 돌아간다
  const moveFixture = (f: Fixture) => {
    if (itemsRef.current.length >= MAX_LAYOUT_ITEMS || itemsRef.current.some((i) => i.kind === 'fixture' && i.furnitureRef === f.id)) return;
    const id = `f${nextItemNumber(itemsRef.current)}`;
    commit((prev) => [...prev, placeFixtureItem(f, id, { x: f.x, z: f.z, rotationDeg: f.rotationDeg })]);
    setSelectedId(id);
  };
  const returnFixture = (f: Fixture) => {
    commit((prev) => prev.filter((i) => !(i.kind === 'fixture' && i.furnitureRef === f.id)));
    setSelectedId(null);
  };
  // 방 주인: 아직 떼어 내지 않은 원래 가구는 방 3D 파일을 LOD 없이 한 번 더 읽어 떼어 낸 뒤 올리고 옮긴다
  const sourceRef = useRef<PackedSplats | null>(null);
  useEffect(
    () => () => {
      sourceRef.current?.dispose();
      sourceRef.current = null;
    },
    [],
  );
  const [prepBusy, setPrepBusy] = useState<{ id: string; text: string } | null>(null);
  const [prepMessage, setPrepMessage] = useState<string | null>(null);
  // 방 주인: 옮긴 원래 가구의 빈자리를 AI로 채운다 (바닥·벽 그림 → AI → 납작한 스플랫 조각을 올린다)
  const fillFixture = async (f: Fixture) => {
    const engine = engineRef.current;
    if (!prepare || prepBusy || !engine || !f.piece) return;
    setPrepMessage(null);
    setPrepBusy({ id: f.id, text: '빈자리 찍는 중…' });
    try {
      const planes = fillPlanes(hiddenBox(f, floorPolygon), f.piece.top, floorPolygon);
      const masked = await captureFillPlanes(engine, planes);
      setPrepBusy({ id: f.id, text: 'AI가 채우는 중…' });
      const filled = await requestFill(prepare.roomId, f.id, planes, masked);
      if (!filled.ok) {
        setPrepMessage(filled.message);
        return;
      }
      prepare.onAiRemaining?.(filled.remaining);
      setPrepBusy({ id: f.id, text: '올리는 중…' });
      const piece = await buildFillPiece(planes, filled.images, masked, f, floorPolygon);
      const uploaded = await uploadFixturePiece(prepare.roomId, f.id, 'fill', piece.bytes);
      if (!uploaded.ok) {
        setPrepMessage(uploaded.message);
        return;
      }
      prepare.onPrepared(uploaded.fixture, { fill: uploaded.url });
    } catch (err) {
      console.error(err);
      setPrepMessage('빈자리를 채우지 못했습니다. 잠시 후 다시 해 주세요.');
    } finally {
      setPrepBusy(null);
    }
  };
  const prepareFixture = async (f: Fixture) => {
    const splat = engineRef.current?.splat;
    if (!prepare || prepBusy || !splat) return;
    setPrepMessage(null);
    setPrepBusy({ id: f.id, text: '방 파일 읽는 중…' });
    try {
      if (!sourceRef.current) {
        sourceRef.current = await loadSourceSplats(prepare.sourceUrl, (fraction) => setPrepBusy({ id: f.id, text: `방 파일 읽는 중 ${Math.round(fraction * 100)}%` }));
      }
      setPrepBusy({ id: f.id, text: '떼어 내는 중…' });
      splat.updateWorldMatrix(true, false);
      const piece = await extractFixturePiece(sourceRef.current, splat.matrixWorld, f, floorPolygon, fixtures);
      if (!piece) {
        setPrepMessage(`${f.label} 자리에서 3D 조각을 찾지 못했습니다. 원래 가구 상자가 맞는지 확인해 주세요.`);
        return;
      }
      setPrepBusy({ id: f.id, text: '올리는 중…' });
      const uploaded = await uploadFixturePiece(prepare.roomId, f.id, 'piece', piece.bytes, piece.top, piece.box ?? undefined);
      if (!uploaded.ok) {
        setPrepMessage(uploaded.message);
        return;
      }
      prepare.onPrepared(uploaded.fixture, { piece: uploaded.url });
      moveFixture(uploaded.fixture);
    } catch (err) {
      console.error(err);
      setPrepMessage('원래 가구를 떼어 내지 못했습니다. 잠시 후 다시 해 주세요.');
    } finally {
      setPrepBusy(null);
    }
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
  // 남이 공유한 배치는 둘러보기만 했을 수 있으므로 다른 배치로 갈 때 저절로 저장하지 않는다
  const saveIfDirty = async (): Promise<boolean> => !dirty || !onSave || Boolean(sharedFrom) || (await save());

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
    commit((prev) => prev.filter((i) => !(i.kind === 'user' && i.furnitureRef === id)));
    setMineMessage(null);
  };

  const selected = items.find((i) => i.id === selectedId) ?? null;
  // 옮길 수 있는 원래 가구 목록 ("치울 가구"는 없는 것으로 보므로 뺀다)
  const movable = fixtures.filter((f) => !f.remove);
  const placeCount = items.filter((i) => i.kind !== 'fixture').length;
  const currentLayout = layouts.find((l) => l.id === currentLayoutId) ?? null;
  const hasOwnLayout = layouts.some((l) => l.createdBy === 'user');
  const aiHint =
    aiBlocked ??
    (placeCount === 0 ? '가구를 먼저 놓으면 AI가 다시 배치해 줍니다.' : placeCount > MAX_SUGGEST_ITEMS ? `가구가 ${MAX_SUGGEST_ITEMS}개를 넘으면 추천받을 수 없습니다.` : aiRemaining === 0 ? '오늘 쓸 수 있는 AI 횟수를 모두 썼습니다. 내일 다시 해 주세요.' : null);

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
                fixtures={movedIds.size > 0 ? fixtures.filter((f) => !movedIds.has(f.id)) : fixtures}
                onDrawFixture={onDrawFixture}
                badIds={shownBadIds}
                warnIds={shownWarnIds}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={(id, x, z) => commit((prev) => prev.map((i) => (i.id === id ? { ...i, x, z } : i)))}
                onRotate={rotateTo}
                onPreview={(id, pose) => setLive(id && pose ? { id, pose } : null)}
              />
            </div>
          </div>
        )}

        <div className="absolute top-3 left-3 flex items-start gap-2">
          {/* 3D ↔ 평면도 */}
          <button
            type="button"
            role="switch"
            aria-checked={showPlan}
            aria-label="평면도로 보기"
            className="flex rounded-xl bg-surface p-1 text-[13px] shadow-float"
            onClick={() => onShowPlan(!showPlan)}
            data-testid="plan-toggle"
          >
            <span className={`flex h-9 items-center rounded-[9px] px-4 ${showPlan ? 'font-medium text-sub' : 'bg-ink font-semibold text-white'}`}>3D</span>
            <span className={`flex h-9 items-center rounded-[9px] px-4 ${showPlan ? 'bg-ink font-semibold text-white' : 'font-medium text-sub'}`}>평면도</span>
          </button>
          {/* 되돌리기·다시하기 (가구 도구에서만) */}
          {furnitureActive && (
            <div className="flex rounded-xl bg-surface p-1 shadow-float" data-testid="layout-history">
              <button
                type="button"
                className="flex h-9 w-10 items-center justify-center rounded-[9px] text-ink hover:bg-soft disabled:text-mute disabled:hover:bg-transparent"
                disabled={history.past.length === 0}
                onClick={() => step('undo')}
                aria-label="되돌리기"
                title="되돌리기 (Ctrl+Z)"
                data-testid="layout-undo"
                data-steps={history.past.length}
              >
                <Icon name="undo" />
              </button>
              <button
                type="button"
                className="flex h-9 w-10 items-center justify-center rounded-[9px] text-ink hover:bg-soft disabled:text-mute disabled:hover:bg-transparent"
                disabled={history.future.length === 0}
                onClick={() => step('redo')}
                aria-label="다시하기"
                title="다시하기 (Ctrl+Shift+Z)"
                data-testid="layout-redo"
                data-steps={history.future.length}
              >
                <Icon name="redo" />
              </button>
            </div>
          )}
        </div>

        {/* 끄거나 돌리는 동안: 그 자리에서의 검사 결과를 바로 */}
        {liveMessages && (
          <div
            className={`pointer-events-none absolute top-16 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-1 rounded-xl px-3.5 py-2 text-[13px] font-medium shadow-float ${
              liveMessages.some((v) => v.severity === 'error') ? 'bg-danger-soft text-danger' : liveMessages.length ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'
            }`}
            role="status"
            data-testid="live-check"
            data-state={liveMessages.some((v) => v.severity === 'error') ? 'error' : liveMessages.length ? 'warning' : 'ok'}
          >
            {liveMessages.length === 0 ? (
              <span>여기는 괜찮습니다{live ? ` · ${Math.round(live.pose.rotationDeg)}°` : ''}</span>
            ) : (
              [...new Set(liveMessages.map((v) => v.message))].slice(0, 3).map((message) => <span key={message}>{message}</span>)
            )}
          </div>
        )}

        {/* 고른 가구: 이름·치수, 회전, 삭제 */}
        {selected && (
          <div
            className="absolute bottom-24 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 sm:bottom-16 lg:bottom-14 items-center gap-2.5 rounded-[14px] bg-surface py-1.5 pr-1.5 pl-2.5 whitespace-nowrap shadow-float sm:gap-3"
            data-testid="selection-bar"
            data-id={selected.id}
          >
            <FurnitureThumb furnitureRef={selected.furnitureRef} category={selected.category} src={catalogThumbnail({ id: selected.furnitureRef, kind: selected.kind })} size={34} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-bold">{selected.name}</span>
              <span className="font-mono text-[11px] text-mute" title={`위치 x ${selected.x.toFixed(2)}, z ${selected.z.toFixed(2)} · ${selected.rotationDeg}°`}>
                {dims(selected.w, selected.d, selected.h)}
              </span>
            </span>
            <span className="h-7 w-px bg-line" aria-hidden="true" />
            <button className="btn btn-soft h-11 px-3 text-[13px]" onClick={() => focusOn(selected)} title="이 가구가 잘 보이는 자리로 시점 옮기기" aria-label="가구로 이동" data-testid="selection-focus">
              <Icon name="focus" />
              <span className="max-sm:hidden">가구로 이동</span>
            </button>
            {/* 회전: 15°씩, 각도 입력, 90° (평면도의 손잡이나 3D에서 Shift+끌기로는 자유롭게) */}
            <div className="flex items-center rounded-xl bg-soft" data-testid="selection-rotation" data-deg={selected.rotationDeg}>
              <button className="flex h-11 w-9 items-center justify-center rounded-l-xl text-ink-2 hover:bg-chip" onClick={() => rotateBy(-ROTATE_STEP)} aria-label={`왼쪽으로 ${ROTATE_STEP}° 돌리기`} title={`왼쪽으로 ${ROTATE_STEP}° (Shift+R)`} data-testid="rotate-left">
                <Icon name="undo" />
              </button>
              <label className="flex items-center font-mono text-[13px]">
                <span className="sr-only">회전 각도</span>
                <input
                  className="h-9 w-11 rounded-md bg-surface text-center tabular-nums outline-none focus:ring-2 focus:ring-accent"
                  inputMode="numeric"
                  value={angleText ?? String(selected.rotationDeg)}
                  onFocus={(e) => {
                    setAngleText(String(selected.rotationDeg));
                    e.currentTarget.select();
                  }}
                  onChange={(e) => setAngleText(e.target.value)}
                  onBlur={() => {
                    const deg = angleText === null ? null : parseRotationInput(angleText);
                    if (deg !== null && deg !== selected.rotationDeg) rotateTo(selected.id, deg);
                    setAngleText(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setAngleText(null);
                      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                    }
                  }}
                  data-testid="rotate-input"
                />
                <span className="pr-0.5 pl-0.5 text-mute">°</span>
              </label>
              <button className="flex h-11 w-9 items-center justify-center rounded-r-xl text-ink-2 hover:bg-chip" onClick={() => rotateBy(ROTATE_STEP)} aria-label={`오른쪽으로 ${ROTATE_STEP}° 돌리기`} title={`오른쪽으로 ${ROTATE_STEP}° (R)`} data-testid="rotate-right">
                <Icon name="redo" />
              </button>
            </div>
            <button className="btn btn-soft h-11 px-3 text-[13px]" onClick={rotate} aria-label="90° 회전" title="90° 회전">
              <Icon name="rotate" />
              <span className="max-sm:hidden">90°</span>
            </button>
            <button className="btn btn-danger h-11 px-3.5 text-[13px]" onClick={remove} data-testid="selection-remove">
              {selected.kind === 'fixture' ? '제자리로' : '삭제'}
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

            {sharedFrom && (
              <div className="flex flex-col gap-1 rounded-xl bg-accent-soft px-3.5 py-3 text-[13px]" data-testid="shared-layout-card">
                <span className="flex items-center gap-1.5 font-semibold text-accent-strong">
                  <Icon name="share" size={14} />
                  {sharedFrom.ownerName}님이 공유한 배치
                </span>
                <span className="text-body">
                  &ldquo;{sharedFrom.layoutName}&rdquo; ·{' '}
                  {onSave ? '가구를 옮겨 보고 "내 배치로 저장"하면 내 배치로 남습니다.' : '로그인하면 내 배치로 저장할 수 있습니다.'}
                </span>
              </div>
            )}
            {sharedMissing && (
              <p className="rounded-xl bg-warn-tint px-3.5 py-2.5 text-[13px] text-warn" role="alert" data-testid="shared-layout-missing">
                공유받은 배치를 볼 수 없습니다. 비공개로 바뀌었거나 지워졌습니다.
              </p>
            )}

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
                        {(!hasOwnLayout || currentLayoutId === null) && <option value="">{sharedFrom ? `${sharedFrom.ownerName}님의 배치 (공유받음)` : '내 배치 (새로 만들기)'}</option>}
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
                      {saveState === 'error' ? '다시 저장' : sharedFrom ? '내 배치로 저장' : '배치 저장'}
                    </button>
                  )}
                  {share && currentLayout && (
                    <button
                      className={`btn h-11 px-3 text-[13px] ${shareOpen ? 'bg-accent-soft text-accent-strong' : 'btn-soft'}`}
                      aria-expanded={shareOpen}
                      aria-label="배치 공유"
                      onClick={() => setShareOpen((open) => !open)}
                      data-testid="layout-share"
                      data-public={currentLayout.isPublic ?? false}
                    >
                      <Icon name="share" size={15} />
                      <span className="max-sm:hidden">공유</span>
                    </button>
                  )}
                  {hasChooser && onDeleteLayout && currentLayout && !confirmLayoutDelete && (
                    <button className="btn btn-soft h-11 px-3.5 text-[13px]" disabled={layoutBusy || aiBusy} onClick={() => setConfirmLayoutDelete(true)} data-testid="layout-delete">
                      지우기
                    </button>
                  )}
                </div>
                {share && currentLayout && shareOpen && (
                  <LayoutShareBox
                    key={currentLayout.id}
                    roomId={share.roomId}
                    layoutId={currentLayout.id}
                    isPublic={currentLayout.isPublic ?? false}
                    roomPublic={share.roomPublic}
                    dirty={dirty}
                    onSetPublic={(next) => share.onSetPublic(currentLayout.id, next)}
                  />
                )}
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
                        <FurnitureThumb
                          furnitureRef={item?.furnitureRef ?? ''}
                          category={item?.category ?? ''}
                          src={item ? catalogThumbnail({ id: item.furnitureRef, kind: item.kind }) : null}
                        />
                        <span className="flex min-w-0 flex-col gap-px">
                          <button className="self-start text-left font-bold underline decoration-line-strong decoration-dotted underline-offset-4" onClick={() => {
                              if (item) focusOn(item);
                              else setSelectedId(r.itemId);
                            }}
                          >
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
                  aria-label={`+ ${catalogLabel(entry)}`}
                  title={dims(entry.w, entry.d, entry.h)}
                >
                  <FurnitureThumb furnitureRef={entry.id} category={entry.category} src={catalogThumbnail(entry)} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold">{entry.nameKo}</span>
                    <span className="truncate text-[11px] text-mute">
                      {entry.styleKo && <span className="text-body">{entry.styleKo} · </span>}
                      <span className="font-mono">{sizeLabel(entry.w, entry.d)}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {credits.length > 0 && (
              <p className="text-[11px] leading-snug text-mute" data-testid="furniture-credit">
                가구 3D 모델: {credits.join(' · ')}. 웹용으로 압축하고 크기를 맞췄습니다.
              </p>
            )}
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
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate text-[13px] font-semibold">{entry.nameKo}</span>
                            {entry.modelUrl && (
                              <span className="shrink-0 rounded bg-accent-soft px-1 font-mono text-[10px] font-semibold text-accent-strong" data-testid="user-furniture-3d">
                                3D
                              </span>
                            )}
                          </span>
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
              ) : scanOpen && onCreateScanFurniture ? (
                <ScanFurnitureForm
                  onCreate={async (glb, value) => {
                    const result = await onCreateScanFurniture(glb, value);
                    if (!result.ok) return result;
                    setMine((prev) => [...prev, result.item]);
                    setMineMessage(null);
                    return { ok: true };
                  }}
                  onClose={() => setScanOpen(false)}
                />
              ) : (
                mine.length < MAX_USER_FURNITURE && (
                  <div className="flex flex-col gap-2">
                    <button className="flex h-[42px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-field text-[13px] font-medium text-sub hover:bg-soft" onClick={() => setMineFormOpen(true)} data-testid="user-furniture-open">
                      <Icon name="plus" />
                      직접 만들기 (이름·치수)
                    </button>
                    {onCreateScanFurniture && (
                      <button className="flex h-[42px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-field text-[13px] font-medium text-sub hover:bg-soft" onClick={() => setScanOpen(true)} data-testid="scan-open">
                        <Icon name="plus" />
                        3D 스캔 올리기 (GLB)
                      </button>
                    )}
                  </div>
                )
              )}
              {mineMessage && (
                <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="user-furniture-message">
                  {mineMessage}
                </p>
              )}
            </div>
          )}

          {movable.length > 0 && (
            <div className="flex flex-col gap-2.5" data-testid="fixture-move">
              <SectionTitle>방에 원래 있던 가구</SectionTitle>
              <ul className="flex flex-col gap-1.5" data-testid="fixture-move-list">
                {movable.map((f) => {
                  const moved = movedIds.has(f.id);
                  const ready = Boolean(f.piece && pieceUrls[f.id]?.piece);
                  const busy = prepBusy?.id === f.id;
                  const state = moved ? 'moved' : ready ? 'ready' : prepare ? 'prepare' : 'locked';
                  return (
                    <li key={f.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface py-1.5 pr-1.5 pl-2.5" data-id={f.id} data-state={state}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-semibold">{f.label}</span>
                        <span className="truncate text-[11px] text-mute">
                          <span className="font-mono">{sizeLabel(f.w, f.d)}</span>
                          {moved ? ' · 옮김' : state === 'locked' ? (loginHint ? ' · 로그인하면 떼어 내 옮길 수 있음' : ' · 지금은 떼어 낼 수 없음') : ''}
                        </span>
                      </span>
                      {moved ? (
                        <span className="flex shrink-0 gap-1.5">
                          {prepare && f.piece && (prepare.isOwner || !f.fill) && (
                            <button
                              className="btn btn-soft h-9 px-3 text-[13px] disabled:opacity-40"
                              disabled={(prepBusy !== null && !busy) || aiRemaining === 0}
                              onClick={() => fillFixture(f)}
                              title="옮긴 뒤 비어 보이는 바닥·벽을 AI가 주변에 맞춰 채웁니다 (AI 1회)"
                              data-testid="fixture-fill"
                              data-filled={f.fill ? 'true' : 'false'}
                            >
                              {busy ? prepBusy.text : f.fill ? '다시 채우기' : '빈자리 AI로 채우기'}
                            </button>
                          )}
                          <button className="btn btn-outline h-9 px-3 text-[13px]" disabled={busy} onClick={() => returnFixture(f)} data-testid="fixture-return">
                            제자리로
                          </button>
                        </span>
                      ) : (
                        <button
                          className="btn btn-soft h-9 shrink-0 px-3 text-[13px] disabled:opacity-40"
                          disabled={state === 'locked' || full || (prepBusy !== null && !busy)}
                          onClick={() => (ready ? moveFixture(f) : prepareFixture(f))}
                          title={ready ? '원래 가구를 떼어 내 끌어서 옮깁니다' : '방 3D에서 이 가구를 떼어 낸 뒤 옮깁니다 (한 번만)'}
                          data-testid="fixture-move-button"
                        >
                          {busy ? prepBusy.text : '옮기기'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {prepMessage && (
                <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="fixture-move-message">
                  {prepMessage}
                </p>
              )}
              {movedIds.size > 0 && <p className="text-xs text-sub">옮긴 가구는 끌거나 돌릴 수 있고, &ldquo;제자리로&rdquo;를 누르면 원래 자리로 돌아갑니다.</p>}
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
                    <li key={item.id} className={`flex items-center rounded-[10px] ${on ? 'bg-accent-soft' : 'hover:bg-soft'}`}>
                      <button
                        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2.5 text-left"
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
                      <button
                        type="button"
                        className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sub hover:bg-surface hover:text-accent-strong"
                        onClick={() => focusOn(item)}
                        aria-label={`${item.name}로 시점 옮기기`}
                        title="3D에서 이 가구 보기"
                        data-testid="placed-focus"
                        data-id={item.id}
                      >
                        <Icon name="focus" />
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
              <div ref={aiFormRef} className="flex flex-col gap-2" data-testid="ai-form" data-prefilled={prefillNonce > 0}>
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
