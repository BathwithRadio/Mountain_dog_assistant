import { Hono } from "hono";
import type { Env } from "./notices";

type SkillRequest = {
  userRequest?: {
    utterance?: string;
    user?: { id?: string };
    callbackUrl?: string;
  };
  action?: {
    params?: Record<string, unknown>;
    detailParams?: Record<string, unknown>;
  };
};

export const kakao = new Hono<{ Bindings: Env }>();

function simpleText(text: string) {
  return { version: "2.0", template: { output: [{ simpleText: { text } }] } };
}

kakao.post("/skill", async (c) => {
  // 오픈빌더 스킬 설정의 헤더값 (X-Skill-Secret)와 서버 secret이 같을 때만 응답한다.
  const secret = c.env.KAKAO_SKILL_SECRET?.trim();
  if (!secret || c.req.header("x-skill-secret") !== secret) {
    return c.json({ error: "unauthrozied" }, 401);
  }

  const body = (await c.req.json()) as SkillRequest;
  //사진이 어떤 형식으로 들어오는지 확인하려고 요청 전체를 남김 - npx wrangler tail로 확인
  console.log("kakao skill request", JSON.stringify(body));

  const userId = body.userRequest?.user?.id ?? "알 수 없음";
  const utterance = body.userRequest?.utterance ?? "";
  return c.json(simpleText(`받은 말: ${utterance}\n 내 사용자 ID: ${userId}`));
});
