// 공지 시안 만들기와 고치기. 웹 테스트 화면과 카카오 챗봇이 함께 쓴다.

import { loadFont, type LoadedFont } from "./fonts";
import { buildConceptPrompt, buildPrompt, buildRevisionPrompt, OCCASIONS } from "./occasions";
import { generateImage } from "./openai";
import { designNotice, type Design, type TitleFont } from "./designer";
import { DEFAULT_LAYOUT, overlayText } from "./overlay";
import type { KakaoJob } from "./kakao";

export type Env = {
  BUCKET: R2Bucket;
  OPENAI_API_KEY: string;
  OPENAI_IMAGE_MODEL: string;
  ADMIN_TOKEN: string;
  STORE_NAME: string;
  FONT_URL: string;
  KAKAO_SKILL_SECRET: string;
  KAKAO_ALLOWED_USER_IDS: string;
  KAKAO_OPEN_TEST: string; // "true"면 허용 목록에 없는 사람도 하루 횟수 제한 안에서 쓸 수 있다 (심사·테스트용)
  KAKAO_TEST_DAILY_LIMIT: string; // 테스트 사용자 1명이 하루에 만들거나 고칠 수 있는 횟수
  OPENAI_DESIGN_MODEL: string;
  JOBS: Queue<KakaoJob>;
  // 기념일 안내 (카카오 나에게 보내기)
  PUBLIC_ORIGIN: string; // 이 서버 주소. 카카오 로그인 Redirect URI와 메시지 링크에 쓴다
  KAKAO_CHANNEL_CHAT_URL: string; // 챗봇 채널 채팅방 주소 (예: http://pf.kakao.com/_xxxx/chat)
  KAKAO_REST_API_KEY: string; // secret
  KAKAO_CLIENT_SECRET?: string; // secret. 콘솔에서 Client Secret을 켰을 때만
  REMINDER_INVITE_CODE: string; // secret. 부모님께 드리는 연결 링크의 초대 코드
  SPCDE_API_KEY?: string; // secret. 공공데이터포털 특일 정보 API (설날·추석 날짜)
  REMINDER_DRY_RUN: string; // "true"면 안내를 실제로 보내지 않고 로그만 남긴다
};

// 시안을 다시 그리거나 문구를 다시 얹을 때 필요한 정보. notices/{id}/meta.json에 저장한다.
// occasion은 웹 테스트 화면의 기념일 선택, concept는 카톡에서 말로 적은 컨셉. 둘 중 하나가 있다.
// title이 빈 문자열이면 글자 없는 이미지를 만든다.
export type NoticeMeta = { occasion?: string; concept?: string; title: string; subtitle?: string };

export type Variant = { url: string; base: string };

// 디자인 에이전트가 고를 수 있도록 제목 폰트 후보를 모두 불러온다.
type FontSet = { fonts: Record<TitleFont, LoadedFont>; suggested: TitleFont };

async function loadFonts(env: Env, occasionKey: string | undefined): Promise<FontSet & { notes: string[] }> {
  const basic = await loadFont("basic", env);
  if (!basic) throw new Error("기본 폰트를 불러오지 못했습니다.");
  const rounded = await loadFont("rounded", env);
  const bold = await loadFont("bold", env);
  const notes = [
    ...(rounded ? [] : ["fonts/rounded가 R2에 없어 기본 폰트로 대신해요."]),
    ...(bold ? [] : ["fonts/bold가 R2에 없어 기본 폰트로 대신해요."]),
  ];
  return {
    fonts: { basic, rounded: rounded ?? basic, bold: bold ?? basic },
    // 제목에는 기본 폰트를 쓰지 않는다. 기념일 정보가 없으면(카톡 컨셉) 둥근 폰트를 기본으로 한다.
    suggested: (occasionKey && OCCASIONS[occasionKey]?.titleFont) || "rounded",
    notes,
  };
}

