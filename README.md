# RoomLens

휴대폰으로 찍은 자취방을 가우시안 스플래팅 3D로 보여주고, 실제 치수의 가구를 배치해 보고, 배치를 추천받는 웹 서비스입니다.

## 주요 기능 (예정)

- Scaniverse로 촬영한 방 3D(SPZ) 업로드와 3D 투어
- 바닥 모서리·벽 길이로 실제 크기 보정
- 가구 배치(3D / 2D 평면도), 겹침·통로·문 앞 공간 검사
- 문·창문과 방에 원래 있는 가구 표시 (직접 넣거나 AI로 찾은 후보를 확인)
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

## 사용한 데이터

- 가구 3D 모델: [Amazon Berkeley Objects](https://amazon-berkeley-objects.s3.amazonaws.com/index.html) (Amazon.com), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) / 책장 하나는 [Poly Haven](https://polyhaven.com/a/Shelf_01) (CC0). 웹용으로 메시·텍스처를 압축하고 크기를 맞췄습니다 (`scripts/dev-data/build-furniture-models.mjs`). 목록의 작은 사진(`public/furniture/`)은 이 모델을 그린 것입니다 (`scripts/dev-data/render-furniture-thumbs.mjs`). 원본은 저장소에 넣지 않습니다.
