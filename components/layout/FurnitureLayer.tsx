'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { placeOnFloor, rayFloorPoint, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { pointerToNdc } from '@/lib/three/pickPoint';
import type { Engine } from '@/components/viewer/engine';

type Item = Footprint & { id: string; name: string; h: number; color: number };

/** 원룸 기준 기본 치수 (m). 이후 카탈로그 테이블로 옮긴다. */
const PRESETS = [
  { name: '슈퍼싱글 침대', w: 1.1, d: 2.0, h: 0.45, color: 0x6fa8dc },
  { name: '책상', w: 1.2, d: 0.6, h: 0.73, color: 0xe0a458 },
  { name: '옷장', w: 0.9, d: 0.6, h: 2.0, color: 0x93c47d },
];
const EDGE_COLOR = 0xffffff;
const SELECTED_EDGE_COLOR = 0xffe14d;

type Drag = { id: string; pointerId: number; offset: Point2; current: Footprint };

/**
 * 보정된 방(바닥 y=0, 단위 m) 위에 박스 가구를 놓고 바닥 평면에서 끈다.
 * 가구는 roomGroup이 아니라 scene에 직접 넣는다 (방 좌표 = 월드 좌표).
 */
export default function FurnitureLayer({
  engineRef,
  floorPolygon,
}: {
  engineRef: RefObject<Engine | null>;
  floorPolygon: Point2[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemsRef = useRef<Item[]>([]);
  const groupRef = useRef<THREE.Group | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
      const geometry = new THREE.BoxGeometry(item.w, item.h, item.d);
      const material = new THREE.MeshLambertMaterial({ color: item.color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, item.h / 2, item.z);
      mesh.rotation.y = THREE.MathUtils.degToRad(item.rotationDeg);
      mesh.userData.id = item.id;

      const edgeGeometry = new THREE.EdgesGeometry(geometry);
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: item.id === selectedId ? SELECTED_EDGE_COLOR : EDGE_COLOR,
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
  }, [engineRef, items, selectedId]);

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

  const add = (preset: (typeof PRESETS)[number]) => {
    const id = `f${nextId.current}`;
    nextId.current += 1;
    // 방 좌표의 원점 = 모서리 중심
    const placed = placeOnFloor({ x: 0, z: 0, w: preset.w, d: preset.d, rotationDeg: 0 }, floorPolygon);
    setItems((prev) => [...prev, { ...preset, ...placed, id }]);
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

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div
      className="absolute right-2 top-2 w-64 max-w-[calc(100%-1rem)] space-y-2 rounded bg-black/75 p-3 text-xs text-white"
      data-testid="furniture-panel"
      data-json={JSON.stringify(
        items.map(({ id, name, x, z, w, d, h, rotationDeg }) => ({ id, name, x, z, w, d, h, rotationDeg })),
      )}
    >
      <strong>가구 배치</strong>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button key={preset.name} className="rounded bg-white/20 px-2 py-1" onClick={() => add(preset)}>
            + {preset.name}
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
        <p className="opacity-80">가구를 추가한 뒤 끌어서 옮기세요. 5cm 단위로 움직이고 벽 가까이에서는 벽에 붙습니다.</p>
      )}
    </div>
  );
}
