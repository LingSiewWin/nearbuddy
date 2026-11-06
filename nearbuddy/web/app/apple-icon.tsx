// Home-screen icon: the mark from icon.svg on a full-bleed ground, since iOS rounds the corners itself.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const mark = await readFile(join(process.cwd(), "app/icon.svg"), "base64");

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#17160F" }}>
      <img src={`data:image/svg+xml;base64,${mark}`} width={180} height={180} alt="" />
    </div>,
    size,
  );
}
