// 공지 시안 만들기와 고치기. 웹 테스트 화면과 카카오 챗봇이 함께 쓴다.

import { loadFont, type LoadedFont } from "./fonts";
import { buildPrompt, buildRevisionPrompt, OCCASIONS } from "./occasions";
import { generateImage } from "./openai";
import { overlayText } from "./overlay";

export type Env = {
  BUCKET: R2Bucket;
  OPENAI_API_KEY: string;
  OPENAI_IMAGE_MODEL: string;
  ADMIN_TOKEN: string;
  STORE_NAME: string;
  FONT_URL: string;
  KAKAO_SKILL_SECRET: string;
  KAKAO_ALLOWED_USER_IDS: string;
};

// 시안을 다시 그리거나 문구를 다시 얹을 때 필요한 정보. notices/{id}/meta.json에 저장한다.
export type NoticeMeta = { occasion: string; title: string; subtitle?: string };

export type Variant = { url: string; base: string };

async function loadFonts(env: Env, occasionKey: string) {
  const body = await loadFont("basic", env);
  if (!body) throw new Error("기본 폰트를 불러오지 못했습니다.");
  const style = OCCASIONS[occasionKey]?.titleFont ?? "basic";
  const title = (await loadFont(style, env)) ?? body;
  const notes = title === body && style !== "basic" ? [`제목 폰트(fonts/${style})가 R2에 없어 기본 폰트를 썼어요.`] : [];
  return { fonts: { title, body }, notes };
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
  fonts: { title: LoadedFont; body: LoadedFont },
): Promise<Variant> {
  await env.BUCKET.put(`notices/${id}/base-${name}`, base.data, {
    httpMetadata: { contentType: base.mimeType },
  });
  const final = await overlayText(
    base.data,
    base.mimeType,
    { title: meta.title, subtitle: meta.subtitle, footer: env.STORE_NAME || undefined },
    fonts,
  );
  const key = `notices/${id}/final-${name}.png`;
  await env.BUCKET.put(key, final, { httpMetadata: { contentType: "image/png" } });
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
  const occasion = OCCASIONS[input.meta.occasion];
  if (!occasion) throw new Error("알 수 없는 기념일입니다.");

  const { fonts, notes } = await loadFonts(env, input.meta.occasion);
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
            prompt: buildPrompt(occasion, i, input.extra),
          });
      return saveVariant(env, origin, id, String(i + 1), base, input.meta, fonts);
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
  const { fonts, notes } = await loadFonts(env, meta.occasion);
  const name = `${baseName.split("-r")[0]}-r${crypto.randomUUID().slice(0, 6)}`;
  const image = await saveVariant(env, origin, id, name, revised, meta, fonts);
  return { image, notes };
}
