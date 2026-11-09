// 카카오 챗봇(오픈빌더) 스킬. 사진과 컨셉을 받아 공지 시안을 만들고, 말로 고칠 수 있게 한다.
// 이미지 생성은 5초를 넘기므로 콜백으로 먼저 답하고, 결과는 callbackUrl로 따로 보낸다.

import { Hono, type Context } from "hono";
import { parseMessage } from "./concept";
import { createNotice, type Env, reviseNotice } from "./notices";
import { MAX_SUBTITLE_LINES, MAX_TITLE_LINES, splitLines } from "./overlay";

type SkillRequest = {
  userRequest?: {
    utterance?: string;
    user?: { id?: string };
    callbackUrl?: string;
  };
};

// 사용자별로 기억하는 것: 마지막에 보낸 사진, 문구를 기다리는 컨셉, 마지막으로 만든 시안
type UserState = {
  photoUrl?: string;
  pendingConcept?: string;
  notice?: { id: string; base: string };
};

const NO_TEXT_REPLY = "문구 없이";

const CONCEPT_GUIDE = `어떤 컨셉으로 만들까요?
사진에 넣을 공지 문구는 따옴표("") 안에 적어 주세요. 따옴표 안의 내용만 사진에 들어가요.

예)
크리스마스 컨셉으로 산타 옷과 모자를 입히고 배경을 바꿔줘, 공지는 "마운틴독 크리스마스 당일에도 오픈합니다"로 해줘

따옴표를 두 번 쓰면 두 번째는 작은 안내 문구가 돼요.`;

type QuickReply = { label: string; action: "message"; messageText: string };

export const kakao = new Hono<{ Bindings: Env }>();

// ---------- 카카오 응답 모양 ----------

function quickReplies(labels: string[]): QuickReply[] {
  return labels.map((label) => ({ label, action: "message", messageText: label }));
}

function textResponse(text: string, replies: QuickReply[] = []) {
  return { version: "2.0", template: { outputs: [{ simpleText: { text } }], quickReplies: replies } };
}

function imageResponse(imageUrl: string, text: string, replies: QuickReply[] = []) {
  return {
    version: "2.0",
    template: {
      outputs: [{ simpleImage: { imageUrl, altText: "공지 시안" } }, { simpleText: { text } }],
      quickReplies: replies,
    },
  };
}

const RESULT_REPLIES = quickReplies(["좋아요", "새로 만들기"]);
const NEW_REPLIES = quickReplies(["다른 컨셉으로", "다른 사진으로"]);

// ---------- 사용자 상태 (R2) ----------

const stateKey = (userId: string) => `kakao/users/${userId}.json`;

async function loadState(env: Env, userId: string): Promise<UserState> {
  const object = await env.BUCKET.get(stateKey(userId));
  return object ? ((await object.json()) as UserState) : {};
}

async function saveState(env: Env, userId: string, state: UserState) {
  await env.BUCKET.put(stateKey(userId), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ---------- 사진 ----------

// 카톡으로 보낸 사진은 utterance에 카카오 CDN 주소로 들어온다.
function photoUrlFrom(utterance: string): string | undefined {
  try {
    const url = new URL(utterance.trim());
    // 아무 주소나 내려받지 않도록 카카오 이미지 서버만 허용한다.
    if (url.protocol === "https:" && url.hostname.endsWith(".kakaocdn.net")) return url.href;
  } catch {}
  return undefined;
}

async function downloadPhoto(url: string): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`사진을 받지 못했습니다 (${res.status})`);
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0];
  if (!["image/jpeg", "image/png"].includes(mimeType)) {
    throw new Error("이 사진 형식은 쓸 수 없어요. 원본 전송이 아닌 일반 전송으로 다시 보내 주세요.");
  }
  return { data: new Uint8Array(await res.arrayBuffer()), mimeType };
}

// ---------- 콜백 ----------

async function sendCallback(callbackUrl: string, body: unknown) {
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // 카카오는 { taskId, status: SUCCESS | FAIL | ERROR, message }로 답한다.
  console.log("kakao callback", res.status, await res.text());
}

