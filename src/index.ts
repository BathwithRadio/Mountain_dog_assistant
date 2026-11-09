import { Hono } from "hono";
import { createNotice, type Env, type NoticeMeta, NoticeNotFoundError, reviseNotice } from "./notices";
import { OCCASIONS } from "./occasions";
import { MAX_SUBTITLE_LINES, MAX_TITLE_LINES, splitLines } from "./overlay";
import { uploadPage } from "./page";
import { handleKakaoJobs, kakao, type KakaoJob } from "./kakao";
import { kakaoOAuth } from "./kakaoMemo";
import { runReminderAgent } from "./reminder";

const MAX_VARIANTS = 3;

const app = new Hono<{ Bindings: Env }>();

function checkToken(env: Env, token: unknown): { error: string; status: 401 | 500 } | undefined {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    return { error: "서버에 ADMIN_TOKEN이 설정되지 않았습니다. .dev.vars 또는 wrangler secret을 확인하세요.", status: 500 };
  }
  // 복사·붙여넣기로 들어간 앞뒤 공백은 무시한다.
  if (String(token ?? "").trim() !== adminToken) {
    return { error: "관리자 토큰이 맞지 않습니다.", status: 401 };
  }
}

app.get("/", (c) => c.html(uploadPage(OCCASIONS)));

// 사진 한 장으로 공지 시안 1~3장을 만든다.
app.post("/api/notices", async (c) => {
  const form = await c.req.parseBody();
  const denied = checkToken(c.env, form.token);
  if (denied) return c.json({ error: denied.error }, denied.status);

  const photo = form.photo;
  if (!(photo instanceof File) || !["image/jpeg", "image/png"].includes(photo.type)) {
    return c.json({ error: "JPG 또는 PNG 사진을 올려 주세요." }, 400);
  }
  const occasion = OCCASIONS[String(form.occasion)];
  if (!occasion) {
    return c.json({ error: "알 수 없는 기념일입니다." }, 400);
  }

  const title = String(form.title || occasion.defaultTitle);
  const subtitle = form.subtitle ? String(form.subtitle) : undefined;
  if (splitLines(title).length > MAX_TITLE_LINES || splitLines(subtitle).length > MAX_SUBTITLE_LINES) {
    return c.json({ error: `제목은 ${MAX_TITLE_LINES}줄, 부제는 ${MAX_SUBTITLE_LINES}줄까지 쓸 수 있어요.` }, 400);
  }
  const skipAi = form.skipAi === "on";
  const meta: NoticeMeta = { occasion: String(form.occasion), title, subtitle };

  const result = await createNotice(c.env, new URL(c.req.url).origin, {
    photo: new Uint8Array(await photo.arrayBuffer()),
    photoMimeType: photo.type,
    meta,
    extra: form.extra ? String(form.extra) : undefined,
    count: skipAi ? 1 : Math.min(Math.max(Number(form.count) || 2, 1), MAX_VARIANTS),
    skipAi,
  });
  if (!result.images.length) {
    return c.json({ error: result.errors[0] ?? "이미지를 만들지 못했습니다.", errors: result.errors }, 502);
  }
  return c.json(result);
});

// 만든 시안 하나를 말로 요청해 조금만 고친다.
app.post("/api/notices/:id/revise", async (c) => {
  const form = await c.req.parseBody();
  const denied = checkToken(c.env, form.token);
  if (denied) return c.json({ error: denied.error }, denied.status);

  const instruction = String(form.instruction ?? "").trim();
  if (!instruction) {
    return c.json({ error: "어떻게 바꿀지 적어 주세요." }, 400);
  }
  try {
    const result = await reviseNotice(
      c.env,
      new URL(c.req.url).origin,
      c.req.param("id"),
      String(form.base ?? ""),
      instruction,
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof NoticeNotFoundError) return c.json({ error: err.message }, 404);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

//카카오 파트
app.route("/kakao/oauth", kakaoOAuth);
app.route("/kakao", kakao);

// 안내 메시지의 "챗봇 열기" 버튼이 거쳐 가는 주소. 챗봇 채팅방으로 보낸다.
app.get("/go/chat", (c) => c.redirect(c.env.KAKAO_CHANNEL_CHAT_URL || "https://pf.kakao.com"));

// 기념일 안내 에이전트를 지금 바로 실행한다. (시험용)
// today=YYYY-MM-DD로 날짜를 바꿔 볼 수 있다. dryRun=on이면 보내지 않고, dryRun=off면 REMINDER_DRY_RUN과 상관없이 실제로 보낸다.
app.post("/api/reminders/run", async (c) => {
  const form = await c.req.parseBody();
  const denied = checkToken(c.env, form.token);
  if (denied) return c.json({ error: denied.error }, denied.status);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(form.today ?? "")) ? String(form.today) : undefined;
  try {
    return c.json(await runReminderAgent(c.env, { today, dryRun: form.dryRun === "on" ? true : form.dryRun === "off" ? false : undefined }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// R2에 저장된 공지 이미지를 보여 준다. 카톡 발송 시 이 주소를 그대로 쓴다.
// 폰트 파일(fonts/) 등 다른 파일이 공개되지 않도록 notices/만 내려준다.
app.get("/images/*", async (c) => {
  const key = c.req.path.slice("/images/".length);
  if (!key.startsWith("notices/") || key.includes("..")) return c.notFound();
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

// fetch는 웹 화면과 카카오 스킬, queue는 카카오 작업(이미지 만들기·고치기),
// scheduled는 매일 아침 기념일 안내 에이전트를 실행한다.
export default {
  fetch: app.fetch,
  queue: handleKakaoJobs,
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runReminderAgent(env).catch((err) => console.log("reminder failed", err)));
  },
} satisfies ExportedHandler<Env, KakaoJob>;
