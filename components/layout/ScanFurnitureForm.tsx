'use client';

// 3D 스캔(GLB)으로 내 가구 만들기: 파일 고르기 → 함께 찍힌 바닥을 빨갛게 보여 주며 지우기(높이 조절) →
// 이름·치수(모델에서 잰 값, 고칠 수 있음) → 다듬은 GLB를 서버로. 원본 파일은 브라우저 밖으로 나가지 않는다.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseUserFurnitureForm, USER_FURNITURE_NAME_MAX, type UserFurnitureForm, type UserFurnitureValue } from '@/lib/layout/userFurniture';
import { DEFAULT_FLOOR_CUT, MAX_FLOOR_CUT } from '@/lib/scan/floor';
import { checkGlb, MAX_SCAN_INPUT_BYTES, MAX_SCAN_MODEL_BYTES } from '@/lib/scan/glb';
import { disposePrepared, disposeScan, exportScan, loadScan, prepareScan, SCAN_TEXTURE_FALLBACK, SCAN_TEXTURE_MAX, type LoadedScan, type PreparedScan } from '@/lib/three/scanModel';

type Props = {
  onCreate: (glb: Blob, value: UserFurnitureValue) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
};

const fieldClass = 'field h-10 rounded-[10px] px-3 text-sm';
const cm = (m: number) => String(Math.max(1, Math.round(m * 100)));
const sizeForm = (p: PreparedScan) => ({ width: cm(p.size.w), depth: cm(p.size.d), height: cm(p.size.h) });

