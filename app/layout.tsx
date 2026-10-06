import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "UK Company Enrichment Pipeline",
  description: "Synthetic portfolio demo of a Companies House ingestion and enrichment workflow",
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
