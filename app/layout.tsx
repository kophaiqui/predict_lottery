import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Predict Lottery Lab",
  description:
    "Dashboard phân tích, crawl, prediction, backtesting và learning loop cho dữ liệu Vietlott.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className={`h-full antialiased ${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-full bg-[#0d1117] text-[#f4f4f5]">{children}</body>
    </html>
  );
}