export default function ScanFurnitureForm({ onCreate, onClose }: Props) {
  const [scan, setScan] = useState<LoadedScan | null>(null);
  const [cut, setCut] = useState(DEFAULT_FLOOR_CUT);
  const [prepared, setPrepared] = useState<PreparedScan | null>(null);
  const [form, setForm] = useState<UserFurnitureForm>({ name: '', width: '', depth: '', height: '' });
  // 치수를 손으로 고쳤으면 바닥 높이를 바꿔도 덮어쓰지 않는다
  const [sizeEdited, setSizeEdited] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'reading' | 'ready' | 'saving'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; holder: THREE.Group } | null>(null);
  const shownRef = useRef<PreparedScan | null>(null);
  const shownScanRef = useRef<LoadedScan | null>(null);
  // 다 쓴 모델을 정리하려고 지금 것을 따로 들고 있는다
  const scanRef = useRef<LoadedScan | null>(null);
  const preparedRef = useRef<PreparedScan | null>(null);

  // 파일 고르기
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    if (file.size > MAX_SCAN_INPUT_BYTES) {
      setMessage(`파일이 너무 큽니다 (${MAX_SCAN_INPUT_BYTES / 1024 / 1024}MB까지).`);
      return;
    }
    setPhase('reading');
    try {
      const buffer = await file.arrayBuffer();
      const head = checkGlb(new Uint8Array(buffer), MAX_SCAN_INPUT_BYTES);
      if (!head.ok) throw new Error(head.message);
      const loaded = await loadScan(buffer);
      if (loaded.triangles === 0) throw new Error('모델에 그릴 면이 없습니다.');
      const next = prepareScan(loaded, cut);
      if (preparedRef.current) disposePrepared(preparedRef.current);
      if (scanRef.current) disposeScan(scanRef.current);
      scanRef.current = loaded;
      preparedRef.current = next;
      setScan(loaded);
      setPrepared(next);
      setSizeEdited(false);
      setForm((f) => ({ ...f, ...sizeForm(next), name: f.name || file.name.replace(/\.glb$/i, '').slice(0, USER_FURNITURE_NAME_MAX) }));
      setPhase('ready');
    } catch (err) {
      setPhase('idle');
      setMessage(err instanceof Error && /[가-힣]/.test(err.message) ? err.message : '모델을 읽지 못했습니다. Scaniverse에서 GLB로 내보낸 파일인지 확인해 주세요.');
    }
  };

  // 닫을 때 텍스처·지오메트리를 정리한다
  useEffect(
    () => () => {
      if (preparedRef.current) disposePrepared(preparedRef.current);
      if (scanRef.current) disposeScan(scanRef.current);
    },
    [],
  );

  // 미리보기 화면 (모델을 고른 뒤 canvas가 생기면 한 번 만든다)
  const showing = Boolean(scan && prepared);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showing) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f4f8);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.5;
    const holder = new THREE.Group();
    scene.add(holder);
    const grid = new THREE.GridHelper(2, 20, 0xc4c9d6, 0xdde1ea);
    scene.add(grid);
    stageRef.current = { scene, camera, controls, holder };
    let frame = 0;
    const loop = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      }
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      controls.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      stageRef.current = null;
      shownRef.current = null;
    };
  }, [showing]);

  // 다듬은 모델을 미리보기에 넣고 카메라를 맞춘다 (새 파일이면 카메라도 다시)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !prepared) return;
    stage.holder.clear();
    stage.holder.add(prepared.object, prepared.removedObject);
    const first = shownRef.current === null || shownScanRef.current !== scan;
    shownRef.current = prepared;
    shownScanRef.current = scan;
    if (first) {
      const radius = Math.max(prepared.size.w, prepared.size.h, prepared.size.d, 0.2);
      stage.controls.target.set(0, prepared.size.h / 2, 0);
      stage.camera.position.set(radius * 1.4, prepared.size.h / 2 + radius * 0.9, radius * 1.4);
    }
  }, [prepared, scan, showing]);

  // 바닥 높이를 바꾸면 다시 다듬는다 (치수를 손으로 고치지 않았으면 치수도 다시)
  const changeCut = (value: number) => {
    setCut(value);
    if (!scan) return;
    const next = prepareScan(scan, value);
    if (preparedRef.current) disposePrepared(preparedRef.current);
    preparedRef.current = next;
    setPrepared(next);
    if (!sizeEdited) setForm((f) => ({ ...f, ...sizeForm(next) }));
  };

  const create = async () => {
    if (!prepared || phase === 'saving') return;
    const parsed = parseUserFurnitureForm(form);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    setPhase('saving');
    setMessage(null);
    try {
      let glb = await exportScan(prepared, SCAN_TEXTURE_MAX);
      if (glb.byteLength > MAX_SCAN_MODEL_BYTES) glb = await exportScan(prepared, SCAN_TEXTURE_FALLBACK);
      if (glb.byteLength > MAX_SCAN_MODEL_BYTES) {
        setMessage('모델이 너무 큽니다. Scaniverse에서 더 가볍게(면 수를 줄여) 내보내 주세요.');
        setPhase('ready');
        return;
      }
      const result = await onCreate(new Blob([glb], { type: 'model/gltf-binary' }), parsed.value);
      if (!result.ok) {
        setMessage(result.message);
        setPhase('ready');
        return;
      }
      onClose();
    } catch (err) {
      console.error(err);
      setMessage('모델을 만들지 못했습니다. 다시 해 주세요.');
      setPhase('ready');
    }
  };

  const floorFound = Boolean(scan?.plane);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-ground p-3" data-testid="scan-furniture-form" data-phase={phase}>
      <p className="text-[13px] text-sub">Scaniverse의 메시(Mesh)로 찍어 GLB로 내보낸 파일을 고르세요. 함께 찍힌 바닥은 지우고, 크기는 모델에서 잽니다.</p>
      <label className="btn btn-outline h-10 cursor-pointer text-[13px]">
        {scan ? '다른 파일 고르기' : 'GLB 파일 고르기'}
        <input type="file" accept=".glb,model/gltf-binary" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} data-testid="scan-file" />
      </label>
      {phase === 'reading' && <p className="text-[13px] text-sub">모델을 읽는 중…</p>}
      {scan && prepared && (
        <>
          <canvas
            ref={canvasRef}
            className="h-[220px] w-full rounded-[10px]"
            data-testid="scan-preview"
            data-floor={floorFound ? 'found' : 'none'}
            data-removed={prepared.removedTriangles}
            data-kept={prepared.keptTriangles}
            data-size={[prepared.size.w, prepared.size.d, prepared.size.h].map((v) => v.toFixed(3)).join(',')}
          />
          {floorFound ? (
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="flex justify-between">
                <span>바닥 지우기 (빨간 부분)</span>
                <span className="font-mono text-sub" data-testid="scan-cut-label">
                  {(cut * 100).toFixed(1)}cm
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={MAX_FLOOR_CUT}
                step={0.0025}
                value={cut}
                onChange={(e) => changeCut(Number(e.target.value))}
                aria-label="바닥에서 지울 높이"
                data-testid="scan-cut"
              />
              <span className="text-xs text-mute">가구의 아래쪽까지 빨갛게 되면 줄이고, 바닥 조각이 남으면 늘리세요.</span>
            </label>
          ) : (
            <p className="text-[13px] text-sub">함께 찍힌 바닥이 없어 그대로 씁니다.</p>
          )}
          <input
            className={fieldClass}
            placeholder="이름 (예: 선풍기)"
            aria-label="스캔 가구 이름"
            maxLength={USER_FURNITURE_NAME_MAX}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-testid="scan-name"
          />
          <div className="flex items-center gap-1.5">
            {(['width', 'depth', 'height'] as const).map((key) => (
              <input
                key={key}
                className={`${fieldClass} w-0 flex-1 px-2.5`}
                inputMode="decimal"
                placeholder={{ width: '가로', depth: '깊이', height: '높이' }[key]}
                aria-label={{ width: '가로 (cm)', depth: '깊이 (cm)', height: '높이 (cm)' }[key]}
                value={form[key]}
                onChange={(e) => {
                  setSizeEdited(true);
                  setForm({ ...form, [key]: e.target.value });
                }}
                data-testid={`scan-${key}`}
              />
            ))}
            <span className="font-mono text-xs text-sub">cm</span>
          </div>
          <p className="text-xs text-mute">치수를 바꾸면 모델이 그 크기로 늘거나 줄어듭니다.</p>
        </>
      )}
      {message && (
        <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" role="alert" data-testid="scan-message">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn btn-primary h-10 flex-1 text-[13px]" disabled={!prepared || phase === 'saving'} onClick={create} data-testid="scan-create">
          {phase === 'saving' ? '올리는 중…' : '만들기'}
        </button>
        <button className="btn btn-outline h-10 px-4 text-[13px]" disabled={phase === 'saving'} onClick={onClose}>
          취소
        </button>
      </div>
    </div>
  );
}
