import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "/var/lib/samewindow/novnc-web/vnc.html");
if (path.basename(target) !== "vnc.html") {
  throw new Error(`Refusing to patch non-vnc.html target: ${target}`);
}
const marker = '<script src="/user-cursor.js"></script>';
const source = fs.readFileSync(target, "utf8");
let patched = source;
let changed = false;

if (!patched.includes(marker)) {
  if (!patched.includes("</body>")) {
    throw new Error(`Cannot find </body> in ${target}`);
  }
  patched = patched.replace("</body>", `  ${marker}\n  </body>`);
  changed = true;
}
const versionedUi = 'src="app/ui.js?samewindow-quality-4-compression-5"';
const nextHtml = patched.replace(/src="app\/ui\.js(?:\?[^\"]*)?"/, versionedUi);
if (nextHtml !== patched) {
  patched = nextHtml;
  changed = true;
}

if (changed) fs.writeFileSync(target, patched, "utf8");

const rfbTarget = path.join(path.dirname(target), "core", "rfb.js");
const rfbSource = fs.readFileSync(rfbTarget, "utf8");
const rfbPatched = rfbSource
  .replace(/pseudoEncodingQualityLevel0 \+ \d/, "pseudoEncodingQualityLevel0 + 4")
  .replace(/pseudoEncodingCompressLevel0 \+ \d/, "pseudoEncodingCompressLevel0 + 5");
if (rfbPatched === rfbSource) {
  console.log("noVNC quality 4 / compression 5 already active");
} else {
  fs.writeFileSync(rfbTarget, rfbPatched, "utf8");
  console.log(`Patched ${rfbTarget} for quality 4 / compression 5`);
}

const uiTarget = path.join(path.dirname(target), "app", "ui.js");
const uiSource = fs.readFileSync(uiTarget, "utf8");
const uiPatched = uiSource.replace(
  /from "\.\.\/core\/rfb\.js(?:\?[^\"]*)?"/,
  'from "../core/rfb.js?samewindow-quality-4-compression-5"',
);
if (uiPatched !== uiSource) fs.writeFileSync(uiTarget, uiPatched, "utf8");

console.log(changed ? `Patched ${target}` : "noVNC telemetry script already present");
