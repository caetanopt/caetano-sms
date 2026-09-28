import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SMS AWS",
  description: "Envio seguro de SMS através de AWS End User Messaging SMS",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-PT">
      <body>{children}</body>
    </html>
  );
}
