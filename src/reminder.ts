// 기념일 안내 에이전트. 매일 아침 크론으로 실행된다.
// 날짜 계산(어떤 기념일이 정확히 3일 뒤인지)은 코드가 하고,
// "애견카페 공지로 만들 만한가, 이미 안내했나/만들었나, 뭐라고 안내할까"는 에이전트가 판단한다.
// 기념일 목록은 holidays.ts에서 관리한다.

import { API_HOLIDAY_KEYS, FIXED_HOLIDAYS, type HolidayRule, REMIND_DAYS_BEFORE } from "./holidays";
import { keepTokensAlive, sendMemoToAll } from "./kakaoMemo";
import type { Env, NoticeMeta } from "./notices";

type Occasion = { key: string; name: string; date: string; daysLeft: number; rule: HolidayRule };
type DatedHoliday = { key: string; name: string; date: string; rule: HolidayRule };

const MAX_TURNS = 6;
const DAY = 24 * 60 * 60 * 1000;

// ---------- 날짜 ----------

export function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

// 공휴일(설날·추석처럼 해마다 바뀌는 날 포함)은 공공데이터포털 특일 정보 API로 받는다. (키가 없으면 건너뜀)
async function publicHolidays(env: Env, months: string[]): Promise<DatedHoliday[]> {
  if (!env.SPCDE_API_KEY) return [];
  const result: DatedHoliday[] = [];
  for (const month of months) {
    const [year, mm] = month.split("-");
    const url =
      "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo" +
      `?serviceKey=${encodeURIComponent(env.SPCDE_API_KEY)}&solYear=${year}&solMonth=${mm}&_type=json`;
    try {
      type Item = { dateName: string; locdate: number };
      const json = (await (await fetch(url)).json()) as {
        response?: { body?: { items?: { item?: Item | Item[] } | "" } };
      };
      const items = json.response?.body?.items;
      const list = items && typeof items === "object" && items.item ? [items.item].flat() : [];
      for (const item of list) {
        const name = item.dateName.trim();
        const key = API_HOLIDAY_KEYS[name] ?? `holiday-${name.replace(/\s+/g, "")}`;
        const d = String(item.locdate);
        result.push({ key, name, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, rule: "must" });
      }
    } catch (err) {
      console.log("holiday api failed", month, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

// 정확히 3일 뒤에 시작하는 기념일. 설날·추석처럼 며칠 이어지는 날은 첫날 기준으로 한 번만 안내한다.
export async function upcomingOccasions(env: Env, today: string): Promise<Occasion[]> {
  const target = addDays(today, REMIND_DAYS_BEFORE);
  const years = [...new Set([today.slice(0, 4), target.slice(0, 4)])];
  const months = [...new Set([today.slice(0, 7), target.slice(0, 7)])];
  const all: DatedHoliday[] = [
    ...years.flatMap((y) => FIXED_HOLIDAYS.map((h) => ({ key: h.key, name: h.name, date: `${y}-${h.monthDay}`, rule: h.rule }))),
    ...(await publicHolidays(env, months)),
  ];

  // 같은 해 같은 key는 가장 이른 날(연휴 첫날)만 남긴다. 둘 다 있으면 must를 우선한다.
  const first = new Map<string, DatedHoliday>();
  for (const h of all) {
    const id = `${h.date.slice(0, 4)}-${h.key}`;
    const prev = first.get(id);
    if (!prev || h.date < prev.date) first.set(id, { ...h, rule: prev?.rule === "must" ? "must" : h.rule });
    else if (h.rule === "must") prev.rule = "must";
  }
  return [...first.values()]
    .filter((h) => h.date === target)
    .map((h) => ({ ...h, daysLeft: REMIND_DAYS_BEFORE }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- 도구가 읽는 기록 ----------

const reminderKey = (o: Occasion) => `reminders/${o.date.slice(0, 4)}-${o.key}.json`;

async function recentNotices(env: Env, today: string) {
  const thisMonth = today.slice(0, 7);
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7);
  const keys: string[] = [];
  for (const month of [lastMonth, thisMonth]) {
    const list = await env.BUCKET.list({ prefix: `notices/${month}` });
    keys.push(...list.objects.map((o) => o.key).filter((k) => k.endsWith("/meta.json")));
  }
  const latest = keys.sort().reverse().slice(0, 10);
  return Promise.all(
    latest.map(async (key) => {
      const meta = (await (await env.BUCKET.get(key))?.json<NoticeMeta>()) ?? undefined;
      const id = key.split("/")[1];
      return { date: id.slice(0, 10), concept: meta?.concept ?? meta?.occasion, title: meta?.title };
    }),
  );
}

async function reminderHistory(env: Env, today: string) {
  const list = await env.BUCKET.list({ prefix: `reminders/${today.slice(0, 4)}-` });
  return list.objects.map((o) => ({ reminder: o.key.slice("reminders/".length, -".json".length), sentAt: o.uploaded }));
}

// ---------- 에이전트 ----------

const NO_PARAMS = { type: "object", properties: {}, required: [], additionalProperties: false };

const TOOLS = [
  {
    type: "function",
    name: "get_recent_notices",
    description: "최근 두 달 동안 만든 공지 목록(날짜, 컨셉, 제목)을 본다. 이미 그 기념일 공지를 만들었는지 확인할 때 쓴다.",
    parameters: NO_PARAMS,
    strict: true,
  },
  {
    type: "function",
    name: "get_reminder_history",
    description: "올해 이미 보낸 기념일 안내 목록을 본다.",
    parameters: NO_PARAMS,
    strict: true,
  },
  {
    type: "function",
    name: "send_reminder",
    description: "사장님 카톡으로 기념일 안내를 보낸다. 기념일 하나에 한 번만 보낸다.",
    parameters: {
      type: "object",
      properties: {
        occasion_key: { type: "string", description: "안내할 기념일의 key" },
        message: { type: "string", description: "보낼 안내 문장. 180자 이내." },
      },
      required: ["occasion_key", "message"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "finish",
    description: "할 일을 마친다. 보낼 안내가 없을 때도 이것으로 끝낸다.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "오늘 판단 요약 한 줄" } },
      required: ["summary"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const INSTRUCTIONS = `너는 애견카페를 운영하는 사장님(컴퓨터에 익숙하지 않은 부모님 세대)을 돕는 비서다.
3일 뒤의 기념일 후보를 보고, 미리 공지 이미지를 만들어 두라고 카톡으로 안내한다.

후보에는 [필수]와 [판단]이 붙어 있다.
- [필수]: 영업 시간이 바뀌거나 손님이 몰릴 수 있는 날이다. 이미 안내한 경우만 빼고 반드시 send_reminder로 안내한다.
- [판단]: 강아지·반려동물 기념일이다. get_recent_notices로 그 기념일 공지를 이미 만들었는지 보고, 이미 만들었으면 보내지 않는다. 아니면 사진 이벤트 공지에 어울리는지 판단해 안내한다.

판단 순서:
1. get_reminder_history로 이미 안내한 기념일인지 확인한다. 이미 안내했으면 다시 보내지 않는다.
2. [판단] 후보가 있으면 get_recent_notices를 확인한다.
3. 보낼 기념일마다 send_reminder를 한 번씩 부르고, 다 끝나면 finish를 부른다.

안내 문장 규칙 (180자 이내, 존댓말, 따뜻하고 짧게):
- 첫 줄: "3일 뒤(12월 25일)는 크리스마스예요!"처럼 남은 날짜 수와 날짜를 정확히 쓰고, 공지를 미리 만들어 두면 좋다고 짧게 권한다.
- 둘째 줄: 챗봇에 그대로 따라 보낼 수 있는 예시 한 줄. 형식: 사진을 어떻게 바꿀지(강아지 옷·소품·배경) + 공지는 "공지 문구"
  예) 크리스마스 컨셉으로 산타 모자를 씌우고 배경을 바꿔줘, 공지는 "크리스마스 당일 OO시까지 운영합니다"
- 이벤트, 할인, 간식 제공, 영업 시간 같은 사실은 절대 지어내지 않는다. 시간처럼 사장님만 아는 내용은 "OO시"로 비워 둔다.`;

type ResponseOutput = { type: string; name?: string; call_id?: string; arguments?: string };

async function callResponses(apiKey: string, body: unknown) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { id: string; output: ResponseOutput[]; error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `OpenAI 오류 (${res.status})`);
  return json;
}

export type ReminderResult = { today: string; occasions: Occasion[]; sent: string[]; summary: string };

export async function runReminderAgent(
  env: Env,
  options: { today?: string; dryRun?: boolean } = {},
): Promise<ReminderResult> {
  const today = options.today ?? kstToday();
  const dryRun = options.dryRun ?? env.REMINDER_DRY_RUN === "true";

  // 안내할 게 없는 날에도 카톡 연결이 끊기지 않게 토큰은 매일 갱신한다.
  if (!dryRun) await keepTokensAlive(env);

  const occasions = await upcomingOccasions(env, today);
  // 후보가 없으면 에이전트를 부르지 않는다. (대부분의 날)
  if (!occasions.length) return { today, occasions, sent: [], summary: "3일 뒤 기념일 없음" };

  const sent: string[] = [];
  let summary = "";

  // 안내를 실제로 보내고 기록한다. 시험 실행(dryRun)에서는 보내지도 기록하지도 않는다.
  const deliver = async (occasion: Occasion, text: string) => {
    const message = text.slice(0, 200);
    const count = dryRun ? 0 : await sendMemoToAll(env, message);
    if (!dryRun) {
      await env.BUCKET.put(reminderKey(occasion), JSON.stringify({ message, sentTo: count }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    sent.push(`${occasion.key}: ${message}`);
    return dryRun ? "시험 실행이라 보내지 않았어요." : `${count}명에게 보냈어요.`;
  };
  let previousId: string | undefined;
  let input: unknown[] = [
    {
      role: "user",
      content: `오늘: ${today}\n다가오는 기념일 후보:\n${occasions
        .map((o) => `- [${o.rule === "must" ? "필수" : "판단"}] key=${o.key}, ${o.name}, ${o.date} (${o.daysLeft}일 뒤)`)
        .join("\n")}`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS && !summary; turn++) {
    const res = await callResponses(env.OPENAI_API_KEY, {
      model: env.OPENAI_DESIGN_MODEL,
      instructions: INSTRUCTIONS,
      input,
      tools: TOOLS,
      tool_choice: "required",
      reasoning: { effort: "low" }, // 크론이라 급하지 않으므로 조금 더 생각하게 한다
      previous_response_id: previousId,
    });
    previousId = res.id;

    // 이번 턴에 부른 도구들을 모두 실행하고 결과를 돌려준다.
    input = [];
    for (const call of res.output.filter((o) => o.type === "function_call")) {
      const args = JSON.parse(call.arguments ?? "{}");
      console.log("reminder tool", call.name, call.arguments);
      let output: unknown;

      if (call.name === "get_recent_notices") {
        output = await recentNotices(env, today);
      } else if (call.name === "get_reminder_history") {
        output = await reminderHistory(env, today);
      } else if (call.name === "send_reminder") {
        const occasion = occasions.find((o) => o.key === args.occasion_key);
        const already = occasion && (await env.BUCKET.head(reminderKey(occasion)));
        if (!occasion) {
          output = "후보에 없는 기념일이에요.";
        } else if (already) {
          output = "이미 안내한 기념일이에요.";
        } else {
          output = await deliver(occasion, String(args.message));
        }
      } else if (call.name === "finish") {
        summary = String(args.summary ?? "완료");
        output = "끝";
      } else {
        output = "없는 도구예요.";
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
    }
    if (!input.length) break;
  }

  // [필수] 기념일을 에이전트가 빠뜨렸으면 기본 문장으로라도 보낸다.
  for (const occasion of occasions.filter((o) => o.rule === "must")) {
    if (sent.some((line) => line.startsWith(`${occasion.key}:`))) continue;
    if (await env.BUCKET.head(reminderKey(occasion))) continue;
    const [, m, d] = occasion.date.split("-").map(Number);
    await deliver(
      occasion,
      `${occasion.daysLeft}일 뒤(${m}월 ${d}일)는 ${occasion.name}이에요! 공지를 미리 만들어 두면 좋아요.\n챗봇에 강아지 사진을 보내고 컨셉과 "공지 문구"를 적어 보세요.`,
    );
    console.log("reminder fallback sent", occasion.key);
  }

  const result = { today, occasions, sent, summary: summary || "턴 제한으로 종료" };
  console.log("reminder result", JSON.stringify(result));
  return result;
}
