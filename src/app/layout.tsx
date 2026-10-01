import type { Metadata } from "next";
import "@fontsource-variable/montserrat";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Caetano · Plataforma SMS", template: "%s · Caetano SMS" },
  description: "Envio seguro de SMS através de AWS End User Messaging SMS",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-PT">
      <body>{children}</body>
    </html>
  );
}
