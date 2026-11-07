// 공지 이미지에 쓰는 폰트를 불러온다.
// 기본 폰트(Pretendard)는 재배포가 허용되어 CDN에서 받고,
// 제목용 폰트(배민·G마켓·카페24 등)는 공식 사이트에서 받은 파일을 R2의 fonts/에 넣어 둔다.
// fonts/는 /images/ 경로로 공개되지 않으므로 폰트 파일이 재배포되지 않는다.

export type FontStyle = "basic" | "rounded" | "bold";

export type LoadedFont = { family: string; data: Uint8Array };

const cache = new Map<FontStyle, LoadedFont>();

export async function loadFont(
  style: FontStyle,
  env: { BUCKET: R2Bucket; FONT_URL: string },
): Promise<LoadedFont | undefined> {
  const cached = cache.get(style);
  if (cached) return cached;

  let data: Uint8Array;
  if (style === "basic") {
    const res = await fetch(env.FONT_URL, { cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true } });
    if (!res.ok) throw new Error(`기본 폰트를 불러오지 못했습니다 (${res.status})`);
    data = new Uint8Array(await res.arrayBuffer());
  } else {
    // 아직 올리지 않은 폰트는 캐시하지 않아, 올린 뒤 서버를 재시작하지 않아도 바로 쓰인다.
    const object = await env.BUCKET.get(`fonts/${style}`);
    if (!object) return undefined;
    data = new Uint8Array(await object.arrayBuffer());
  }

  const font = { family: readFamilyName(data), data };
  cache.set(style, font);
  return font;
}

// SVG의 font-family는 폰트 파일 안에 적힌 이름과 같아야 하므로, 파일의 name 테이블에서 읽는다.
function readFamilyName(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) === "ttcf") throw new Error("TTC(폰트 모음) 파일은 지원하지 않습니다. TTF나 OTF를 올려 주세요.");

  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    if (tag(record) === "name") nameOffset = view.getUint32(record + 8);
  }
  if (nameOffset < 0) throw new Error("폰트 파일에서 이름 정보를 찾지 못했습니다.");

  const count = view.getUint16(nameOffset + 2);
  const stringsStart = nameOffset + view.getUint16(nameOffset + 4);
  const candidates: { score: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const platformId = view.getUint16(r);
    const languageId = view.getUint16(r + 4);
    const nameId = view.getUint16(r + 6);
    const length = view.getUint16(r + 8);
    const start = stringsStart + view.getUint16(r + 10);
    // 1: 패밀리 이름, 16: 대표 패밀리 이름(굵기별 파일이 같은 이름을 공유)
    if (platformId !== 3 || (nameId !== 1 && nameId !== 16)) continue;

    let name = "";
    for (let j = 0; j < length; j += 2) name += String.fromCharCode(view.getUint16(start + j));
    // 대표 이름과 영어 이름을 우선한다.
    candidates.push({ score: (nameId === 16 ? 2 : 0) + (languageId === 0x0409 ? 1 : 0), name });
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best) throw new Error("폰트 파일에서 패밀리 이름을 읽지 못했습니다.");
  return best.name;
}
