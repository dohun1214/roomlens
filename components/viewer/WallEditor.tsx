'use client';

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Point2 } from '@/lib/three/floorDrag';
import { moveWall } from '@/lib/rooms/wallEdit';
import { pointInPolygon } from '@/lib/three/floorDrag';

/**
 * 작은 평면도에서 벽을 끌어 옮긴다. 벽은 자기 방향과 직각으로만 움직여서, 직각으로 맞춘 방은 계속 직각이다.
 * 자동 보정이 벽을 조금 안쪽·바깥쪽에 잡았을 때 사용자가 손보는 용도.
 */
export default function WallEditor({ polygon, onChange, highlight }: { polygon: Point2[]; onChange: (next: Point2[]) => void; highlight?: number | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ wall: number; start: Point2; base: Point2[] } | null>(null);
  const view = useMemo(() => {
    const xs = polygon.map((p) => p[0]);
    const zs = polygon.map((p) => p[1]);
    const pad = 0.6;
    const [x0, x1, z0, z1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad];
    return { x0, z0, w: x1 - x0, h: z1 - z0 };
  }, [polygon]);

  /** 화면의 포인터 위치 → 방 좌표 [x, z] */
  const toRoom = (event: ReactPointerEvent): Point2 | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };

  const onDown = (wall: number) => (event: ReactPointerEvent<SVGLineElement>) => {
    const start = toRoom(event);
    if (!start) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ wall, start, base: polygon });
  };
  const onMove = (event: ReactPointerEvent) => {
    if (!drag) return;
    const now = toRoom(event);
    if (!now) return;
    const moved = moveWall(drag.base, drag.wall, [now[0] - drag.start[0], now[1] - drag.start[1]]);
    if (moved) onChange(moved);
  };
  const stroke = Math.max(view.w, view.h) / 160;
  const lengths = polygon.map((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x0} ${view.z0} ${view.w} ${view.h}`}
      className="mx-auto aspect-square w-full touch-none rounded-xl bg-ground max-lg:w-[min(100%,220px)]"
      onPointerMove={onMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      data-testid="calibration-wall-editor"
    >
      <polygon points={polygon.map((p) => p.join(',')).join(' ')} fill="rgb(51 80 232 / 0.08)" stroke="none" />
      {polygon.map((p, i) => {
        const q = polygon[(i + 1) % polygon.length];
        const active = drag?.wall === i || highlight === i;
        // 글자는 벽 선에 겹치지 않게 방 안쪽으로 조금 띄운다
        const len = lengths[i] || 1;
        const normal: Point2 = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
        const center: Point2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const inward = pointInPolygon([center[0] + normal[0] * 0.05, center[1] + normal[1] * 0.05], polygon) ? 1 : -1;
        // 세로 벽은 글자를 벽 옆에 붙이고(왼쪽·오른쪽 정렬), 가로 벽은 위·아래로 띄운다
        const vertical = Math.abs(normal[0]) > Math.abs(normal[1]);
        const anchor = vertical ? (normal[0] * inward > 0 ? 'start' : 'end') : 'middle';
        const gap = stroke * (vertical ? 3 : 6);
        const mid: Point2 = [center[0] + normal[0] * gap * inward, center[1] + normal[1] * gap * inward];
        return (
          <g key={i}>
            <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={active ? '#3350e8' : '#141a2a'} strokeWidth={stroke * (active ? 2.2 : 1.4)} strokeLinecap="round" />
            {/* 잡기 쉬운 넓은 투명 선 */}
            <line
              x1={p[0]}
              y1={p[1]}
              x2={q[0]}
              y2={q[1]}
              stroke="transparent"
              strokeWidth={stroke * 10}
              style={{ cursor: Math.abs(q[0] - p[0]) > Math.abs(q[1] - p[1]) ? 'ns-resize' : 'ew-resize' }}
              onPointerDown={onDown(i)}
              data-testid={`calibration-wall-${i}`}
            />
            <text x={mid[0]} y={mid[1]} fontSize={stroke * 6} textAnchor={anchor} dominantBaseline="middle" fill="#3b4256" stroke="#f3f5f8" strokeWidth={stroke * 1.2} paintOrder="stroke" pointerEvents="none">
              {i + 1} · {lengths[i].toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
