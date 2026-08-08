import type { Metadata } from "next";
import { Google_Sans, Google_Sans_Code } from "next/font/google";
import "./globals.css";
import { DirectionProvider } from "@/components/ui/direction";
import { cn } from "@/lib/utils";

const googleSans = Google_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const googleSansCode = Google_Sans_Code({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  description: "Mitosia",
  title: "Mitosia",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      className={cn(
        "h-full",
        "antialiased",
        googleSans.variable,
        googleSansCode.variable,
        "font-sans"
      )}
      lang="en"
    >
      <body className="flex min-h-full flex-col">
        <DirectionProvider>{children}</DirectionProvider>
      </body>
    </html>
  );
}
