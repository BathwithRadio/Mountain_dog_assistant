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

// 사용자별로 기억하는 것: 마지막에 보낸 사진, 문구를 기다리는 컨셉, 마지막으로 만든 시안,
// 마지막 공지 문구("다른 컨셉으로"에서 다시 씀), 새 컨셉을 기다리는 중인지
type NoticeText = { title: string; subtitle?: string };
type UserState = {
  photoUrl?: string;
  pendingConcept?: string;
  notice?: { id: string; base: string };
  lastText?: NoticeText;
  awaitingConcept?: boolean;
};

// 큐에 넣는 작업. 큐 소비자가 꺼내 이미지를 만들고 카카오 콜백으로 결과를 보낸다.
// usageDate: 테스트 사용자의 하루 횟수를 센 날짜. 작업이 실패하면 그 날짜의 횟수를 되돌린다.
export type KakaoJob = { usageDate?: string } & (
  | {
      kind: "create";
      userId: string;
      callbackUrl: string;
      origin: string;
      photoUrl: string;
      concept: string;
      title: string;
      subtitle?: string;
    }
  | {
      kind: "revise";
      userId: string;
      callbackUrl: string;
      origin: string;
      photoUrl?: string;
      notice: { id: string; base: string };
      instruction: string;
    }
);

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
  return labels.map((label) => ({
    label,
    action: "message",
    messageText: label,
  }));
}

function textResponse(text: string, replies: QuickReply[] = []) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }], quickReplies: replies },
  };
}

function imageResponse(
  imageUrl: string,
  text: string,
  replies: QuickReply[] = [],
) {
  return {
    version: "2.0",
    template: {
      outputs: [
        { simpleImage: { imageUrl, altText: "공지 시안" } },
        { simpleText: { text } },
      ],
      quickReplies: replies,
    },
  };
}

const OTHER_CONCEPT = "다른 컨셉으로";
const RESULT_REPLIES = quickReplies(["좋아요", OTHER_CONCEPT]);

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

// ---------- 테스트 사용자 하루 횟수 (R2) ----------

const kstDate = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const usageKey = (userId: string, date: string) => `kakao/usage/${date}/${userId}.json`;

async function usageOn(env: Env, userId: string, date: string): Promise<number> {
  const object = await env.BUCKET.get(usageKey(userId, date));
  return object ? ((await object.json()) as { count: number }).count : 0;
}

async function setUsage(env: Env, userId: string, date: string, count: number) {
  await env.BUCKET.put(usageKey(userId, date), JSON.stringify({ count }), {
    httpMetadata: { contentType: "application/json" },
  });
}

// 작업이 실패하면 센 횟수를 하나 되돌린다. (실패한 시도는 하루 횟수에 넣지 않는다)
async function refundUsage(env: Env, userId: string, date: string) {
  const used = await usageOn(env, userId, date);
  if (used > 0) await setUsage(env, userId, date, used - 1);
}

// ---------- 사진 ----------

// 카톡으로 보낸 사진은 utterance에 카카오 CDN 주소로 들어온다.
function photoUrlFrom(utterance: string): string | undefined {
  try {
    const url = new URL(utterance.trim());
    // 아무 주소나 내려받지 않도록 카카오 이미지 서버만 허용한다.
    if (url.protocol === "https:" && url.hostname.endsWith(".kakaocdn.net"))
      return url.href;
  } catch {}
  return undefined;
}

