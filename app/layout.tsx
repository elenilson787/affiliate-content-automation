import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, background: "#f7f7f7", fontFamily: "Arial, sans-serif" }}>{children}</body>
    </html>
  );
}
