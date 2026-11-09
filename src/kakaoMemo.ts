// 카카오 "나에게 보내기"로 부모님 카톡(나와의 채팅)에 먼저 메시지를 보낸다.
// 챗봇은 사용자가 말을 걸어야만 답할 수 있으므로, 기념일 안내처럼 먼저 알리는 메시지는 이 통로를 쓴다.
//
// 연결 순서: 부모님이 /kakao/oauth/start?invite=초대코드 링크를 열어 카카오 로그인·동의
//   → /kakao/oauth/callback에서 토큰을 받아 R2에 저장 → 이후 서버가 언제든 메시지를 보낼 수 있다.

import { Hono } from "hono";
import type { Env } from "./notices";

type Tokens = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms
  refreshExpiresAt: number; // ms
};

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error_description?: string;
};

const TOKEN_PREFIX = "kakao/oauth/tokens/";
const STATE_PREFIX = "kakao/oauth/state/";
const DAY = 24 * 60 * 60 * 1000;

const redirectUri = (env: Env) => `${env.PUBLIC_ORIGIN}/kakao/oauth/callback`;

export const kakaoOAuth = new Hono<{ Bindings: Env }>();

// ---------- 카카오 로그인 (부모님이 한 번만) ----------

kakaoOAuth.get("/start", async (c) => {
  // 아무나 연결하지 못하도록 초대 코드가 맞을 때만 진행한다.
  const invite = c.env.REMINDER_INVITE_CODE?.trim();
  if (!invite || c.req.query("invite") !== invite) return c.text("잘못된 링크예요.", 403);
  if (!c.env.KAKAO_REST_API_KEY) return c.text("서버에 KAKAO_REST_API_KEY가 설정되지 않았어요.", 500);

  // 다른 사이트가 콜백을 흉내 내지 못하도록 일회용 state를 만든다.
  const state = crypto.randomUUID();
  await c.env.BUCKET.put(`${STATE_PREFIX}${state}`, String(Date.now()));

  const url = new URL("https://kauth.kakao.com/oauth/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.env.KAKAO_REST_API_KEY,
    redirect_uri: redirectUri(c.env),
    state,
    scope: "talk_message",
  }).toString();
  return c.redirect(url.toString());
});

