// 홈 첫 화면의 그림 위에 얹는 작은 평면도. 그림 속 샘플 방(Studio 11)의 바닥 모양과 가구 배치 예시 (단위 cm).
const WALLS =
  '226.5,-349.1 581.5,-349.1 581.5,230.9 211.5,230.9 211.5,130.9 190.5,130.9 190.5,223.9 -126.5,223.9 -126.5,42.9 -226.5,42.9 -226.5,175.9 -413.5,175.9 -413.5,75.9 -473.5,75.9 -473.5,-44.1 -276.5,-44.1 -276.5,-84.1 -173.5,-84.1 -173.5,-59.1 78.5,-59.1 78.5,-91.1 190.5,-91.1 190.5,-22.1 211.5,-22.1 211.5,-231.1 226.5,-231.1';

const FURNITURE = [
  { x: 483.5, y: -345.1, w: 94, h: 194, r: 10, fill: '#c9daf8', stroke: '#6f92d8' }, // 침대
  { x: 523.5, y: -109.1, w: 54, h: 116, r: 8, fill: '#f8ddb8', stroke: '#d29a4a' }, // 책상
  { x: 468.5, y: -74.1, w: 46, h: 46, r: 14, fill: '#f3cfe3', stroke: '#c77fa8' }, // 의자
  { x: 493.5, y: 172.9, w: 84, h: 54, r: 8, fill: '#cfe8cb', stroke: '#76b06b' }, // 옷장
  { x: 213.5, y: 187.9, w: 76, h: 39, r: 8, fill: '#cfe8cb', stroke: '#76b06b' }, // 서랍장
];

export default function SamplePlan({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="-500 -372 1110 630" className={className} role="img" aria-label="같은 방의 평면도와 가구 배치">
      <polygon points={WALLS} fill="var(--color-ground)" stroke="var(--color-ink)" strokeWidth="14" strokeLinejoin="round" />
      {FURNITURE.map((f) => (
        <rect key={`${f.x},${f.y}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={f.r} fill={f.fill} stroke={f.stroke} strokeWidth="6" />
      ))}
    </svg>
  );
}
