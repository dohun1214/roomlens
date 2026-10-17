'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isMobile, SparkRenderer, SplatMesh, type PackedSplats } from '@sparkjsdev/spark';
import CalibrationTool, { type AppliedCalibration } from './CalibrationTool';
import OpeningsTool from './OpeningsTool';
import FixturesTool from './FixturesTool';
import RoomPrepBanner from './RoomPrepBanner';
import Icon from '@/components/ui/Icon';
import type { AutoDetect, AutoDetectResult, RoomPrep } from './roomPrep';
import AnalysisPanel from './AnalysisPanel';
import type { SavedReport } from '@/components/rooms/RoomReportView';
import FurnitureLayer from '@/components/layout/FurnitureLayer';
import type { Point2 } from '@/lib/three/floorDrag';
import type { CatalogItem } from '@/lib/layout/catalog';
import type { SavedItem } from '@/lib/layout/saved';
import { deleteMyLayout, MY_LAYOUT_NAME, saveMyLayout, type MyLayout } from '@/lib/layout/store';
import { requestLayoutSuggestion, type AiResultView } from '@/lib/ai/suggestClient';
import { createUserFurniture, deleteUserFurniture, type UserFurnitureValue } from '@/lib/layout/userFurniture';
import type { Engine } from './engine';
import { ToolRail, type Slots, type ToolId } from './workspace';
import { keepCameraInRoom } from '@/lib/three/cameraBounds';
import { isMoveKey, isTypingTarget, moveStep, WALK_SPEED } from '@/lib/three/keyboardMove';
import { LOOK_ROTATE_SPEED, lookTarget, panDelta, pinchDistance, wheelDistance } from '@/lib/three/viewMove';
import { pickPoint } from '@/lib/three/pickPoint';
import { sampleScenePoints } from '@/lib/three/scenePoints';
import { autoCalibrate } from '@/lib/three/autoCalibrate';
import { setObjectRoomTransform } from '@/lib/three/roomTransform';
import { startPoseForRoom, toCalibrationColumns, type SavedCalibration } from '@/lib/rooms/calibration';
import { sameOpenings, type Opening } from '@/lib/rooms/openings';
import { sameFixtures, type Fixture } from '@/lib/rooms/fixtures';
import { createClient } from '@/lib/supabase/client';
import { loadingBarValue, loadingLabel, progressFromBytes, type LoadProgress } from '@/lib/viewer/loadProgress';
import { resolveViewerQuality } from '@/lib/viewer/quality';

export const SAMPLE_SPLAT_URL = 'https://sparkjs.dev/assets/splats/fireplace.spz';

type Source = { kind: 'url'; url: string } | { kind: 'file'; file: File };

type Stats = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  name: string;
  loadMs?: number;
  /** 그중 파일을 받는 데 걸린 시간 (URL로 열 때만) */
  downloadMs?: number;
  numSplats?: number;
  fromLodTree?: boolean;
  error?: string;
};

// X축 180° 회전 (OpenCV 좌표계 → OpenGL 좌표계)
const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);
const IDENTITY = new THREE.Quaternion();

type Props = {
  /** 방 화면에서 쓸 때 열 파일 주소. 주면 개발용 URL 입력칸·파일 열기를 숨긴다 */
  url?: string;
  /** 화면에 보여줄 이름 (없으면 주소) */
  name?: string;
  /** 방에 저장된 보정. 있으면 방 좌표(바닥 y=0, m)로 옮기고 방 안에서 시작한다 */
  calibration?: SavedCalibration | null;
  /** 보정을 저장할 방 (방 주인일 때만 canEdit) */
  roomId?: string;
  canEdit?: boolean;
  /** 놓을 수 있는 가구 목록 (없으면 기본 카탈로그) */
  catalog?: CatalogItem[];
  /** 로그인했는지. 로그인한 사람만 배치를 저장할 수 있다 (방 주인이 아니어도 된다) */
  signedIn?: boolean;
  /** 이 방에 내가 저장해 둔 배치들 (내 배치, AI 배치). 맨 앞의 것으로 시작한다 */
  initialLayouts?: MyLayout[];
  /** 오늘 남은 AI 호출 횟수 (모르면 null) */
  aiRemaining?: number | null;
  /** 이 방의 가장 최근 분석 리포트 */
  initialReport?: SavedReport | null;
  /** 내가 만들어 둔 가구 */
  userFurniture?: CatalogItem[];
  /** 방에 저장된 문·창문 (저장된 보정의 벽 기준) */
  initialOpenings?: Opening[];
  /** 방에 원래 있는 가구 (저장된 보정의 방 좌표) */
  initialFixtures?: Fixture[];
  /** 방의 출처·라이선스 (데이터셋 방). 3D 화면 아래에 표시한다 */
  credit?: string | null;
};

const NO_OPENINGS: Opening[] = [];
const NO_FIXTURES: Fixture[] = [];
const NO_LAYOUTS: MyLayout[] = [];
const NO_KEYS: string[] = [];