kakaoOAuth.get("/callback", async (c) => {
  const { code, state, error } = c.req.query();
  if (error) return c.html(page("연결을 취소했어요. 다시 하려면 받은 링크를 다시 눌러 주세요."));
  if (!code || !state || !/^[\w-]+$/.test(state)) return c.html(page("잘못된 요청이에요."), 400);

  const stateKey = `${STATE_PREFIX}${state}`;
  const saved = await c.env.BUCKET.get(stateKey);
  await c.env.BUCKET.delete(stateKey);
  if (!saved || Date.now() - Number(await saved.text()) > 10 * 60 * 1000) {
    return c.html(page("링크가 만료됐어요. 받은 링크를 다시 눌러 주세요."), 400);
  }

  try {
    const token = await tokenRequest(c.env, {
      grant_type: "authorization_code",
      redirect_uri: redirectUri(c.env),
      code,
    });
    const me = (await (
      await fetch("https://kapi.kakao.com/v2/user/me", {
        headers: { authorization: `Bearer ${token.access_token}` },
      })
    ).json()) as { id?: number };
    if (!me.id) throw new Error("카카오 사용자 정보를 받지 못했어요.");

    const now = Date.now();
    const tokens: Tokens = {
      userId: String(me.id),
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? "",
      expiresAt: now + token.expires_in * 1000,
      refreshExpiresAt: now + (token.refresh_token_expires_in ?? 0) * 1000,
    };
    await saveTokens(c.env, tokens);
    await sendMemo(c.env, tokens, "공지 알림이 연결됐어요! 🐶\n기념일이 다가오면 여기로 미리 알려 드릴게요.");
    return c.html(page("연결됐어요! 카톡 '나와의 채팅'에 확인 메시지가 왔는지 봐 주세요. 이 창은 닫아도 돼요."));
  } catch (err) {
    console.log("kakao oauth failed", err instanceof Error ? err.message : err);
    return c.html(page("연결하지 못했어요. 잠시 뒤 다시 시도해 주세요."), 500);
  }
});

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>공지 알림 연결</title><body style="font-family:sans-serif;padding:32px;font-size:18px;line-height:1.6">${message}</body>`;
}

// ---------- 토큰 ----------

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: env.KAKAO_REST_API_KEY, ...params });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(`카카오 토큰 오류 (${res.status}) ${json.error_description ?? ""}`);
  return json;
}

async function saveTokens(env: Env, tokens: Tokens) {
  await env.BUCKET.put(`${TOKEN_PREFIX}${tokens.userId}.json`, JSON.stringify(tokens), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadAllTokens(env: Env): Promise<Tokens[]> {
  const list = await env.BUCKET.list({ prefix: TOKEN_PREFIX });
  const all = await Promise.all(list.objects.map(async (o) => (await env.BUCKET.get(o.key))?.json<Tokens>()));
  return all.filter((t): t is Tokens => Boolean(t));
}

// 액세스 토큰(몇 시간)을 새로 받는다. 리프레시 토큰(약 2달)은 만료가 1달 안으로 남았을 때만 새로 온다.
async function refresh(env: Env, tokens: Tokens): Promise<Tokens> {
  const res = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  const now = Date.now();
  const next: Tokens = {
    ...tokens,
    accessToken: res.access_token,
    expiresAt: now + res.expires_in * 1000,
    ...(res.refresh_token
      ? { refreshToken: res.refresh_token, refreshExpiresAt: now + (res.refresh_token_expires_in ?? 0) * 1000 }
      : {}),
  };
  await saveTokens(env, next);
  return next;
}

// 매일 크론에서 부른다. 기념일 사이가 2달 넘게 비어도 연결이 끊기지 않도록 리프레시 토큰을 미리 갱신한다.
export async function keepTokensAlive(env: Env) {
  for (const tokens of await loadAllTokens(env)) {
    if (tokens.refreshExpiresAt - Date.now() > 30 * DAY) continue;
    try {
      await refresh(env, tokens);
      console.log("kakao token refreshed", tokens.userId);
    } catch (err) {
      console.log("kakao token refresh failed", tokens.userId, err instanceof Error ? err.message : err);
    }
  }
}

// ---------- 나에게 보내기 ----------

async function sendMemo(env: Env, tokens: Tokens, text: string) {
  // 버튼을 누르면 우리 서버의 /go/chat을 거쳐 챗봇 채팅방으로 이동한다.
  // (링크 도메인은 카카오 개발자 콘솔에 등록한 사이트 도메인이어야 한다)
  const link = `${env.PUBLIC_ORIGIN}/go/chat`;
  const template = {
    object_type: "text",
    text: text.slice(0, 200), // 텍스트 템플릿은 200자까지
    link: { web_url: link, mobile_web_url: link },
    button_title: "챗봇 열기",
  };
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (!res.ok) throw new Error(`나에게 보내기 실패 (${res.status}) ${await res.text()}`);
}

// 연결된 모든 카톡(부모님 두 분 등)에 보낸다. 보낸 수를 돌려준다.
export async function sendMemoToAll(env: Env, text: string): Promise<number> {
  const accounts = await loadAllTokens(env);
  if (!accounts.length) throw new Error("연결된 카톡이 없어요. 초대 링크로 먼저 연결해 주세요.");
  let sent = 0;
  for (let tokens of accounts) {
    try {
      if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) tokens = await refresh(env, tokens);
      await sendMemo(env, tokens, text);
      sent++;
    } catch (err) {
      console.log("kakao memo failed", tokens.userId, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}
