// Quick check of the image provider: npx tsx --env-file=../.env harness/image.mts [out.png]
import { writeFileSync } from "node:fs";
import { generateImage, onImageLog } from "../src/images.ts";
onImageLog(console.log);
const png = await generateImage("A Roman court advisor reading a dispatch by candle light, realistic oil painting, no text.");
if (!png) process.exit(1);
writeFileSync(process.argv[2] ?? "/tmp/ruler-image-test.png", png);
console.log("saved", process.argv[2] ?? "/tmp/ruler-image-test.png", png.length, "bytes");
