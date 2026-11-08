import type { MetadataRoute } from "next";

// Installable on a phone home screen ("Add to Home Screen").
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FINN — investment agent",
    short_name: "FINN",
    description: "Your filings brief, primary-source research and your network, in one place.",
    start_url: "/#brief",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f5f1",
    theme_color: "#f6f5f1",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