async function downloadPhoto(
  url: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`사진을 받지 못했습니다 (${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  // 카카오가 알려 주는 형식 이름(image/jpg, image/jpeg 등)은 사진을 가져온 곳에 따라 달라서 믿지 않고,
  // 파일 앞부분의 표식으로 직접 판단한다.
  const mimeType = detectImageType(data);
  if (!mimeType) {
    const heic = isHeic(data);
    throw new Error(
      heic
        ? "아이폰 원본(HEIC) 사진은 쓸 수 없어요. 사진을 보낼 때 '원본'을 끄고 다시 보내 주세요."
        : "JPG나 PNG 사진만 쓸 수 있어요. 다른 사진으로 다시 보내 주세요.",
    );
  }
  return { data, mimeType };
}

function detectImageType(data: Uint8Array): "image/jpeg" | "image/png" | undefined {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  return undefined;
}

// HEIC/HEIF는 4번째 바이트부터 "ftyp" + 브랜드(heic, heix, mif1 등)가 온다.
function isHeic(data: Uint8Array): boolean {
  const text = String.fromCharCode(...data.subarray(4, 12));
  return text.startsWith("ftyp") && /^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(text.slice(4));
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

async function enqueueJob(
  c: Context<{ Bindings: Env }>,
  callbackUrl: string | undefined,
  waitingText: string,
  makeJob: (callbackUrl: string) => KakaoJob,
) {
  if (!callbackUrl) {
    return c.json(
      textResponse(
        "콜백이 꺼져 있어 이미지를 보낼 수 없어요. 폴백 블록의 Callback 설정을 확인해주세요.",
      ),
    );
  }
  await c.env.JOBS.send(makeJob(callbackUrl));
  return c.json({
    version: "2.0",
    useCallback: true,
    data: { text: waitingText },
  });
}

// 큐에서 꺼낸 작업 하나를 처리하고, 카카오에 보낼 응답을 돌려준다.
async function runJob(env: Env, job: KakaoJob) {
  if (job.kind === "create") {
    const photo = await downloadPhoto(job.photoUrl);
    const result = await createNotice(env, job.origin, {
      photo: photo.data,
      photoMimeType: photo.mimeType,
      meta: { concept: job.concept, title: job.title, subtitle: job.subtitle },
      count: 1,
      skipAi: false,
    });
    const image = result.images[0];
    if (!image)
      throw new Error(result.errors[0] ?? "이미지를 만들지 못했어요.");
    await saveState(env, job.userId, {
      photoUrl: job.photoUrl,
      notice: { id: result.id, base: image.base },
      lastText: { title: job.title, subtitle: job.subtitle },
    });
    return imageResponse(
      image.url,
      "시안이에요. 바꾸고 싶은 점을 말로 보내 주시면 고쳐 드릴게요.",
      RESULT_REPLIES,
    );
  }

  const { image } = await reviseNotice(
    env,
    job.origin,
    job.notice.id,
    job.notice.base,
    job.instruction,
  );
  const previous = await loadState(env, job.userId);
  await saveState(env, job.userId, {
    photoUrl: job.photoUrl,
    notice: { id: job.notice.id, base: image.base },
    lastText: previous.lastText,
  });
  return imageResponse(
    image.url,
    "고쳤어요. 더 바꿀 점이 있으면 말씀해 주세요.",
    RESULT_REPLIES,
  );
}

// 큐 소비자. index.ts에서 queue 핸들러로 연결한다.
export async function handleKakaoJobs(batch: MessageBatch<KakaoJob>, env: Env) {
  for (const msg of batch.messages) {
    const job = msg.body;
    const started = Date.now();
    try {
      await sendCallback(job.callbackUrl, await runJob(env, job));
    } catch (err) {
      if (job.usageDate) {
        await refundUsage(env, job.userId, job.usageDate).catch((e) => console.log("refund failed", e));
      }
      console.log("job failed", job.kind, err instanceof Error ? err.message : err);
      await sendCallback(
        job.callbackUrl,
        textResponse(
          `만들지 못했어요: ${err instanceof Error ? err.message : err}${job.usageDate ? "\n(이번 시도는 오늘 횟수에서 빼 두었어요)" : ""}`,
          RESULT_REPLIES,
        ),
      ).catch((e) => console.log("callback failed", e));
    }
    console.log("job done", job.kind, `${Date.now() - started}ms`);
    msg.ack(); // 실패해도 다시 시도하지 않는다
  }
}

// ---------- 문구 ----------

// 따옴표에서 꺼낸 문구들을 제목(첫 번째)과 안내 문구(나머지)로 나눈다. 너무 길면 안내할 말을 돌려준다.
function toNoticeText(
  texts: string[],
): { title: string; subtitle?: string } | { error: string } {
  const [title = "", ...rest] = texts;
  const subtitle = rest.join("\n");
  if (
    splitLines(title).length > MAX_TITLE_LINES ||
    splitLines(subtitle).length > MAX_SUBTITLE_LINES
  ) {
    return {
      error: `문구가 너무 길어요. 제목은 ${MAX_TITLE_LINES}줄, 안내 문구는 ${MAX_SUBTITLE_LINES}줄까지 넣을 수 있어요.`,
    };
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

  // 허용 목록(부모님 등)은 제한 없이 쓴다. 목록이 비어 있으면 아무도 쓸 수 없다. (등록을 잊어도 비용이 새지 않게)
  // 테스트 모드가 켜져 있으면 목록에 없는 사람도 하루 횟수 제한 안에서 쓸 수 있다.
  const allowed = (c.env.KAKAO_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const isOwner = allowed.includes(userId);
  const openTest = c.env.KAKAO_OPEN_TEST === "true";
  const dailyLimit = Math.max(Number(c.env.KAKAO_TEST_DAILY_LIMIT) || 5, 1);
  if (!/^\w+$/.test(userId) || (!isOwner && !openTest)) {
    return c.json(
      textResponse(
        `등록되지 않은 사용자예요. 관리자에게 이 ID를 알려 주세요.\n${userId}`,
      ),
    );
  }

  const state = await loadState(c.env, userId);

  // 이미지를 만들거나 고치는 작업을 큐에 넣는다. 테스트 사용자는 하루 횟수를 센다.
  const startJob = async (waitingText: string, makeJob: (callbackUrl: string) => KakaoJob) => {
    let usageDate: string | undefined;
    if (!isOwner && callbackUrl) {
      usageDate = kstDate();
      const used = await usageOn(c.env, userId, usageDate);
      if (used >= dailyLimit) {
        return c.json(
          textResponse(
            `오늘 테스트 횟수(${dailyLimit}번)를 다 썼어요. 내일 다시 시도해 주세요.`,
            quickReplies(["좋아요"]),
          ),
        );
      }
      await setUsage(c.env, userId, usageDate, used + 1);
      waitingText += `\n(오늘 테스트 ${used + 1}/${dailyLimit}번째)`;
    }
    return enqueueJob(c, callbackUrl, waitingText, (cb) => ({ ...makeJob(cb), usageDate }));
  };

  // 컨셉과 문구로 시안을 만든다. 오래 걸리므로 콜백으로 결과를 보낸다.
  const makeNotice = (
    photoUrl: string,
    concept: string,
    text: { title: string; subtitle?: string },
  ) =>
    startJob("만들고 있어요. 30초~1분 정도 걸려요.", (cb) => ({
      kind: "create",
      userId,
      callbackUrl: cb,
      origin,
      photoUrl,
      concept,
      title: text.title,
      subtitle: text.subtitle,
    }));

  // 같은 사진, 같은 문구로 컨셉만 바꿔 새로 만든다. ("새로 만들기"는 예전 버튼이라 같은 뜻으로 받는다)
  // 다른 사진으로 하려면 새 사진을 보내면 처음부터 시작한다.
  if (utterance === OTHER_CONCEPT || utterance === "새로 만들기") {
    if (!state.photoUrl)
      return c.json(textResponse("먼저 강아지 사진을 보내 주세요."));
    await saveState(c.env, userId, { photoUrl: state.photoUrl, lastText: state.lastText, awaitingConcept: true });
    if (!state.lastText) return c.json(textResponse(CONCEPT_GUIDE));
    const shown = state.lastText.title ? `"${state.lastText.title}"` : "글자 없이";
    return c.json(
      textResponse(
        `같은 사진, 같은 문구(${shown})로 다시 만들게요.\n어떤 컨셉으로 바꿀지 적어 주세요.\n\n예) 할로윈 컨셉으로 마녀 모자를 씌워줘\n\n문구도 바꾸려면 따옴표 안에 새 문구를 함께 적어 주세요.\n다른 사진으로 하려면 새 사진을 보내 주세요.`,
      ),
    );
  }

  // 사진을 받으면 기억해 두고 컨셉을 묻는다.
  const photoUrl = photoUrlFrom(utterance);
  if (photoUrl) {
    await saveState(c.env, userId, { photoUrl });
    return c.json(textResponse(`사진 받았어요!\n\n${CONCEPT_GUIDE}`));
  }

  // 대화를 끝낸다. 이후의 말은 수정 요청으로 받지 않는다. (사진과 문구는 "다른 컨셉으로"를 위해 기억해 둔다)
  if (utterance === "좋아요") {
    await saveState(c.env, userId, { photoUrl: state.photoUrl, lastText: state.lastText });
    return c.json(
      textResponse(
        "좋아요! 이미지를 길게 눌러 저장한 뒤 인스타나 네이버에 올려 주세요.\n같은 사진으로 다른 느낌도 보고 싶으면 아래 버튼을 눌러 주세요.",
        quickReplies([OTHER_CONCEPT]),
      ),
    );
  }

  // 시안이 있으면 나머지 말은 수정 요청으로 본다.
  if (state.notice && utterance) {
    const notice = state.notice;
    return startJob("고치고 있어요. 30초~1분 정도 걸려요.", (cb) => ({
      kind: "revise",
      userId,
      callbackUrl: cb,
      origin,
      photoUrl: state.photoUrl,
      notice,
      instruction: utterance,
    }));
  }

  // "다른 컨셉으로"를 누른 뒤의 말은 새 컨셉으로 받는다. 따옴표가 있으면 새 문구, 없으면 지난 문구를 그대로 쓴다.
  if (state.awaitingConcept && state.photoUrl && state.lastText && utterance) {
    const { concept, texts } = parseMessage(utterance);
    const text = texts.length ? toNoticeText(texts) : state.lastText;
    if ("error" in text) return c.json(textResponse(text.error));
    return makeNotice(state.photoUrl, concept, text);
  }

  // 컨셉만 받고 문구를 기다리던 중이면, 이번 말은 문구로 받는다. (따옴표가 없어도 전체를 문구로 쓴다)
  if (state.pendingConcept !== undefined && state.photoUrl && utterance) {
    if (utterance === NO_TEXT_REPLY)
      return makeNotice(state.photoUrl, state.pendingConcept, { title: "" });
    const { texts } = parseMessage(utterance);
    const text = toNoticeText(texts.length ? texts : [utterance]);
    if ("error" in text)
      return c.json(textResponse(text.error, quickReplies([NO_TEXT_REPLY])));
    return makeNotice(state.photoUrl, state.pendingConcept, text);
  }

  // 사진 다음에 오는 말은 컨셉과 문구로 읽는다. 따옴표 안만 사진에 들어간다.
  if (state.photoUrl && utterance) {
    const { concept, texts } = parseMessage(utterance);
    if (!texts.length) {
      // 문구를 빠뜨렸을 수 있으니 바로 만들지 않고 한 번 묻는다.
      await saveState(c.env, userId, {
        photoUrl: state.photoUrl,
        pendingConcept: concept,
      });
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

  return c.json(
    textResponse("강아지 사진을 보내 주시면 공지 이미지를 만들어 드려요."),
  );
});
