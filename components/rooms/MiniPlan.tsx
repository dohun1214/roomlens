import type { RoomOutline } from '@/lib/rooms/list';

/** 방 카드에 그리는 작은 평면도: 바닥 모양과 문(주황)·창문(파랑) */
export default function MiniPlan({ outline, className = '' }: { outline: RoomOutline; className?: string }) {
  const xs = outline.polygon.map((p) => p[0]);
  const zs = outline.polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const width = Math.max(maxX - minX, 0.1);
  const height = Math.max(maxZ - minZ, 0.1);
  // 선 굵기는 방 크기에 맞춘다 (어떤 방이든 비슷한 굵기로 보이게)
  const unit = Math.max(width, height) / 100;
  const pad = unit * 8;

  return (
    <svg
      viewBox={`${minX - pad} ${minZ - pad} ${width + pad * 2} ${height + pad * 2}`}
      className={className}
      role="img"
      aria-label={`방 평면도 (${width.toFixed(1)} × ${height.toFixed(1)} m)`}
      data-testid="room-mini-plan"
    >
      <polygon
        points={outline.polygon.map((p) => `${p[0]},${p[1]}`).join(' ')}
        fill="#ffffff"
        stroke="var(--color-ink)"
        strokeWidth={unit * 1.3}
        strokeLinejoin="round"
      />
      {outline.openings.map((o, i) => (
        <line
          key={i}
          x1={o.a[0]}
          y1={o.a[1]}
          x2={o.b[0]}
          y2={o.b[1]}
          stroke={o.type === 'door' ? 'var(--color-door)' : 'var(--color-window)'}
          strokeWidth={unit * 2.2}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
