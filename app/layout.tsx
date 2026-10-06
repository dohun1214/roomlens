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

export const metadata: Metadata = {
  title: "RoomLens",
  description: "자취방 3D 복원과 가구 배치 시뮬레이션",
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