export default function SplatViewer({
  url,
  name,
  calibration = null,
  roomId,
  canEdit = false,
  catalog,
  signedIn = false,
  initialLayouts = NO_LAYOUTS,
  aiRemaining: initialAiRemaining = null,
  initialReport = null,
  userFurniture,
  initialOpenings = NO_OPENINGS,
  initialFixtures = NO_FIXTURES,
  credit = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const loadSeq = useRef(0);
  const flippedRef = useRef(calibration?.flipX ?? false);
  const calibrationRef = useRef(calibration);
  // 저장된 배치들. 보정을 다시 해서 가구 층이 새로 만들어져도 마지막으로 저장한 배치에서 시작하게 여기에 둔다
  const [layouts, setLayouts] = useState<MyLayout[]>(initialLayouts);
  // 지금 보고 있는 배치 (null이면 아직 저장하지 않은 새 배치)
  const [layoutId, setLayoutId] = useState<string | null>(initialLayouts[0]?.id ?? null);
  const layoutIdRef = useRef(layoutId);
  // 다른 배치로 바꿀 때마다 올려서 가구 층을 새로 만든다 (저장만 할 때는 그대로)
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [aiRemaining, setAiRemaining] = useState<number | null>(initialAiRemaining);
  const [aiResult, setAiResult] = useState<AiResultView | null>(null);
  // 문·창문은 벽 번호로 저장하므로 "어느 평면도 기준인지"를 함께 기억한다. 보정을 새로 저장하면 비운다
  const [savedPolygonKey, setSavedPolygonKey] = useState(calibration ? JSON.stringify(calibration.floorPolygon) : null);
  const savedPolygonKeyRef = useRef(savedPolygonKey);
  const [openings, setOpenings] = useState({ key: savedPolygonKey, items: initialOpenings });
  // 화면에서 넣거나 지운(아직 저장 전일 수 있는) 문·창문. 가구 검사는 이것을 쓴다
  const [liveOpenings, setLiveOpenings] = useState<{ key: string | null; items: Opening[]; aiKeys: string[] } | null>(null);
  // 방에 원래 있는 가구도 방 좌표로 저장하므로 문·창문처럼 평면도와 함께 기억하고, 보정을 새로 저장하면 비운다
  const [fixtures, setFixtures] = useState({ key: savedPolygonKey, items: initialFixtures });
  const [liveFixtures, setLiveFixtures] = useState<{ key: string | null; items: Fixture[] } | null>(null);
  // 평면도에서 원래 가구 사각형을 그리는 중이면 그린 결과를 받을 곳
  const [planDraw, setPlanDraw] = useState<{ onDraw: (a: Point2, b: Point2) => void } | null>(null);
  // 고른 도구 (아직 고르지 않았으면 보정된 방은 가구, 아니면 크기 보정)
  const [tool, setTool] = useState<ToolId | null>(null);
  // 도구들이 패널과 3D 화면 위에 자기 화면을 그려 넣을 자리
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  // 폰: 아래 패널을 접었는지
  const [sheetClosed, setSheetClosed] = useState(false);
  // 3D 대신 평면도를 보고 있는지
  const [showPlan, setShowPlan] = useState(false);
  // "AI로 방 준비하기" 진행 (보정 저장 → 문·창문 찾기 → 원래 가구 찾기 → 확인)
  const [prep, setPrep] = useState<RoomPrep | null>(null);
  // 방 준비의 확인 단계에서 아직 저장하지 않은 단계가 있는지 (저장 콜백에서 최신 값을 읽으려고)
  const prepOpeningsPendingRef = useRef(false);
  const prepFixturesPendingRef = useRef(false);
  const [hasReport, setHasReport] = useState(initialReport !== null);
  const [debug] = useState(() => new URLSearchParams(window.location.search).has('debug'));
  const [stats, setStats] = useState<Stats>({ status: 'idle', name: '' });
  const [fps, setFps] = useState(0);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  // 지금 화면에 그리는 스플랫 수와 화면 배율 (폰에서 화질 설정이 먹었는지 확인용)
  const [drawn, setDrawn] = useState<number | null>(null);
  const [pixelRatio, setPixelRatio] = useState(1);
  const [motionInfo, setMotionInfo] = useState('');
  const [flipped, setFlipped] = useState(calibration?.flipX ?? false);
  // 보정이 적용된 방의 평면도. 다른 파일을 열면 key가 달라져 무시된다.
  const [room, setRoom] = useState<{ key: string; polygon: Point2[] } | null>(null);
  /** 키보드로 걸을 때 1초에 가는 거리 (지금 장면의 단위) */
  const walkSpeedRef = useRef(WALK_SPEED);
  const rawSpeedRef = useRef(WALK_SPEED);
  /** 카메라를 방 안에 머물게 할지 (보정된 방에서만 쓸 수 있다) */
  const [stayInside, setStayInside] = useState(true);
  // 3D에 문·창문 판과 원래 가구 상자를 보일지 (브라우저에 기억한다)
  const [markers, setMarkers] = useState<Markers>(readMarkers);
  const [markersOpen, setMarkersOpen] = useState(false);
  const markersRef = useRef<HTMLDivElement>(null);
  // 메뉴 밖을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!markersOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!markersRef.current?.contains(e.target as Node)) setMarkersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMarkersOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [markersOpen]);
  const changeMarkers = (next: Markers) => {
    setMarkers(next);
    writeMarkers(next);
  };
  /** 카메라가 머물 범위: 바닥 평면도와 천장 높이. null이면 막지 않는다 */
  const boundsRef = useRef<{ polygon: Point2[]; ceilingY: number | null } | null>(null);
  const [urlInput, setUrlInput] = useState(
    () => url ?? (new URLSearchParams(window.location.search).get('url') || SAMPLE_SPLAT_URL),
  );

  // three.js + Spark 초기화 (한 번만)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    // 기기별 화질 설정 (폰은 그리는 양을 줄인다). 주소의 ?lod= ?pr= ?lrs= 로 바꿔 볼 수 있다
    const quality = resolveViewerQuality(isMobile(), new URLSearchParams(window.location.search));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    setPixelRatio(renderer.getPixelRatio());
    setMotionInfo(`정렬 ${quality.minSortIntervalMs}ms · 시야 집중 ${quality.foveation ? '켬' : '끔'}`);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9ecf1);
    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.05,
      100,
    );
    camera.position.set(0, 0, 3);

    // Spark 자체 레이캐스트는 정확도가 부족해 쓰지 않는다(lib/three/pickPoint 참고).
    // lodRaycast: 0 으로 레이캐스트용 LOD 인덱스를 주기적으로 만드는 작업을 끈다.
    const spark = new SparkRenderer({
      renderer,
      lodRaycast: 0,
      lodSplatCount: quality.lodSplatCount,
      lodRenderScale: quality.lodRenderScale,
      minSortIntervalMs: quality.minSortIntervalMs,
      // 시야 집중을 끄면 어느 방향이든 같은 세밀함으로 고른다 (돌려도 LOD가 다시 골라지지 않음)
      ...(quality.foveation ? {} : { coneFov0: 0, coneFov: 0, coneFoveate: 1, behindFoveate: 1 }),
    });
    scene.add(spark);

    const roomGroup = new THREE.Group(); // 이후 보정 변환(회전·크기·높이)을 적용할 그룹
    scene.add(roomGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // 방 안에서 둘러보기: 끌기 = 제자리에서 고개 돌리기(바라보는 점을 카메라 바로 앞에 둔다, 아래 루프).
    // 휠·옮기기는 OrbitControls 대신 아래에서 직접 한다 (바라보는 점이 가까워 OrbitControls로는 거의 안 움직인다)
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.rotateSpeed = LOOK_ROTATE_SPEED;
    const canvas = renderer.domElement;

    // 캡처처럼 카메라를 직접 옮기는 동안(controls.enabled = false)과 실측의 자유 카메라에서는 방 안에 가두지 않는다
    const currentBounds = () => (controls.enabled && !engineRef.current?.freeCamera ? boundsRef.current : null);
    let lastGood: Point2 | null = null;
    /** 카메라와 바라보는 점을 같이 옮긴다. 방 안에 머물게 할 때는 벽에 막힌 만큼만 */
    const moveBy = (delta: THREE.Vector3) => {
      const bounds = currentBounds();
      if (bounds) {
        const wanted: [number, number, number] = [camera.position.x + delta.x, camera.position.y + delta.y, camera.position.z + delta.z];
        const allowed = keepCameraInRoom(wanted, bounds.polygon, bounds.ceilingY, lastGood) ?? wanted;
        delta.set(allowed[0] - camera.position.x, allowed[1] - camera.position.y, allowed[2] - camera.position.z);
      }
      camera.position.add(delta);
      controls.target.add(delta);
    };

    // 휠: 보는 쪽으로 다가가기/물러나기
    const forward = new THREE.Vector3();
    const onWheel = (event: WheelEvent) => {
      if (!controls.enabled) return;
      event.preventDefault();
      const distance = wheelDistance(event.deltaY, event.deltaMode, walkSpeedRef.current);
      if (!distance) return;
      camera.getWorldDirection(forward);
      moveBy(forward.multiplyScalar(distance));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // 오른쪽 끌기·Shift(Ctrl)+끌기: 옆·위아래로 옮기기. 두 손가락: 끌면 옮기고 벌리면 다가간다
    // (가구를 잡은 포인터는 FurnitureLayer가 capture 단계에서 막아 여기로 오지 않는다)
    const sideDir = new THREE.Vector3();
    const panBy = (dx: number, dy: number) => {
      sideDir.set(1, 0, 0).applyQuaternion(camera.quaternion);
      sideDir.y = 0;
      if (sideDir.lengthSq() < 1e-9) return;
      sideDir.normalize();
      moveBy(new THREE.Vector3(...panDelta(dx, dy, sideDir.toArray(), walkSpeedRef.current)));
    };
    let mousePan: { id: number; x: number; y: number } | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { cx: number; cy: number; dist: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!controls.enabled) return;
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        pinch = touches.size === 2 ? pinchState() : null;
        // 두 손가락일 때는 돌리지 않는다 (OrbitControls는 확대·옮기기를 꺼 두면 두 손가락의 가운데로 계속 돌린다)
        controls.enableRotate = touches.size < 2;
        return;
      }
      if (event.button === 2 || (event.button === 0 && (event.shiftKey || event.ctrlKey || event.metaKey))) {
        mousePan = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        if (!touches.has(event.pointerId)) return;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size !== 2 || !pinch) return;
        const next = pinchState();
        panBy(next.cx - pinch.cx, next.cy - pinch.cy);
        const distance = pinchDistance(pinch.dist, next.dist, walkSpeedRef.current);
        if (distance) {
          camera.getWorldDirection(forward);
          moveBy(forward.multiplyScalar(distance));
        }
        pinch = next;
        return;
      }
      if (!mousePan || event.pointerId !== mousePan.id) return;
      panBy(event.clientX - mousePan.x, event.clientY - mousePan.y);
      mousePan = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        touches.delete(event.pointerId);
        pinch = touches.size === 2 ? pinchState() : null;
        if (touches.size === 0) controls.enableRotate = true;
        return;
      }
      if (mousePan && event.pointerId === mousePan.id) mousePan = null;
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);

    // 키보드로 걸어 다니기 (W A S D·방향키, Q E, Shift). 글자를 넣는 중에는 움직이지 않는다
    const pressed = new Set<string>();
    const viewDir = new THREE.Vector3();
    const upDir = new THREE.Vector3();
    const step = new THREE.Vector3();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target as HTMLElement | null)) return;
      if (isMoveKey(event.code)) {
        pressed.add(event.code);
        // 방향키로 페이지가 밀리지 않게
        if (event.code.startsWith('Arrow')) event.preventDefault();
      } else if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        pressed.add(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => pressed.delete(event.code);
    const releaseKeys = () => pressed.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseKeys);
    document.addEventListener('visibilitychange', releaseKeys);
    // 입력 칸으로 초점이 옮겨 가면 keyup을 받지 못하므로 그때도 멈춘다
    window.addEventListener('focusin', releaseKeys);

    let frames = 0;
    let last = performance.now();
    let lastFrame = performance.now();
    renderer.setAnimationLoop(() => {
      const frameNow = performance.now();
      const bounds = currentBounds();
      if (pressed.size > 0 && controls.enabled) {
        camera.getWorldDirection(viewDir);
        upDir.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const delta = moveStep(pressed, viewDir.toArray(), upDir.toArray(), (frameNow - lastFrame) / 1000, walkSpeedRef.current);
        if (delta) moveBy(step.set(...delta));
      }
      lastFrame = frameNow;
      if (controls.enabled) {
        // 어디서 카메라를 옮겼든(첫 구도, "3D에서 보기" 등) 바라보는 점을 바로 앞으로 당겨 제자리에서 돌게 한다
        const target = lookTarget(camera.position.toArray(), controls.target.toArray());
        if (target) controls.target.set(...target);
      }
      controls.update();
      if (bounds) {
        // 마우스로 돌리거나 물러나다 벽을 넘은 경우: 카메라만 방 안으로 데려오고 보던 곳은 그대로 본다
        const fixed = keepCameraInRoom(camera.position.toArray(), bounds.polygon, bounds.ceilingY, lastGood);
        if (fixed) {
          camera.position.set(...fixed);
          camera.lookAt(controls.target);
        }
        lastGood = [camera.position.x, camera.position.z];
      } else {
        lastGood = null;
      }
      renderer.render(scene, camera);
      frames += 1;
      const now = performance.now();
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        setDrawn(engineRef.current?.splat?.context.numSplats.value ?? null);
        frames = 0;
        last = now;
      }
    });

    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    engineRef.current = { renderer, scene, camera, controls, spark, roomGroup, splat: null };
    if (process.env.NODE_ENV !== 'production') {
      Object.assign(window, {
        __roomlens: engineRef.current,
        __roomlensPick: pickPoint,
        // 성능 재기용 (scripts/dev-data/eval-room-prep.mjs): 장면의 표면 점, 자동 보정 결과
        __roomlensScenePoints: () => {
          const splat = engineRef.current?.splat;
          const points = splat ? sampleScenePoints(splat) : null;
          if (!points) return null;
          const b64 = (a: Float32Array) => {
            const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
            let out = '';
            for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(out);
          };
          return {
            count: points.count,
            positions: b64(points.positions),
            normals: b64(points.normals),
            weights: b64(points.weights),
            brightness: points.brightness ? b64(points.brightness) : null,
          };
        },
        __roomlensAutoCalibrate: () => {
          const splat = engineRef.current?.splat;
          if (!splat) return { ok: false, message: '장면이 없습니다.' };
          const t0 = performance.now();
          const result = autoCalibrate(splat);
          if (!result.ok) return result;
          const { estimate } = result;
          return {
            ok: true,
            transform: result.transform,
            flipX: flippedRef.current,
            floorPolygon: result.floorPolygon,
            info: { ms: Math.round(performance.now() - t0), height: result.height, scaleGuessed: result.scaleGuessed, scale: estimate.scale, up: estimate.up, ...estimate.info },
          };
        },
      });
    }

    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseKeys);
      document.removeEventListener('visibilitychange', releaseKeys);
      window.removeEventListener('focusin', releaseKeys);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      renderer.setAnimationLoop(null);
      engineRef.current?.splat?.dispose();
      controls.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      engineRef.current = null;
    };
  }, []);

  const load = useCallback(async (source: Source) => {
    const engine = engineRef.current;
    if (!engine) return;
    const seq = ++loadSeq.current;

    if (engine.splat) {
      engine.roomGroup.remove(engine.splat);
      engine.splat.dispose();
      engine.splat = null;
    }

    const name = source.kind === 'url' ? source.url : source.file.name;
    setStats({ status: 'loading', name });
    setLoadProgress(source.kind === 'url' ? { phase: 'download', percent: null } : { phase: 'prepare', percent: null });
    const t0 = performance.now();
    let downloadMs: number | undefined;
    const onProgress = (event: ProgressEvent) => {
      if (seq !== loadSeq.current) return;
      const next = progressFromBytes(event.lengthComputable ? event.loaded : Number.NaN, event.total);
      if (next.phase === 'prepare') downloadMs ??= performance.now() - t0;
      // 퍼센트가 바뀔 때만 다시 그린다
      setLoadProgress((prev) => (prev?.phase === next.phase && prev.percent === next.percent ? prev : next));
    };

    try {
      const splat =
        source.kind === 'url'
          ? new SplatMesh({ url: source.url, lod: true, onProgress })
          : new SplatMesh({
              fileBytes: await source.file.arrayBuffer(),
              fileName: source.file.name,
              lod: true,
            });
      await splat.initialized;
      if (seq !== loadSeq.current) {
        splat.dispose();
        return;
      }
      splat.quaternion.copy(flippedRef.current ? FLIP_X : IDENTITY);
      engine.roomGroup.add(splat);
      engine.splat = splat;
      const loadMs = performance.now() - t0;

      const saved = source.kind === 'url' ? calibrationRef.current : null;
      if (saved) {
        // 저장된 보정: 방 좌표로 옮기고 방 안에서 방 가운데를 보며 시작한다
        setObjectRoomTransform(engine.roomGroup, saved.transform);
        const pose = startPoseForRoom(saved.floorPolygon);
        engine.camera.position.set(...pose.position);
        engine.controls.target.set(...pose.target);
        engine.camera.near = 0.05;
        engine.camera.far = 200;
        engine.camera.updateProjectionMatrix();
        engine.controls.update();
        // 보정 전 단위로는 1m가 1/s 이다 (보정을 풀었을 때 쓰는 빠르기)
        rawSpeedRef.current = WALK_SPEED / saved.transform.s;
        setRoom({ key: `${name}|${loadMs}|${flippedRef.current}`, polygon: saved.floorPolygon });
      } else {
        // 크기를 모르는 장면: 장면 크기에 견줘 걷는 빠르기를 정한다
        const size = frameCamera(engine, splat);
        rawSpeedRef.current = size ? size * 0.1 : WALK_SPEED;
      }

      // lod: true 이면 원본 배열은 비고 LOD 트리(lodSplats)만 남는다.
      const packed = splat.packedSplats;
      const original = packed?.numSplats ?? 0;
      const lodTree = packed?.lodSplats?.numSplats ?? 0;
      setStats({
        status: 'ready',
        name,
        loadMs,
        downloadMs,
        numSplats: original || lodTree,
        fromLodTree: !original && lodTree > 0,
      });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      console.error(err);
      setStats({ status: 'error', name, error: String(err) });
    } finally {
      if (seq === loadSeq.current) setLoadProgress(null);
    }
  }, []);

  // 첫 로드: ?url= 이 있으면 그 파일, 없으면 샘플
  useEffect(() => {
    load({ kind: 'url', url: urlInput });
    // 마운트 시 한 번만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFlip = () => {
    const next = !flipped;
    flippedRef.current = next;
    setFlipped(next);
    const engine = engineRef.current;
    if (engine?.splat) {
      engine.splat.quaternion.copy(next ? FLIP_X : IDENTITY);
      frameCamera(engine, engine.splat);
    }
  };

  const sceneKey = `${stats.name}|${stats.loadMs}|${flipped}`;
  const roomPolygonKey = room ? JSON.stringify(room.polygon) : null;
  const savedOpenings = roomPolygonKey === openings.key ? openings.items : NO_OPENINGS;
  const shownOpenings = liveOpenings && liveOpenings.key === roomPolygonKey ? liveOpenings.items : savedOpenings;
  const savedFixtures = roomPolygonKey === fixtures.key ? fixtures.items : NO_FIXTURES;
  const shownFixtures = liveFixtures && liveFixtures.key === roomPolygonKey ? liveFixtures.items : savedFixtures;

  // 방 주인이 보정을 저장한다 (transform·floor_polygon은 방 주인이 직접 바꿀 수 있는 컬럼)
  const saveCalibration = useCallback(
    async (applied: AppliedCalibration) => {
      if (!roomId) return false;
      // 평면도가 바뀌면 벽 번호와 방 좌표가 달라지므로 문·창문과 원래 가구도 함께 비운다
      const key = JSON.stringify(applied.floorPolygon);
      const wallsChanged = key !== savedPolygonKeyRef.current;
      const { data, error } = await createClient()
        .from('rooms')
        .update({ ...toCalibrationColumns({ ...applied, flipX: flippedRef.current }), ...(wallsChanged ? { openings: [], fixtures: [] } : {}) })
        .eq('id', roomId)
        .select('id')
        .maybeSingle();
      if (error || data === null) return false;
      savedPolygonKeyRef.current = key;
      setSavedPolygonKey(key);
      if (wallsChanged) {
        setOpenings({ key, items: [] });
        setLiveOpenings(null);
        setFixtures({ key, items: [] });
        setLiveFixtures(null);
      }
      return true;
    },
    [roomId],
  );

  // 방 주인이 문·창문을 저장한다 (지금 저장돼 있는 평면도 기준)
  const saveOpenings = useCallback(
    async (items: Opening[]) => {
      if (!roomId) return false;
      const { data, error } = await createClient().from('rooms').update({ openings: items }).eq('id', roomId).select('id').maybeSingle();
      if (error || data === null) return false;
      setOpenings({ key: savedPolygonKeyRef.current, items });
      return true;
    },
    [roomId],
  );

  // 방 주인이 원래 가구를 저장한다 (지금 저장돼 있는 평면도 기준)
  const saveFixtures = useCallback(
    async (items: Fixture[]) => {
      if (!roomId) return false;
      const { data, error } = await createClient().from('rooms').update({ fixtures: items }).eq('id', roomId).select('id').maybeSingle();
      if (error || data === null) return false;
      setFixtures({ key: savedPolygonKeyRef.current, items });
      return true;
    },
    [roomId],
  );
  // "AI로 방 준비하기": 보정을 저장한 뒤 부른다. 문·창문 도구가 먼저 찾고, 끝나면 원래 가구 도구가 이어서 찾는다
  const startPrep = useCallback(() => {
    setPrep({ step: 'openings', token: String(Date.now()) });
    setShowPlan(false);
    setTool('openings');
  }, []);
  const openingsDone = useCallback((result: AutoDetectResult) => {
    setPrep((p) => (p && p.step === 'openings' ? { ...p, step: 'fixtures', openings: result, bundleOf: (result.ok && result.callId) || undefined } : p));
    setTool('fixtures');
  }, []);
  const fixturesDone = useCallback((result: AutoDetectResult) => {
    setPrep((p) => (p && p.step === 'fixtures' ? { ...p, step: 'review', fixtures: result } : p));
    setTool('openings');
  }, []);
  const openingsAuto = useMemo<AutoDetect | undefined>(() => (prep?.step === 'openings' ? { token: prep.token, onDone: openingsDone } : undefined), [prep, openingsDone]);
  const fixturesAuto = useMemo<AutoDetect | undefined>(
    () => (prep?.step === 'fixtures' ? { token: prep.token, bundleOf: prep.bundleOf, onDone: fixturesDone } : undefined),
    [prep, fixturesDone],
  );

  // 방 준비의 확인 단계: 한 단계를 저장하면 아직 저장하지 않은 다음 단계로 넘어간다
  const prepReview = prep?.step === 'review';
  const saveOpeningsThenNext = useCallback(
    async (items: Opening[]) => {
      const ok = await saveOpenings(items);
      if (ok && prepReview && prepFixturesPendingRef.current) setTool('fixtures');
      return ok;
    },
    [saveOpenings, prepReview],
  );
  const saveFixturesThenNext = useCallback(
    async (items: Fixture[]) => {
      const ok = await saveFixtures(items);
      if (ok && prepReview && prepOpeningsPendingRef.current) setTool('openings');
      return ok;
    },
    [saveFixtures, prepReview],
  );

  // 원래 가구 도구가 평면도 그리기를 켜면 평면도를 연다
  const changePlanDraw = useCallback((handler: ((a: Point2, b: Point2) => void) | null) => {
    setPlanDraw(handler ? { onDraw: handler } : null);
    if (handler) setShowPlan(true);
  }, []);

  // 내 가구 만들기·지우기 (본인 권한으로 user_furniture에 직접)
  const createFurniture = useCallback((value: UserFurnitureValue) => createUserFurniture(createClient(), value), []);
  const deleteFurniture = useCallback((id: string) => deleteUserFurniture(createClient(), id), []);

  // 지금 보고 있는 배치를 저장한다 (새 배치면 "내 배치"를 만들고, 그다음부터는 같은 배치를 고친다)
  const saveLayout = useCallback(
    async (items: SavedItem[]) => {
      if (!roomId) return false;
      const id = await saveMyLayout(createClient(), roomId, layoutIdRef.current, items);
      if (!id) return false;
      layoutIdRef.current = id;
      setLayoutId(id);
      setLayouts((prev) =>
        prev.some((l) => l.id === id)
          ? prev.map((l) => (l.id === id ? { ...l, items } : l))
          : [{ id, name: MY_LAYOUT_NAME, createdBy: 'user', aiSummary: null, items }, ...prev],
      );
      return true;
    },
    [roomId],
  );

  // 다른 배치를 연다 (가구 층이 저장하지 않은 것을 먼저 저장한 뒤 부른다)
  const selectLayout = useCallback((id: string | null) => {
    layoutIdRef.current = id;
    setLayoutId(id);
    setLayoutNonce((n) => n + 1);
  }, []);

  // 지금 보고 있는 배치를 지우고, 남은 것 가운데 첫 배치(없으면 새 배치)를 연다
  const deleteLayout = useCallback(
    async (id: string) => {
      if (!(await deleteMyLayout(createClient(), id))) return false;
      const rest = layouts.filter((l) => l.id !== id);
      setLayouts(rest);
      setAiResult((prev) => (prev?.layoutId === id ? null : prev));
      if (layoutIdRef.current === id) selectLayout(rest[0]?.id ?? null);
      return true;
    },
    [layouts, selectLayout],
  );

  // AI 배치 추천: 성공하면 새로 저장된 AI 배치를 목록에 넣고 그 배치를 연다
  const suggestLayout = useCallback(
    async (items: SavedItem[], request: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!roomId) return { ok: false, message: '방을 찾을 수 없습니다.' };
      const outcome = await requestLayoutSuggestion(roomId, items, request);
      if (!outcome.ok) {
        if (outcome.code === 'AI_LIMIT') setAiRemaining(0);
        return { ok: false, message: outcome.message };
      }
      const removed = new Set(outcome.removedLayoutIds);
      setLayouts((prev) => [outcome.layout, ...prev.filter((l) => !removed.has(l.id) && l.id !== outcome.layout.id)]);
      setAiRemaining(outcome.remaining);
      setAiResult(outcome.result);
      selectLayout(outcome.layout.id);
      return { ok: true };
    },
    [roomId, selectLayout],
  );

  const currentLayout = layouts.find((l) => l.id === layoutId) ?? null;
  // 저장하지 않은 보정 위에서는 추천할 수 없다 (서버는 저장된 평면도로 계산한다)
  const aiBlocked = roomPolygonKey !== savedPolygonKey ? '보정을 저장한 뒤에 AI 추천을 쓸 수 있습니다.' : null;

  // 지금 쓸 수 있는 도구와 고른 도구
  const ready = stats.status === 'ready';
  const calibrated = ready && room?.key === sceneKey;
  useEffect(() => {
    // 보정된 방은 m 단위이므로 걷는 빠르기가 정해져 있다
    walkSpeedRef.current = calibrated ? WALK_SPEED : rawSpeedRef.current;
  }, [calibrated, ready, sceneKey]);
  const roomPolygon = calibrated && room ? room.polygon : null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !roomPolygon || !stayInside) {
      boundsRef.current = null;
      return;
    }
    boundsRef.current = { polygon: roomPolygon, ceilingY: engine.splat ? sceneTopY(engine.splat) : null };
  }, [roomPolygon, stayInside]);
  const tools: ToolId[] = [];
  if (calibrated) tools.push('furniture', 'openings', 'fixtures');
  // 보정 도구: 개발용 뷰어(/viewer)에서는 누구나, 방 화면에서는 방 주인만
  if (ready && (!url || canEdit)) tools.push('calibration');
  if (ready && roomId) tools.push('analysis');
  const wanted = tool ?? (calibration ? 'furniture' : 'calibration');
  const active = tools.includes(wanted) ? wanted : (tools[0] ?? null);
  const slots: Slots = { panel: panelEl, stage: stageEl, active };
  const calibrationUnsaved = Boolean(roomId) && calibrated && roomPolygonKey !== savedPolygonKey;
  const openingsUnsaved = Boolean(roomId) && canEdit && liveOpenings !== null && liveOpenings.key === roomPolygonKey && !sameOpenings(liveOpenings.items, savedOpenings);
  const fixturesUnsaved = Boolean(roomId) && canEdit && liveFixtures !== null && liveFixtures.key === roomPolygonKey && !sameFixtures(liveFixtures.items, savedFixtures);
  useEffect(() => {
    prepOpeningsPendingRef.current = openingsUnsaved;
    prepFixturesPendingRef.current = fixturesUnsaved;
  });

  const selectTool = (next: ToolId) => {
    // 폰에서 고른 탭을 다시 누르면 패널을 접었다 편다
    setSheetClosed(next === active ? (closed) => !closed : false);
    setTool(next);
  };

  return (
    <div className="flex h-full w-full flex-col bg-ground lg:flex-row lg:gap-3 lg:p-3" data-testid="workspace" data-tool={active ?? ''}>
      <ToolRail
        tools={tools}
        active={active}
        onSelect={selectTool}
        marks={{
          ...(calibrationUnsaved ? { calibration: 'warn' as const } : {}),
          ...(openingsUnsaved ? { openings: 'warn' as const } : {}),
          ...(fixturesUnsaved ? { fixtures: 'warn' as const } : {}),
          ...(hasReport ? { analysis: 'ok' as const } : {}),
        }}
      />

      <aside
        className={`relative order-2 flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface max-lg:-mt-5 max-lg:max-h-[48%] max-lg:rounded-t-[22px] max-lg:shadow-[0_-6px_24px_rgb(20_26_42/0.1)] lg:w-[376px] lg:rounded-2xl lg:shadow-panel ${
          tools.length === 0 ? 'max-lg:hidden' : ''
        }`}
        data-testid="tool-panel"
        data-closed={sheetClosed}
      >
        <button
          type="button"
          className="flex h-7 shrink-0 items-center justify-center lg:hidden"
          onClick={() => setSheetClosed((closed) => !closed)}
          aria-pressed={sheetClosed}
          aria-label={sheetClosed ? '패널 펼치기' : '패널 접기'}
          data-testid="panel-compact"
        >
          <span className="h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
        </button>
        {prep && calibrated && (
          <RoomPrepBanner
            prep={prep}
            active={active}
            saved={{ openings: !openingsUnsaved, fixtures: !fixturesUnsaved }}
            hidden={sheetClosed}
            onSelect={(next) => {
              // 단계 버튼은 패널을 접지 않고 그 도구를 연다
              setSheetClosed(false);
              setTool(next);
            }}
            onFinish={() => {
              setPrep(null);
              setSheetClosed(false);
              setTool('furniture');
            }}
            onClose={() => setPrep(null)}
          />
        )}
        <div ref={setPanelEl} className={`flex min-h-0 flex-1 flex-col ${sheetClosed ? 'max-lg:hidden' : ''}`}>
          {tools.length === 0 && <p className="p-5 text-sm text-sub">{stats.status === 'error' ? '3D 파일을 열지 못했습니다.' : '3D를 불러오는 중입니다…'}</p>}
        </div>
      </aside>

      <div className="relative order-1 min-h-0 flex-1 overflow-hidden bg-[#e9ecf1] lg:order-3 lg:rounded-2xl lg:shadow-panel" data-testid="stage">
        <div ref={containerRef} className="absolute inset-0 touch-none" />

        {/* 도구들이 3D 위에 띄우는 것 (평면도, 보기 전환, 고른 가구의 띠) */}
        <div ref={setStageEl} className="pointer-events-none absolute inset-0 *:pointer-events-auto" />

        {/* 3D에 보이는 표시(문·창문 판, 원래 가구 상자) 켜고 끄기 */}
        {ready && calibrated && !showPlan && (shownOpenings.length > 0 || shownFixtures.length > 0) && (
          <div ref={markersRef} className="absolute top-3 right-3 flex flex-col items-end gap-2" data-testid="markers">
            <button
              type="button"
              className="flex h-11 items-center gap-2 rounded-xl bg-surface px-3.5 text-[13px] font-medium shadow-float hover:bg-soft"
              aria-expanded={markersOpen}
              onClick={() => setMarkersOpen((v) => !v)}
              data-testid="markers-toggle"
            >
              <Icon name="eye" />
              표시
            </button>
            {markersOpen && (
              <div className="flex w-56 flex-col gap-1 rounded-xl bg-surface p-2 text-[13px] shadow-float" data-testid="markers-menu">
                {(
                  [
                    ['openings', '문·창문', shownOpenings.length],
                    ['fixtures', '원래 가구 상자', shownFixtures.length],
                  ] as const
                ).map(([key, label, count]) =>
                  count > 0 ? (
                    <button
                      key={key}
                      type="button"
                      role="switch"
                      aria-checked={markers[key]}
                      className="flex h-10 items-center justify-between gap-2 rounded-[10px] px-2.5 hover:bg-soft"
                      onClick={() => changeMarkers({ ...markers, [key]: !markers[key] })}
                      data-testid={`show-${key}`}
                    >
                      <span>
                        {label} <span className="font-mono text-mute">{count}</span>
                      </span>
                      <span className={`rounded-full px-2 py-px text-[11px] font-semibold ${markers[key] ? 'bg-accent-soft text-accent-strong' : 'bg-chip text-sub'}`}>{markers[key] ? '보임' : '숨김'}</span>
                    </button>
                  ) : null,
                )}
                <p className="px-2.5 pt-1 pb-1.5 text-xs text-sub">숨겨도 그 도구를 쓰는 동안에는 보이고, 평면도와 배치 검사에는 그대로 쓰입니다.</p>
              </div>
            )}
          </div>
        )}

        {/* 개발용 뷰어(/viewer): 파일 열기. 방 화면에서는 주소에 ?debug 를 붙였을 때만 수치를 보여준다 */}
        <div
          className={
            !url || debug
              ? 'absolute top-3 right-3 max-w-[min(22rem,calc(100%-1.5rem))] space-y-2 rounded-xl bg-surface/95 p-3 text-xs text-ink-2 shadow-float'
              : 'sr-only'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {!url && (
              <>
                <input
                  className="field h-8 w-56 max-w-full rounded-lg px-2 text-xs"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="SPZ / PLY URL"
                  aria-label="3D 파일 주소"
                />
                <button className="btn btn-soft h-8 rounded-lg px-2.5 text-xs" onClick={() => load({ kind: 'url', url: urlInput })}>
                  URL 열기
                </button>
                <label className="btn btn-soft h-8 cursor-pointer rounded-lg px-2.5 text-xs">
                  파일 열기
                  <input
                    type="file"
                    accept=".spz,.ply,.rad,.sog,.zip"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) load({ kind: 'file', file });
                      e.target.value = '';
                    }}
                  />
                </label>
              </>
            )}
            {/* 저장된 보정은 뒤집기 상태까지 포함하므로 보정된 방에서는 바꾸지 않는다 */}
            {!calibration && (
              <button className="btn btn-soft h-8 rounded-lg px-2.5 text-xs" onClick={toggleFlip}>
                X축 180° {flipped ? 'ON' : 'OFF'}
              </button>
            )}
          </div>
          <div className="font-mono" data-testid="viewer-stats">
            <div>
              상태: {stats.status}
              {stats.error ? ` (${stats.error})` : ''}
            </div>
            <div className="truncate">파일: {name ?? stats.name}</div>
            {stats.loadMs !== undefined && (
              <div data-testid="viewer-load-time" data-load-ms={Math.round(stats.loadMs)} data-download-ms={stats.downloadMs === undefined ? '' : Math.round(stats.downloadMs)}>
                로딩: {(stats.loadMs / 1000).toFixed(2)}초
                {stats.downloadMs !== undefined &&
                  ` (받기 ${(stats.downloadMs / 1000).toFixed(1)}초 + 준비 ${((stats.loadMs - stats.downloadMs) / 1000).toFixed(1)}초)`}
              </div>
            )}
            {stats.numSplats !== undefined && (
              <div>
                스플랫: {stats.numSplats.toLocaleString()}개{stats.fromLodTree ? ' (LOD 트리)' : ''}
              </div>
            )}
            <div>FPS: {fps}</div>
            {drawn !== null && (
              <div data-testid="viewer-drawn" data-drawn={drawn} data-pixel-ratio={pixelRatio} data-motion={motionInfo}>
                그리는 중: {drawn.toLocaleString()}개 · 배율 {pixelRatio} · {motionInfo}
              </div>
            )}
          </div>
        </div>

        {stats.status === 'loading' && loadProgress && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            data-testid="viewer-loading"
            data-phase={loadProgress.phase}
            data-percent={loadProgress.percent ?? ''}
          >
            <div className="w-72 max-w-[80%] space-y-3 rounded-2xl bg-surface p-5 text-center text-sm font-semibold shadow-float" role="status">
              <p>{loadingLabel(loadProgress)}</p>
              <progress className="h-2 w-full accent-accent" max={100} value={loadingBarValue(loadProgress)} />
            </div>
          </div>
        )}

        {stats.status === 'error' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <p className="rounded-2xl bg-surface px-5 py-4 text-sm text-danger shadow-float" role="alert">
              3D 파일을 열지 못했습니다. 새로고침해 보세요.
            </p>
          </div>
        )}

        {/* 아래 줄: 보정 상태와 출처 */}
        {ready && (
          <div className="pointer-events-none absolute inset-x-3 bottom-7 flex flex-col items-start gap-1.5 text-xs text-ink-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between lg:bottom-3 lg:flex-nowrap">
            <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0 lg:flex-nowrap">
              {calibrated ? (
                <span className="flex items-center gap-2 rounded-full bg-surface/95 px-3 py-1.5" data-testid="stage-calibrated">
                  <span className="h-[7px] w-[7px] rounded-full bg-ok-dot" aria-hidden="true" />
                  크기 보정됨 <span className="font-mono">(m)</span>
                </span>
              ) : (
                <span className="flex items-center gap-2 rounded-full bg-surface/95 px-3 py-1.5" data-testid="stage-uncalibrated">
                  <span className="h-[7px] w-[7px] rounded-full bg-warn-dot" aria-hidden="true" />
                  {canEdit || !url ? '크기 보정을 하면 가구를 놓을 수 있습니다' : '아직 크기 보정을 하지 않은 방입니다'}
                </span>
              )}
              {calibrated && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={stayInside}
                  onClick={() => setStayInside((v) => !v)}
                  className="pointer-events-auto flex items-center gap-2 rounded-full bg-surface/95 px-3 py-1.5 hover:bg-surface"
                  title={stayInside ? '카메라가 벽·바닥·천장 밖으로 나가지 않습니다. 누르면 풉니다.' : '카메라가 방 밖으로도 나갑니다. 누르면 방 안에 머뭅니다.'}
                  data-testid="stay-inside"
                >
                  방 안에서만
                  <span className={`rounded-full px-1.5 py-px text-[11px] font-semibold ${stayInside ? 'bg-accent-soft text-accent-strong' : 'bg-chip text-sub'}`}>{stayInside ? '켬' : '끔'}</span>
                </button>
              )}
              {/* 키보드가 있는 넓은 화면에서만: 걸어 다니는 키 안내 (좁으면 아래 줄이 두 줄이 되어 고른 가구 띠를 가린다) */}
              <span className="hidden items-center gap-1.5 rounded-full bg-surface/95 px-3 py-1.5 whitespace-nowrap xl:flex" data-testid="stage-keys">
                이동 <kbd className="font-mono text-ink">W A S D</kbd>
                <span className="text-mute" aria-hidden="true">·</span>
                높이 <kbd className="font-mono text-ink">Q E</kbd>
                <span className="text-mute" aria-hidden="true">·</span>
                빠르게 <kbd className="font-mono text-ink">Shift</kbd>
              </span>
            </div>
            {credit && (
              <span className="max-w-full truncate rounded-full bg-surface/95 px-3 py-1.5 sm:max-w-[60%] lg:max-w-none lg:min-w-0" data-testid="room-credit" title={credit}>
                출처: {credit}
              </span>
            )}
          </div>
        )}
      </div>

      {calibrated && room && (
        <FurnitureLayer
          key={`furniture|${sceneKey}|${layoutNonce}`}
          slots={slots}
          showPlan={showPlan}
          onShowPlan={setShowPlan}
          engineRef={engineRef}
          floorPolygon={room.polygon}
          catalog={catalog}
          openings={shownOpenings}
          aiOpeningKeys={liveOpenings && liveOpenings.key === roomPolygonKey ? liveOpenings.aiKeys : NO_KEYS}
          fixtures={shownFixtures}
          onDrawFixture={planDraw?.onDraw}
          userFurniture={userFurniture}
          onCreateFurniture={roomId && signedIn ? createFurniture : undefined}
          onDeleteFurniture={roomId && signedIn ? deleteFurniture : undefined}
          initialItems={currentLayout?.items}
          onSave={roomId && signedIn ? saveLayout : undefined}
          loginHint={Boolean(roomId) && !signedIn}
          layouts={layouts}
          currentLayoutId={layoutId}
          onSelectLayout={roomId && signedIn ? selectLayout : undefined}
          onDeleteLayout={roomId && signedIn ? deleteLayout : undefined}
          onSuggest={roomId && signedIn ? suggestLayout : undefined}
          aiRemaining={aiRemaining}
          aiBlocked={aiBlocked}
          aiResult={aiResult && aiResult.layoutId === layoutId ? aiResult : null}
          aiSummary={currentLayout?.aiSummary ?? null}
        />
      )}
      {calibrated && room && (
        <OpeningsTool
          key={`openings|${sceneKey}|${roomPolygonKey}`}
          slots={slots}
          engineRef={engineRef}
          floorPolygon={room.polygon}
          initial={savedOpenings}
          onChange={(items, aiKeys) => setLiveOpenings({ key: roomPolygonKey, items, aiKeys })}
          onLook={() => setShowPlan(false)}
          editable={!url || canEdit}
          locked={Boolean(roomId) && roomPolygonKey !== savedPolygonKey}
          onSave={roomId && canEdit ? saveOpeningsThenNext : undefined}
          detect={roomId && canEdit && signedIn ? { roomId, remaining: aiRemaining, onRemaining: setAiRemaining } : undefined}
          auto={openingsAuto}
          shown={markers.openings}
        />
      )}
      {calibrated && room && (
        <FixturesTool
          key={`fixtures|${sceneKey}|${roomPolygonKey}`}
          slots={slots}
          engineRef={engineRef}
          floorPolygon={room.polygon}
          initial={savedFixtures}
          onChange={(items) => setLiveFixtures({ key: roomPolygonKey, items })}
          onLook={() => setShowPlan(false)}
          onPlanDraw={changePlanDraw}
          editable={!url || canEdit}
          locked={Boolean(roomId) && roomPolygonKey !== savedPolygonKey}
          onSave={roomId && canEdit ? saveFixturesThenNext : undefined}
          detect={roomId && canEdit && signedIn ? { roomId, remaining: aiRemaining, onRemaining: setAiRemaining } : undefined}
          auto={fixturesAuto}
          shown={markers.fixtures}
        />
      )}
      {/* 방 분석: 리포트는 방을 볼 수 있으면 누구나, 분석은 방 주인만 */}
      {ready && roomId && (
        <AnalysisPanel
          slots={slots}
          engineRef={engineRef}
          roomId={roomId}
          floorPolygon={calibrated && room ? room.polygon : null}
          canAnalyze={canEdit && signedIn}
          initialReport={initialReport}
          aiRemaining={aiRemaining}
          onRemaining={setAiRemaining}
          onReport={() => setHasReport(true)}
        />
      )}
      {ready && (!url || canEdit) && (
        <CalibrationTool
          key={sceneKey}
          slots={slots}
          engineRef={engineRef}
          initial={url && calibration ? { transform: calibration.transform, floorPolygon: calibration.floorPolygon } : null}
          onSave={roomId && canEdit ? saveCalibration : undefined}
          onPrepare={roomId && canEdit && signedIn && aiRemaining !== 0 ? startPrep : undefined}
          onApplied={(polygon) => setRoom(polygon ? { key: sceneKey, polygon } : null)}
        />
      )}
    </div>
  );
}