// 글자 없는 이미지를 저장하고, 문구를 얹은 완성본을 만들어 저장한다.
// 반환하는 base는 이 시안을 다시 고칠 때 쓰는 이름이다.
async function saveVariant(
  env: Env,
  origin: string,
  id: string,
  name: string,
  base: { data: Uint8Array; mimeType: string },
  meta: NoticeMeta,
  fontSet: FontSet,
): Promise<Variant> {
  await env.BUCKET.put(`notices/${id}/base-${name}`, base.data, {
    httpMetadata: { contentType: base.mimeType },
  });
  // 디자인 에이전트가 이미지를 보고 폰트·위치·글자색을 고르고, 렌더링 결과를 직접 확인한다.
  const fallback: Design = { ...DEFAULT_LAYOUT, titleFont: fontSet.suggested, reason: "기본 디자인" };
  const text = { title: meta.title, subtitle: meta.subtitle, footer: env.STORE_NAME || undefined };
  const { design, png } =
    meta.title || meta.subtitle
      ? await designNotice({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_DESIGN_MODEL,
          image: base,
          text,
          concept: meta.concept,
          fonts: fontSet.fonts,
          fallback,
        })
      : // 넣을 문구가 없으면 디자인할 것도 없으므로 4:5로 자르기만 한다.
        {
          design: { ...fallback, reason: "문구 없음" },
          png: await overlayText(base.data, base.mimeType, text, { title: fontSet.fonts.basic, body: fontSet.fonts.basic }),
        };
  // 에이전트가 무엇을 왜 골랐는지 남겨 둔다.
  await env.BUCKET.put(`notices/${id}/design-${name}.json`, JSON.stringify(design), {
    httpMetadata: { contentType: "application/json" },
  });
  const key = `notices/${id}/final-${name}.png`;
  await env.BUCKET.put(key, png, { httpMetadata: { contentType: "image/png" } });
  return { url: `${origin}/images/${key}`, base: name };
}

export async function createNotice(
  env: Env,
  origin: string,
  input: {
    photo: Uint8Array;
    photoMimeType: string;
    meta: NoticeMeta;
    extra?: string;
    count: number;
    skipAi: boolean;
  },
): Promise<{ id: string; images: Variant[]; errors: string[]; notes: string[] }> {
  const occasion = input.meta.occasion ? OCCASIONS[input.meta.occasion] : undefined;
  if (!occasion && input.meta.concept === undefined) throw new Error("알 수 없는 기념일입니다.");

  const { notes, ...fontSet } = await loadFonts(env, input.meta.occasion);
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

  await env.BUCKET.put(`notices/${id}/original`, input.photo, {
    httpMetadata: { contentType: input.photoMimeType },
  });
  await env.BUCKET.put(`notices/${id}/meta.json`, JSON.stringify(input.meta), {
    httpMetadata: { contentType: "application/json" },
  });

  // 시안끼리는 서로 기다릴 필요가 없으므로 동시에 만든다.
  const results = await Promise.allSettled(
    Array.from({ length: input.count }, async (_, i) => {
      const base = input.skipAi
        ? { data: input.photo, mimeType: input.photoMimeType }
        : await generateImage({
            apiKey: env.OPENAI_API_KEY,
            model: env.OPENAI_IMAGE_MODEL,
            photo: input.photo,
            photoMimeType: input.photoMimeType,
            prompt: occasion ? buildPrompt(occasion, i, input.extra) : buildConceptPrompt(input.meta.concept ?? ""),
          });
      return saveVariant(env, origin, id, String(i + 1), base, input.meta, fontSet);
    }),
  );

  const images = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
  return { id, images, errors, notes };
}

export class NoticeNotFoundError extends Error {}

// 만든 시안 하나를 말로 요청해 조금만 고친다. 고친 결과를 다시 고칠 수도 있다.
export async function reviseNotice(
  env: Env,
  origin: string,
  id: string,
  baseName: string,
  instruction: string,
): Promise<{ image: Variant; notes: string[] }> {
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(baseName)) throw new NoticeNotFoundError("잘못된 시안입니다.");

  const [metaObject, baseObject] = await Promise.all([
    env.BUCKET.get(`notices/${id}/meta.json`),
    env.BUCKET.get(`notices/${id}/base-${baseName}`),
  ]);
  if (!metaObject || !baseObject) throw new NoticeNotFoundError("시안을 찾지 못했습니다.");
  const meta = (await metaObject.json()) as NoticeMeta;

  const revised = await generateImage({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_IMAGE_MODEL,
    photo: new Uint8Array(await baseObject.arrayBuffer()),
    photoMimeType: baseObject.httpMetadata?.contentType ?? "image/png",
    prompt: buildRevisionPrompt(instruction),
  });
  const { notes, ...fontSet } = await loadFonts(env, meta.occasion);
  const name = `${baseName.split("-r")[0]}-r${crypto.randomUUID().slice(0, 6)}`;
  const image = await saveVariant(env, origin, id, name, revised, meta, fontSet);
  return { image, notes };
}
