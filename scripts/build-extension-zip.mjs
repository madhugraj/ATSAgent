// Packs the browser companion (extension/) into public/atsiq-capture.zip, the
// download on Integrations. Runs in the image build, so every deploy ships it.
import { readFileSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";

const FILES = ["manifest.json", "background.js", "popup.js", "popup.html", "portal-fill.js"];
const zip = zipSync(Object.fromEntries(FILES.map((f) => [f, readFileSync(`extension/${f}`)])));
writeFileSync("public/atsiq-capture.zip", zip);
console.log(`public/atsiq-capture.zip: ${FILES.length} files, ${zip.length} bytes`);
