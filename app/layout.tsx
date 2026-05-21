import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="vi" className="h-full antialiased">
      <body className="min-h-full bg-slate-950 text-white">{children}</body>
    </html>
  );
}
