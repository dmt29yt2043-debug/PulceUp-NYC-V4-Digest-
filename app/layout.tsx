import type { Metadata } from "next";
import "./globals.css";
import PostHogProvider from "./PostHogProvider";
import ResearchBubble from "@/components/ResearchBubble";

// metadataBase is required so relative og:image URLs resolve to absolute URLs
// that social-media scrapers can fetch.
//
// The OG image itself is generated dynamically by `app/opengraph-image.tsx`
// via Next.js's file convention — no manual `openGraph.images` entry needed.
export const metadata: Metadata = {
  metadataBase: new URL("https://pulseup.me"),
  title: "PulseUp",
  description: "Better Moments with your Kids. Less Planning",
  openGraph: {
    type: "website",
    url: "https://pulseup.me",
    siteName: "PulseUp",
    title: "PulseUp",
    description: "Better Moments with your Kids. Less Planning",
  },
  twitter: {
    card: "summary_large_image",
    title: "PulseUp",
    description: "Better Moments with your Kids. Less Planning",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossOrigin=""
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen flex flex-col" style={{ background: '#0f0d2e', color: '#ffffff' }}>
        <PostHogProvider>
          {children}
        </PostHogProvider>
        {/* Research recruitment bubble — global, on all pages (except /quiz).
            Rendered at the body level (outside the main app tree) so no
            ancestor's transform/overflow can clip its position: fixed. */}
        <ResearchBubble />
      </body>
    </html>
  );
}