/** 스플랫 중심점의 2~98% 분위 범위로 경계 상자를 구한다 (스캔 가장자리의 튀는 점 제외). */
function robustBounds(packed: PackedSplats, maxSamples = 200_000): THREE.Box3 | null {
  const n = packed.numSplats;
  if (!n) return null;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  packed.forEachSplat((i, center) => {
    if (i % step !== 0) return;
    xs.push(center.x);
    ys.push(center.y);
    zs.push(center.z);
  });
  const q = (arr: number[], t: number) => {
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
  };
  const min = new THREE.Vector3(q(xs, 0.02), q(ys, 0.02), q(zs, 0.02));
  const max = new THREE.Vector3(q(xs, 0.98), q(ys, 0.98), q(zs, 0.98));
  return new THREE.Box3(min, max);
}

/** 스캔의 맨 위 높이(지금 좌표 기준). 보정된 방에서는 천장 높이(m)쯤이다 */
function sceneTopY(splat: SplatMesh): number | null {
  const packed = splat.packedSplats;
  const source = packed?.numSplats ? packed : packed?.lodSplats;
  const box = source ? robustBounds(source) : null;
  if (!box || box.isEmpty()) return null;
  splat.updateWorldMatrix(true, false);
  box.applyMatrix4(splat.matrixWorld);
  return Number.isFinite(box.max.y) ? box.max.y : null;
}

