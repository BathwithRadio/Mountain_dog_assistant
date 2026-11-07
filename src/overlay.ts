// 이미지 위에 한글 제목과 부제를 얹어 PNG로 만든다.
// AI 모델은 한글을 자주 틀리게 그리므로 글자는 항상 여기서 코드로 넣는다.

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import type { LoadedFont } from "./fonts";

// 인스타 피드가 잘리지 않고 보여 주는 가장 긴 세로 비율(4:5)
const WIDTH = 1080;
const HEIGHT = 1350;
// 휴대폰 화면 가장자리에 글자가 붙지 않도록 두는 여백
const SAFE_X = WIDTH * 0.06;
const SAFE_BOTTOM = HEIGHT * 0.06;
const MAX_TEXT_WIDTH = WIDTH - SAFE_X * 2;

export const MAX_TITLE_LINES = 2;
export const MAX_SUBTITLE_LINES = 2;

let wasmReady: Promise<void> | undefined;

export type OverlayText = {
  title: string; // 줄바꿈(\n)으로 최대 2줄
  subtitle?: string; // 최대 2줄
  footer?: string; // 가게 이름 등
};

export type OverlayFonts = { title: LoadedFont; body: LoadedFont };

export async function overlayText(
  image: Uint8Array,
  mimeType: string,
  text: OverlayText,
  fonts: OverlayFonts,
): Promise<Uint8Array> {
  wasmReady ??= initWasm(resvgWasm);
  await wasmReady;

  const svg = buildSvg(image, mimeType, text, fonts);
  const fontBuffers = fonts.title === fonts.body ? [fonts.body.data] : [fonts.title.data, fonts.body.data];
  const resvg = new Resvg(svg, {
    font: { fontBuffers, defaultFontFamily: fonts.body.family, loadSystemFonts: false },
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  resvg.free();
  return png;
}

export function splitLines(text: string | undefined): string[] {
  return (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function buildSvg(image: Uint8Array, mimeType: string, text: OverlayText, fonts: OverlayFonts): string {
  const titleLines = wrapIfTooSmall(splitLines(text.title), WIDTH * 0.09, MAX_TITLE_LINES);
  const subtitleLines = wrapIfTooSmall(splitLines(text.subtitle), WIDTH * 0.045, MAX_SUBTITLE_LINES);
  // 문구가 길면 안전 영역을 넘지 않도록 글자 크기를 줄인다.
  const titleSize = fitSize(titleLines, WIDTH * 0.09);
  const subtitleSize = fitSize(subtitleLines, WIDTH * 0.045);
  const footerSize = fitSize(text.footer ? [text.footer] : [], WIDTH * 0.032);

  const x = WIDTH / 2;
  const els: string[] = [];
  // 아래에서부터 위로 줄을 쌓는다.
  let y = HEIGHT - SAFE_BOTTOM;
  if (text.footer) {
    els.push(textEl(text.footer, x, y, footerSize, fonts.body.family, 700, 0.85));
    y -= footerSize * 1.9;
  }
  for (const line of [...subtitleLines].reverse()) {
    els.push(textEl(line, x, y, subtitleSize, fonts.body.family, 700, 0.95));
    y -= subtitleSize * 1.4;
  }
  if (subtitleLines.length) y -= subtitleSize * 0.4;
  for (const line of [...titleLines].reverse()) {
    els.push(textEl(line, x, y, titleSize, fonts.title.family, undefined, 1));
    y -= titleSize * 1.2;
  }

  // 글자가 잘 보이도록 아래쪽을 어둡게 깐다.
  const shadeTop = Math.max(0, y - titleSize * 0.5);

  // preserveAspectRatio="xMidYMid slice"로 어떤 비율의 사진이든 가운데 기준 4:5로 자른다.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.65"/>
    </linearGradient>
  </defs>
  <image href="data:${mimeType};base64,${Buffer.from(image).toString("base64")}" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="${shadeTop}" width="${WIDTH}" height="${HEIGHT - shadeTop}" fill="url(#shade)"/>
  ${els.join("\n  ")}
</svg>`;
}

// 한 줄짜리 문구가 너무 작아질 정도로 길면, 가운데에 가까운 띄어쓰기에서 두 줄로 나눈다.
function wrapIfTooSmall(lines: string[], maxSize: number, maxLines: number): string[] {
  if (lines.length !== 1 || maxLines < 2 || fitSize(lines, maxSize) >= maxSize * 0.75) return lines;
  const line = lines[0];
  const spaces = [...line.matchAll(/ /g)].map((m) => m.index!);
  if (!spaces.length) return lines;
  const middle = line.length / 2;
  const at = spaces.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best));
  return [line.slice(0, at), line.slice(at + 1)];
}

// 가장 긴 줄이 안전 영역 너비에 들어가는 가장 큰 글자 크기
function fitSize(lines: string[], maxSize: number): number {
  const widestEm = Math.max(0, ...lines.map(estimateEm));
  if (!widestEm) return Math.round(maxSize);
  return Math.round(Math.min(maxSize, MAX_TEXT_WIDTH / widestEm));
}

// 글자 폭을 em 단위로 대략 계산한다. 한글은 정사각형에 가깝고 영문·숫자는 좁다.
function estimateEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    if (/[ᄀ-ᇿ㄰-㆏가-힯　-鿿]/.test(ch)) em += 1;
    else if (ch === " ") em += 0.3;
    else em += 0.62;
  }
  return em;
}

function textEl(
  content: string,
  x: number,
  y: number,
  size: number,
  family: string,
  weight: number | undefined,
  opacity: number,
): string {
  const weightAttr = weight ? ` font-weight="${weight}"` : "";
  return `<text x="${x}" y="${Math.round(y)}" font-family="${escapeXml(family)}"${weightAttr} font-size="${size}" fill="#fff" fill-opacity="${opacity}" text-anchor="middle">${escapeXml(content)}</text>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
