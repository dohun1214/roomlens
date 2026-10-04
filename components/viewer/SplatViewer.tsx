'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isMobile, SparkRenderer, SplatMesh, type PackedSplats } from '@sparkjsdev/spark';
import CalibrationTool, { type AppliedCalibration } from './CalibrationTool';
import OpeningsTool from './OpeningsTool';
import FurnitureLayer from '@/components/layout/FurnitureLayer';
import type { Point2 } from '@/lib/three/floorDrag';
import type { CatalogItem } from '@/lib/layout/catalog';
import type { SavedItem } from '@/lib/layout/saved';
import { saveMyLayout, type SavedLayout } from '@/lib/layout/store';
import type { Engine } from './engine';
import { pickPoint } from '@/lib/three/pickPoint';
import { setObjectRoomTransform } from '@/lib/three/roomTransform';
import { startPoseForRoom, toCalibrationColumns, type SavedCalibration } from '@/lib/rooms/calibration';
import type { Opening } from '@/lib/rooms/openings';
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
  /** 이 방에 내가 저장해 둔 배치 */
  initialLayout?: SavedLayout | null;
  /** 방에 저장된 문·창문 (저장된 보정의 벽 기준) */
  initialOpenings?: Opening[];
};

const NO_OPENINGS: Opening[] = [];

export default function SplatViewer({
  url,
  name,
  calibration = null,
  roomId,
  canEdit = false,
  catalog,
  signedIn = false,
  initialLayout = null,
  initialOpenings = NO_OPENINGS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const loadSeq = useRef(0);
  const flippedRef = useRef(calibration?.flipX ?? false);
  const calibrationRef = useRef(calibration);
  // 저장된 배치. 보정을 다시 해서 가구 층이 새로 만들어져도 마지막으로 저장한 배치에서 시작하게 여기에 둔다
  const [layout, setLayout] = useState<SavedLayout | null>(initialLayout);
  const layoutIdRef = useRef(initialLayout?.id ?? null);
  // 문·창문은 벽 번호로 저장하므로 "어느 평면도 기준인지"를 함께 기억한다. 보정을 새로 저장하면 비운다
  const [savedPolygonKey, setSavedPolygonKey] = useState(calibration ? JSON.stringify(calibration.floorPolygon) : null);
  const savedPolygonKeyRef = useRef(savedPolygonKey);
  const [openings, setOpenings] = useState({ key: savedPolygonKey, items: initialOpenings });
  // 화면에서 넣거나 지운(아직 저장 전일 수 있는) 문·창문. 가구 검사는 이것을 쓴다
  const [liveOpenings, setLiveOpenings] = useState<{ key: string | null; items: Opening[] } | null>(null);
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
    scene.background = new THREE.Color(0x111111);
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

    let frames = 0;
    let last = performance.now();
    renderer.setAnimationLoop(() => {
      controls.update();
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
      Object.assign(window, { __roomlens: engineRef.current, __roomlensPick: pickPoint });
    }

    return () => {
      ro.disconnect();
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
        setRoom({ key: `${name}|${loadMs}|${flippedRef.current}`, polygon: saved.floorPolygon });
      } else {
        frameCamera(engine, splat);
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

  // 방 주인이 보정을 저장한다 (transform·floor_polygon은 방 주인이 직접 바꿀 수 있는 컬럼)
  const saveCalibration = useCallback(
    async (applied: AppliedCalibration) => {
      if (!roomId) return false;
      // 평면도가 바뀌면 벽 번호가 달라지므로 문·창문도 함께 비운다
      const key = JSON.stringify(applied.floorPolygon);
      const wallsChanged = key !== savedPolygonKeyRef.current;
      const { data, error } = await createClient()
        .from('rooms')
        .update({ ...toCalibrationColumns({ ...applied, flipX: flippedRef.current }), ...(wallsChanged ? { openings: [] } : {}) })
        .eq('id', roomId)
        .select('id')
        .maybeSingle();
      if (error || data === null) return false;
      savedPolygonKeyRef.current = key;
      setSavedPolygonKey(key);
      if (wallsChanged) {
        setOpenings({ key, items: [] });
        setLiveOpenings(null);
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

  // 내 배치를 저장한다 (처음이면 새로 만들고, 그다음부터는 같은 배치를 고친다)
  const saveLayout = useCallback(
    async (items: SavedItem[]) => {
      if (!roomId) return false;
      const id = await saveMyLayout(createClient(), roomId, layoutIdRef.current, items);
      if (!id) return false;
      layoutIdRef.current = id;
      setLayout({ id, items });
      return true;
    },
    [roomId],
  );

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0 touch-none" />

      <div className="absolute left-2 top-2 max-w-[calc(100%-1rem)] space-y-2 rounded bg-black/70 p-3 text-xs text-white">
        <div className="flex flex-wrap items-center gap-2">
          {!url && (
            <>
          <input
            className="w-64 max-w-full rounded bg-white/10 px-2 py-1"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="SPZ / PLY URL"
          />
          <button
            className="rounded bg-white/20 px-2 py-1"
            onClick={() => load({ kind: 'url', url: urlInput })}
          >
            URL 열기
          </button>
          <label className="cursor-pointer rounded bg-white/20 px-2 py-1">
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
            <button className="rounded bg-white/20 px-2 py-1" onClick={toggleFlip}>
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
          <div className="w-64 max-w-[80%] space-y-2 rounded bg-black/70 p-4 text-center text-sm text-white" role="status">
            <p>{loadingLabel(loadProgress)}</p>
            <progress className="w-full" max={100} value={loadingBarValue(loadProgress)} />
          </div>
        </div>
      )}

      {stats.status === 'ready' && room?.key === sceneKey && (
        <FurnitureLayer
          key={`furniture|${sceneKey}`}
          engineRef={engineRef}
          floorPolygon={room.polygon}
          catalog={catalog}
          openings={shownOpenings}
          initialItems={layout?.items}
          onSave={roomId && signedIn ? saveLayout : undefined}
          loginHint={Boolean(roomId) && !signedIn}
        />
      )}
      {stats.status === 'ready' && room?.key === sceneKey && (
        <OpeningsTool
          key={`openings|${sceneKey}|${roomPolygonKey}`}
          engineRef={engineRef}
          floorPolygon={room.polygon}
          initial={savedOpenings}
          onChange={(items) => setLiveOpenings({ key: roomPolygonKey, items })}
          editable={!url || canEdit}
          locked={Boolean(roomId) && roomPolygonKey !== savedPolygonKey}
          onSave={roomId && canEdit ? saveOpenings : undefined}
        />
      )}
      {/* 보정 도구: 개발용 뷰어(/viewer)에서는 누구나, 방 화면에서는 방 주인만 */}
      {stats.status === 'ready' && (!url || canEdit) && (
        <CalibrationTool
          key={sceneKey}
          engineRef={engineRef}
          initial={url && calibration ? { transform: calibration.transform, floorPolygon: calibration.floorPolygon } : null}
          onSave={roomId && canEdit ? saveCalibration : undefined}
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

function frameCamera(engine: Engine, splat: SplatMesh) {
  const packed = splat.packedSplats;
  const source = packed?.numSplats ? packed : packed?.lodSplats;
  const box = source ? robustBounds(source) : null;
  if (!box || box.isEmpty()) return;
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
}