/** 장면 전체가 보이는 자리로 카메라를 옮기고 장면의 크기(대각선 길이)를 돌려준다 */
function frameCamera(engine: Engine, splat: SplatMesh): number | null {
  const packed = splat.packedSplats;
  const source = packed?.numSplats ? packed : packed?.lodSplats;
  const box = source ? robustBounds(source) : null;
  if (!box || box.isEmpty()) return null;
  splat.updateMatrixWorld(true);
  box.applyMatrix4(splat.matrixWorld);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());
  const size = extent.length();
  engine.controls.target.copy(center);
  // 방 안에서 둘러보는 구도: 방 가운데를 보면서, 긴 쪽으로 조금 물러난 눈높이쯤에 선다.
  // (밖에서 보면 벽 뒷면의 큰 스플랫에 가려 흐리게 보인다)
  const alongX = extent.x >= extent.z;
  const back = (alongX ? extent.x : extent.z) * 0.3;
  engine.camera.position.copy(center).add(new THREE.Vector3(alongX ? back : 0, extent.y * 0.1, alongX ? 0 : back));
  engine.camera.near = Math.max(0.01, size / 1000);
  engine.camera.far = Math.max(100, size * 10);
  engine.camera.updateProjectionMatrix();
  engine.controls.update();
  return size;
}

/** 3D에 보일 표시 */
type Markers = { openings: boolean; fixtures: boolean };
const MARKERS_KEY = 'roomlens.markers';

/** 브라우저에 기억해 둔 표시 설정 (없거나 읽지 못하면 모두 보임) */
function readMarkers(): Markers {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MARKERS_KEY) ?? 'null') as Partial<Markers> | null;
    return { openings: saved?.openings !== false, fixtures: saved?.fixtures !== false };
  } catch {
    return { openings: true, fixtures: true };
  }
}

function writeMarkers(markers: Markers) {
  try {
    window.localStorage.setItem(MARKERS_KEY, JSON.stringify(markers));
  } catch {
    // 저장할 수 없는 브라우저(사생활 보호 모드 등)에서는 이번에만 적용된다
  }
}
