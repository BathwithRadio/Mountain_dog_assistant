// 디자인 에이전트: 서버가 글자 배치 후보 3장을 실제로 그려 보여 주고,
// 에이전트는 그 결과를 보고 가장 좋은 후보와 제목 폰트를 한 번에 고른다.

import type { LoadedFont } from "./fonts";
import { overlayText, type Layout, type OverlayText } from "./overlay";

export type TitleFont = "rounded" | "bold" | "basic";
export type Design = Layout & { titleFont: TitleFont; reason: string };

const TIMEOUT_MS = 15_000;
const PREVIEW_WIDTH = 432; // 미리보기는 작게 그려 빠르게 보낸다

// 미리보기 후보 3장. 이미지 생성 때 아래쪽을 비워 두라고 하므로 아래쪽은 흰 글씨·어두운 글씨 둘 다,
// 위쪽은 배경이 복잡한 경우가 많아 그림자를 까는 흰 글씨만 둔다.
const CANDIDATES: Record<string, Layout> = {
  A: { position: "bottom", textColor: "white" },
  B: { position: "bottom", textColor: "dark" },
  C: { position: "top", textColor: "white" },
};

const TOOLS = [
  {
    type: "function",
    name: "choose_design",
    description: "미리보기 후보 중 가장 좋은 것과 제목 폰트를 고른다.",
    parameters: {
      type: "object",
      properties: {
        candidate: { type: "string", enum: Object.keys(CANDIDATES) },
        titleFont: { type: "string", enum: ["rounded", "bold"] }, // 기본 폰트는 고르지 않는다
        reason: { type: "string", description: "이렇게 고른 이유 한 줄" },
      },
      required: ["candidate", "titleFont", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const INSTRUCTIONS = `너는 애견카페 공지 이미지의 디자이너다. 같은 배경에 글자를 다르게 얹은 미리보기 후보들을 보고 가장 좋은 것을 고른다.
- 글자가 강아지 얼굴과 몸을 가리는 후보는 고르지 않는다.
- 글자가 배경과 대비가 커서 가장 또렷하게 읽히는 후보를 고른다.
- 제목 폰트는 rounded와 bold 중 컨셉과 분위기에 맞는 것을 고른다: rounded는 귀엽고 말랑하고 장난스러운 분위기(기념일, 놀이, 만화풍 등), bold는 또렷하고 단정한 분위기(영업 안내, 휴무, 가격 등).
- 미리보기는 모두 같은 폰트로 그려져 있으니, 폰트는 분위기만 보고 고른다.
- reason은 한국어 한 문장으로 쓰고, 위치와 폰트를 고른 이유를 모두 담는다.`;

type ResponseOutput = { type: string; name?: string; arguments?: string };

async function callResponses(apiKey: string, body: unknown, signal: AbortSignal) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json()) as { output: ResponseOutput[]; error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `OpenAI 오류 (${res.status})`);
  return json;
}

const dataUrl = (data: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

export async function designNotice(opts: {
  apiKey: string;
  model: string;
  image: { data: Uint8Array; mimeType: string };
  text: OverlayText;
  concept?: string;
  fonts: Record<TitleFont, LoadedFont>;
  fallback: Design;
}): Promise<{ design: Design; png: Uint8Array }> {
  const render = (d: Layout & { titleFont: TitleFont }, width?: number) =>
    overlayText(
      opts.image.data,
      opts.image.mimeType,
      opts.text,
      { title: opts.fonts[d.titleFont], body: opts.fonts.basic },
      d,
      width,
    );

  try {
    const started = Date.now();
    // 1. 후보 3장을 실제로 그린다.
    const labels = Object.keys(CANDIDATES);
    const previews: Uint8Array[] = [];
    for (const label of labels) {
      previews.push(await render({ ...CANDIDATES[label], titleFont: opts.fallback.titleFont }, PREVIEW_WIDTH));
    }

    // 2. 에이전트가 후보들을 보고 한 번에 고른다.
    const content: unknown[] = [
      {
        type: "input_text",
        text: `${opts.concept ? `컨셉: ${opts.concept}\n` : ""}제목: ${opts.text.title}\n안내 문구: ${opts.text.subtitle ?? "(없음)"}`,
      },
    ];
    labels.forEach((label, i) => {
      const c = CANDIDATES[label];
      content.push({ type: "input_text", text: `후보 ${label}: 위치=${c.position}, 글자색=${c.textColor}` });
      content.push({ type: "input_image", image_url: dataUrl(previews[i], "image/png"), detail: "low" });
    });

    const res = await callResponses(
      opts.apiKey,
      {
        model: opts.model,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content }],
        tools: TOOLS,
        tool_choice: "required",
        reasoning: { effort: "minimal" }, // 추론 모델이 아니면 이 줄을 지운다
      },
      AbortSignal.timeout(TIMEOUT_MS),
    );
    const call = res.output.find((o) => o.type === "function_call");
    const choice = JSON.parse(call?.arguments ?? "{}");
    const layout = CANDIDATES[choice.candidate];
    if (!layout || !["rounded", "bold"].includes(choice.titleFont)) throw new Error("잘못된 선택");

    const design: Design = { ...layout, titleFont: choice.titleFont, reason: String(choice.reason ?? "") };
    console.log("designer", `${Date.now() - started}ms`, JSON.stringify(design));
    // 3. 고른 디자인으로 원래 크기의 완성본을 그린다.
    return { design, png: await render(design) };
  } catch (err) {
    console.log("designer failed", err instanceof Error ? err.message : err);
    return { design: opts.fallback, png: await render(opts.fallback) };
  }
}
