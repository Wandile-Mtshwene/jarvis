import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "J.A.R.V.I.S",
    short_name: "J.A.R.V.I.S",
    description: "Your Mac, by voice.",
    start_url: "/",
    display: "standalone",
    background_color: "#000206",
    theme_color: "#000206",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
