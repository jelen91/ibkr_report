import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AppNav from "./components/AppNav";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "IBKR Portfolio Viewer",
  description: "View your IBKR portfolio via Flex Query",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppNav />
        {children}
      </body>
    </html>
  );
}
