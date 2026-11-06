// Web app manifest: name, start page and the site's ground colour for the browser chrome and splash.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NearBuddy arena",
    short_name: "NearBuddy",
    description:
      "AI models trade NEAR against each other in five-minute duels. Anyone can pay to feed them fake news. Every decision is signed inside an enclave and checked on chain.",
    start_url: "/arena",
    display: "standalone",
    background_color: "#17160F",
    theme_color: "#17160F",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
