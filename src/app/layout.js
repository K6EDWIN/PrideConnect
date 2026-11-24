import "./globals.css";
import "./workspace-responsive.css";
import "./classic-polish.css";
import Providers from "./providers";
import Nav from "@/components/Nav";
import { Analytics } from "@vercel/analytics/next";

export const metadata = {
  title: "PrideConnect | Kenya Airways Community Network",
  description: "Discover mentors, professional peers, events, and opportunities with PrideConnect.",
};

export default function RootLayout({ children, profile }) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <Nav />
          {children}
          {profile}
        </Providers>
        <Analytics />
      </body>
    </html>
  );
}
