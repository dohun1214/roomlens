import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import SiteHeaderGate from "@/components/SiteHeaderGate";

// 글은 IBM Plex Sans KR, 치수 같은 숫자는 IBM Plex Mono (2차 시안)
const plexKr = IBM_Plex_Sans_KR({
  variable: "--font-plex-kr",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
});

// 미리보기 그림 같은 상대 주소를 완전한 주소로 바꿀 기준 (Vercel은 운영 주소를 환경변수로 준다)
const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "RoomLens",
  description: "원룸부터 집 전체까지, 이사 갈 곳도 지금 사는 곳도 3D로 복원해 가구 배치를 미리 해 보는 서비스",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${plexKr.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SiteHeaderGate>
          <SiteHeader />
        </SiteHeaderGate>
        {children}
      </body>
    </html>
  );
}
