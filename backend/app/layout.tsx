import type { ReactNode } from "react";

export const metadata = {
  title: "Hintora PoC — Reliability Store",
  description: "Confirmed guidance resolutions — the persistence side of the extension's reliability story.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, sans-serif", margin: 0, background: "#0f0c1e", color: "#f4f2ff" }}>
        {children}
      </body>
    </html>
  );
}
