import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "J.A.R.V.I.S",
  description: "Your Mac, by voice.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "J.A.R.V.I.S" },
};

export const viewport: Viewport = {
  themeColor: "#000206",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
