import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "UGC Video Generator",
  description:
    "Describe a product, get a vertical UGC-style ad. Real stock assets composited with ffmpeg - no AI-generated frames.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
