import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Company Dashboard",
  description: "Protected dashboard for pipeline results",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
