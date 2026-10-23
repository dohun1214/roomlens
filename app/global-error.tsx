'use client';

/** 맨 바깥 틀(layout)에서 난 오류. 글꼴·스타일을 못 읽었을 수 있어 최소한의 모양만 쓴다 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f5f8', color: '#141a2a' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ maxWidth: 420, background: '#fff', borderRadius: 24, padding: '40px 28px', textAlign: 'center', boxShadow: '0 1px 3px rgba(20,26,42,.08)' }}>
            <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>RoomLens를 열지 못했습니다</h1>
            <p style={{ color: '#566074', margin: '0 0 24px' }}>잠시 뒤에 다시 시도해 주세요.</p>
            <button type="button" onClick={reset} style={{ height: 44, padding: '0 20px', borderRadius: 12, border: 0, background: '#3350e8', color: '#fff', fontSize: 15 }}>
              다시 시도
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
