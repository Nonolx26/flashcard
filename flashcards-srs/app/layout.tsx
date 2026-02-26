import "../styles/globals.css";
import { Inter } from "next/font/google";

export const metadata = { title: "Flashcards SRS" };
const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body className={inter.className + " bg-gradient-to-b from-[#060911] via-[#0b1224] to-[#05070d] text-slate-100"}>
        {children}
      </body>
    </html>
  );
}
