'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh, type PackedSplats } from '@sparkjsdev/spark';
import CalibrationTool from './CalibrationTool';
import type { Engine } from './engine';
import { pickPoint } from '@/lib/three/pickPoint';

export const SAMPLE_SPLAT_URL = 'https://sparkjs.dev/assets/splats/fireplace.spz';

type Source = { kind: 'url'; url: string } | { kind: 'file'; file: File };

type Stats = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  name: string;
  loadMs?: number;
  numSplats?: number;
  fromLodTree?: boolean;
  error?: string;
};

// X축 180° 회전 (OpenCV 좌표계 → OpenGL 좌표계)
const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);
const IDENTITY = new THREE.Quaternion();

export default function SplatViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const loadSeq = useRef(0);
  const flippedRef = useRef(false);
  const [stats, setStats] = useState<Stats>({ status: 'idle', name: '' });
  const [fps, setFps] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [urlInput, setUrlInput] = useState(
    () => new URLSearchParams(window.location.search).get('url') || SAMPLE_SPLAT_URL,
  );

  // three.js + Spark 초기화 (한 번만)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    const spark = new SparkRenderer({ renderer, lodRaycast: 0 });
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
    const t0 = performance.now();

    try {
      const splat =
        source.kind === 'url'
          ? new SplatMesh({ url: source.url, lod: true })
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

      frameCamera(engine, splat);

      // lod: true 이면 원본 배열은 비고 LOD 트리(lodSplats)만 남는다.
      const packed = splat.packedSplats;
      const original = packed?.numSplats ?? 0;
      const lodTree = packed?.lodSplats?.numSplats ?? 0;
      setStats({
        status: 'ready',
        name,
        loadMs,
        numSplats: original || lodTree,
        fromLodTree: !original && lodTree > 0,
      });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      console.error(err);
      setStats({ status: 'error', name, error: String(err) });
    }
  }, []);

  // 첫 로드: ?url= 이 있으면 그 파일, 없으면 샘플
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 외부 시스템(스플랫 로딩) 시작
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

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0 touch-none" />

      <div className="absolute left-2 top-2 max-w-[calc(100%-1rem)] space-y-2 rounded bg-black/70 p-3 text-xs text-white">
        <div className="flex flex-wrap items-center gap-2">
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
          <button className="rounded bg-white/20 px-2 py-1" onClick={toggleFlip}>
            X축 180° {flipped ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="font-mono" data-testid="viewer-stats">
          <div>
            상태: {stats.status}
            {stats.error ? ` (${stats.error})` : ''}
          </div>
          <div className="truncate">파일: {stats.name}</div>
          {stats.loadMs !== undefined && <div>로딩: {(stats.loadMs / 1000).toFixed(2)}초</div>}
          {stats.numSplats !== undefined && (
            <div>
              스플랫: {stats.numSplats.toLocaleString()}개{stats.fromLodTree ? ' (LOD 트리)' : ''}
            </div>
          )}
          <div>FPS: {fps}</div>
        </div>
      </div>

      {stats.status === 'ready' && (
        <CalibrationTool key={`${stats.name}|${stats.loadMs}|${flipped}`} engineRef={engineRef} />
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
  const size = box.getSize(new THREE.Vector3()).length();
  engine.controls.target.copy(center);
  engine.camera.position.copy(center).add(new THREE.Vector3(0, size * 0.2, size * 0.7));
  engine.camera.near = Math.max(0.01, size / 1000);
  engine.camera.far = Math.max(100, size * 10);
  engine.camera.updateProjectionMatrix();
  engine.controls.update();
}
