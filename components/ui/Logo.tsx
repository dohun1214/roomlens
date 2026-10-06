/** RoomLens 표시: 네 귀퉁이 눈금 안의 렌즈 */
export function LogoMark({ size = 34 }: { size?: number }) {
  const icon = Math.round(size * 0.6);
  return (
    <span
      className="flex shrink-0 items-center justify-center bg-accent"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      aria-hidden="true"
    >
      <svg width={icon} height={icon} viewBox="0 0 22 22" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8V3h5M14 3h5v5M19 14v5h-5M8 19H3v-5" />
        <circle cx="11" cy="11" r="3" />
      </svg>
    </span>
  );
}

export default function Logo({ size = 34, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 font-bold tracking-tight text-ink ${className}`}>
      <LogoMark size={size} />
      RoomLens
    </span>
  );
}
