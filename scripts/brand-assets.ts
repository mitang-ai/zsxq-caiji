import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { brand, markPaths } from "../shared/brand.js";

// Rasterize our vector drawing, not the generated bitmap concept. Canvas is
// already a pdfjs runtime dependency; no additional package or remote request.
const { createCanvas, loadImage } = createRequire(import.meta.url)(
  "@napi-rs/canvas",
);
const shapes = (color = "#18181b") =>
  `<g fill="${color}"><path id="page" d="${markPaths.page}"/><path id="cradle" d="${markPaths.cradle}"/></g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>集见：一页被接住</title>${shapes()}</svg>`;
for (const dir of ["docs/assets/brand", "web/src/assets", "extension/icons"])
  mkdirSync(dir, { recursive: true });
for (const file of [
  "docs/assets/brand/mark.svg",
  "web/src/assets/mark.svg",
  "extension/icons/mark.svg",
])
  writeFileSync(file, svg + "\n");
writeFileSync(
  "docs/assets/brand/mark-white.svg",
  svg.replace('fill="#18181b"', 'fill="#faf8f4"') + "\n",
);
writeFileSync(
  "docs/assets/brand/mark-orange.svg",
  svg.replace('<path id="page"', '<path fill="#c45b3c" id="page"') + "\n",
);
const image = await loadImage(
  Buffer.from(svg.replace("viewBox", 'width="1000" height="1000" viewBox')),
);
for (const size of [16, 32, 48, 128]) {
  const canvas = createCanvas(size, size),
    context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, size, size);
  writeFileSync(
    `extension/icons/icon-${size}.png`,
    canvas.toBuffer("image/png"),
  );
}
// The social card is code-rendered typography with a system font, not a mockup.
const social = createCanvas(1200, 630),
  ctx = social.getContext("2d");
ctx.fillStyle = "#faf8f4";
ctx.fillRect(0, 0, 1200, 630);
ctx.drawImage(image, 800, 150, 300, 300);
ctx.fillStyle = "#18181b";
ctx.font = 'bold 38px "Microsoft YaHei"';
ctx.fillText(`${brand.name}  ·  ${brand.latin}`, 70, 100);
ctx.font = 'bold 66px "Microsoft YaHei"';
ctx.fillText("好内容，", 70, 255);
ctx.fillText("别只收藏。", 70, 350);
ctx.fillStyle = "#65635f";
ctx.font = '25px "Microsoft YaHei"';
ctx.fillText(brand.description, 70, 440);
ctx.strokeStyle = "#dedbd5";
ctx.beginPath();
ctx.moveTo(70, 520);
ctx.lineTo(1130, 520);
ctx.stroke();
ctx.font = '21px "Microsoft YaHei"';
ctx.fillText("知识星球  /  Chrome & Edge  /  本地采集与受控加工", 70, 566);
writeFileSync("web/src/assets/social-card.png", social.toBuffer("image/png"));
writeFileSync(
  "docs/assets/brand/social-card.png",
  social.toBuffer("image/png"),
);
console.log(
  "Rendered vector and 16/32/48/128px icons; no user data or remote calls.",
);
