import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "UptimeSure — Executable service guarantees",
  description: "Put test USDC behind an API uptime promise. Deterministic monitoring, verifiable incidents and automatic testnet compensation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
        <footer className="footer shell">
          <span>UptimeSure</span>
          <span>Base Sepolia · Supabase · Vercel</span>
          <span>Testnet only. Test USDC has no financial value.</span>
        </footer>
      </body>
    </html>
  );
}