// 오래 걸리는 작업을 백그라운드로 돌리고, 카카오에는 바로 "기다려 주세요"라고 답한다.
function runWithCallback(
  c: Context<{ Bindings: Env }>,
  callbackUrl: string | undefined,
  waitingText: string,
  job: () => Promise<unknown>,
) {
  if (!callbackUrl) {
    // 봇테스트나 콜백이 꺼진 블록에서는 callbackUrl이 오지 않는다.
    return c.json(textResponse("콜백이 꺼져 있어 이미지를 보낼 수 없어요. 폴백 블록의 Callback 설정을 확인해 주세요."));
  }
  c.executionCtx.waitUntil(
    job()
      .then((body) => sendCallback(callbackUrl, body))
      .catch((err) =>
        sendCallback(callbackUrl, textResponse(`만들지 못했어요: ${err instanceof Error ? err.message : err}`, RESULT_REPLIES)),
      ),
  );
  return c.json({ version: "2.0", useCallback: true, data: { text: waitingText } });
}

// ---------- 문구 ----------

// 따옴표에서 꺼낸 문구들을 제목(첫 번째)과 안내 문구(나머지)로 나눈다. 너무 길면 안내할 말을 돌려준다.
function toNoticeText(texts: string[]): { title: string; subtitle?: string } | { error: string } {
  const [title = "", ...rest] = texts;
  const subtitle = rest.join("\n");
  if (splitLines(title).length > MAX_TITLE_LINES || splitLines(subtitle).length > MAX_SUBTITLE_LINES) {
    return { error: `문구가 너무 길어요. 제목은 ${MAX_TITLE_LINES}줄, 안내 문구는 ${MAX_SUBTITLE_LINES}줄까지 넣을 수 있어요.` };
  }
  return { title, subtitle: subtitle || undefined };
}

// ---------- 스킬 ----------

