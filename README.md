# RoomLens

휴대폰으로 찍은 자취방을 가우시안 스플래팅 3D로 보여주고, 실제 치수의 가구를 배치해 보고, 배치를 추천받는 웹 서비스입니다.

## 주요 기능 (예정)

- Scaniverse로 촬영한 방 3D(SPZ) 업로드와 3D 투어
- 바닥 모서리·벽 길이로 실제 크기 보정
- 가구 배치(3D / 2D 평면도), 겹침·통로·문 앞 공간 검사
- 방 사진 분석과 가구 배치 추천

## 기술 스택

- Next.js 16 (App Router, TypeScript)
- three.js + [Spark](https://sparkjs.dev) (3D Gaussian Splatting 렌더러)
- Supabase (DB·인증), Cloudflare R2 (파일)
- Vercel 배포

## 로컬 실행

```bash
npm install
npm run dev
```

http://localhost:3000 에서 확인합니다. 필요한 환경변수는 `.env.example`을 참고해 `.env.local`에 넣습니다.