kakao.post("/skill", async (c) => {
  // 오픈빌더 스킬 설정의 헤더값(X-Skill-Secret)과 서버 secret이 같을 때만 응답한다.
  const secret = c.env.KAKAO_SKILL_SECRET?.trim();
  if (!secret || c.req.header("x-skill-secret") !== secret) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = (await c.req.json()) as SkillRequest;
  const userId = body.userRequest?.user?.id ?? "";
  const utterance = (body.userRequest?.utterance ?? "").trim();
  const callbackUrl = body.userRequest?.callbackUrl;
  const origin = new URL(c.req.url).origin;

  // 허용 목록이 비어 있으면 아무도 쓸 수 없다. (등록을 잊어도 비용이 새지 않게)
  const allowed = (c.env.KAKAO_ALLOWED_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!/^\w+$/.test(userId) || !allowed.includes(userId)) {
    return c.json(textResponse(`등록되지 않은 사용자예요. 관리자에게 이 ID를 알려 주세요.\n${userId}`));
  }

  const state = await loadState(c.env, userId);

  // 컨셉과 문구로 시안을 만든다. 오래 걸리므로 콜백으로 결과를 보낸다.
  const makeNotice = (photoUrl: string, concept: string, text: { title: string; subtitle?: string }) =>
    runWithCallback(c, callbackUrl, "만들고 있어요. 30초 정도 걸려요.", async () => {
      const photo = await downloadPhoto(photoUrl);
      // 콜백은 1분 안에 보내야 하므로 시안은 1장만 만든다.
      const result = await createNotice(c.env, origin, {
        photo: photo.data,
        photoMimeType: photo.mimeType,
        meta: { concept, title: text.title, subtitle: text.subtitle },
        count: 1,
        skipAi: false,
      });
      const image = result.images[0];
      if (!image) throw new Error(result.errors[0] ?? "이미지를 만들지 못했어요.");
      await saveState(c.env, userId, { photoUrl, notice: { id: result.id, base: image.base } });
      return imageResponse(image.url, "시안이에요. 바꾸고 싶은 점을 말로 보내 주시면 고쳐 드릴게요.", RESULT_REPLIES);
    });

  // 무엇을 바꿔서 새로 만들지 묻는다.
  if (utterance === "새로 만들기") {
    // 진행 중인 시안은 끝내고, 사진은 남겨 둔다.
    await saveState(c.env, userId, { photoUrl: state.photoUrl });
    if (!state.photoUrl) return c.json(textResponse("강아지 사진을 보내 주세요."));
    return c.json(textResponse("무엇을 바꿔서 새로 만들까요?", NEW_REPLIES));
  }

  // 같은 사진으로 다른 컨셉
  if (utterance === "다른 컨셉으로") {
    if (!state.photoUrl) return c.json(textResponse("먼저 강아지 사진을 보내 주세요."));
    await saveState(c.env, userId, { photoUrl: state.photoUrl });
    return c.json(textResponse(CONCEPT_GUIDE));
  }

  // 사진부터 다시
  if (utterance === "다른 사진으로") {
    await saveState(c.env, userId, {});
    return c.json(textResponse("새 강아지 사진을 보내 주세요."));
  }

  // 사진을 받으면 기억해 두고 컨셉을 묻는다.
  const photoUrl = photoUrlFrom(utterance);
  if (photoUrl) {
    await saveState(c.env, userId, { photoUrl });
    return c.json(textResponse(`사진 받았어요!\n\n${CONCEPT_GUIDE}`));
  }

  // 대화를 끝낸다. 이후의 말은 수정 요청으로 받지 않는다.
  if (utterance === "좋아요") {
    await saveState(c.env, userId, { photoUrl: state.photoUrl });
    return c.json(
      textResponse("좋아요! 이미지를 길게 눌러 저장한 뒤 인스타나 네이버에 올려 주세요.", quickReplies(["새로 만들기"])),
    );
  }

  // 시안이 있으면 나머지 말은 수정 요청으로 본다.
  if (state.notice && utterance) {
    const notice = state.notice;
    return runWithCallback(c, callbackUrl, "고치고 있어요. 20초 정도 걸려요.", async () => {
      const { image } = await reviseNotice(c.env, origin, notice.id, notice.base, utterance);
      await saveState(c.env, userId, { ...state, notice: { id: notice.id, base: image.base } });
      return imageResponse(image.url, "고쳤어요. 더 바꿀 점이 있으면 말씀해 주세요.", RESULT_REPLIES);
    });
  }

  // 컨셉만 받고 문구를 기다리던 중이면, 이번 말은 문구로 받는다. (따옴표가 없어도 전체를 문구로 쓴다)
  if (state.pendingConcept !== undefined && state.photoUrl && utterance) {
    if (utterance === NO_TEXT_REPLY) return makeNotice(state.photoUrl, state.pendingConcept, { title: "" });
    const { texts } = parseMessage(utterance);
    const text = toNoticeText(texts.length ? texts : [utterance]);
    if ("error" in text) return c.json(textResponse(text.error, quickReplies([NO_TEXT_REPLY])));
    return makeNotice(state.photoUrl, state.pendingConcept, text);
  }

  // 사진 다음에 오는 말은 컨셉과 문구로 읽는다. 따옴표 안만 사진에 들어간다.
  if (state.photoUrl && utterance) {
    const { concept, texts } = parseMessage(utterance);
    if (!texts.length) {
      // 문구를 빠뜨렸을 수 있으니 바로 만들지 않고 한 번 묻는다.
      await saveState(c.env, userId, { photoUrl: state.photoUrl, pendingConcept: concept });
      return c.json(
        textResponse(
          `사진에 넣을 공지 문구를 보내 주세요.\n예) 크리스마스 당일에도 오픈합니다\n\n글자 없이 만들려면 "${NO_TEXT_REPLY}"를 눌러 주세요.`,
          quickReplies([NO_TEXT_REPLY]),
        ),
      );
    }
    const text = toNoticeText(texts);
    if ("error" in text) return c.json(textResponse(text.error));
    return makeNotice(state.photoUrl, concept, text);
  }

  return c.json(textResponse("강아지 사진을 보내 주시면 공지 이미지를 만들어 드려요."));
});
