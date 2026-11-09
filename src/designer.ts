// 디자인 에이전트: 배경 이미지를 보고 제목 폰트·글자 위치·글자색을 고른다.
// 고른 값으로 실제 렌더링한 결과를 다시 보여 주고, 스스로 확인한 뒤 확정한다.
// OpenAI Responses API의 함수 호출(도구)과 이미지 입력을 쓴다.

import type { LoadedFont } from "./fonts";
import { overlayText, type Layout, type OverlayText } from "./overlay";

export type TitleFont = "rounded" | "bold" | "basic";
export type Design = Layout & { titleFont: TitleFont; reason: string };

const MAX_TURNS = 3; // 미리보기 최대 2번 + 확정 1번
const TIMEOUT_MS = 12_000; // 카카오 콜백 시간 안에 끝나도록 전체 제한

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    titleFont: { type: "string", enum: ["rounded", "bold", "basic"] },
    position: { type: "string", enum: ["top", "bottom"] },
    textColor: { type: "string", enum: ["white", "dark"] },
    reason: { type: "string", description: "이렇게 고른 이유 한 줄" },
  },
  required: ["titleFont", "position", "textColor", "reason"],
  additionalProperties: false,
};

const TOOLS = [
  {
    type: "function",
    name: "render_preview",
    description: "고른 디자인으로 글자를 얹은 미리보기를 만든다. 결과 이미지를 다음 메시지로 보여 준다.",
    parameters: DESIGN_SCHEMA,
    strict: true,
  },
  {
    type: "function",
    name: "finalize",
    description: "미리보기가 괜찮을 때 그 디자인으로 확정한다.",
    parameters: DESIGN_SCHEMA,
    strict: true,
  },
];

const INSTRUCTIONS = `너는 애견카페 공지 이미지의 디자이너다. 배경 이미지 위에 한글 제목과 안내 문구를 얹을 디자인을 고른다.
- 강아지 얼굴과 몸을 글자가 가리면 안 된다. 배경이 단순하고 비어 있는 쪽(top 또는 bottom)을 고른다.
- 글자색은 배경과 대비가 큰 쪽을 고른다. 밝은 배경이면 dark, 어둡거나 복잡하면 white.
- 제목 폰트: rounded는 귀엽고 말랑한 분위기, bold는 또렷하고 단정한 분위기, basic은 무난한 기본.
- 먼저 render_preview로 미리보기를 만들고, 결과를 보고 괜찮으면 같은 값으로 finalize를 부른다.
- 글자가 강아지를 가리거나 잘 안 읽히면 값을 바꿔 render_preview를 한 번 더 부른다.`;

type ResponseOutput = { type: string; name?: string; call_id?: string; arguments?: string };

async function callResponses(apiKey: string, body: unknown, signal: AbortSignal) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json()) as { id: string; output: ResponseOutput[]; error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `OpenAI 오류 (${res.status})`);
  return json;
}

function parseDesign(args: string | undefined): Design | undefined {
  try {
    const d = JSON.parse(args ?? "");
    if (!["rounded", "bold", "basic"].includes(d.titleFont)) return;
    if (!["top", "bottom"].includes(d.position)) return;
    if (!["white", "dark"].includes(d.textColor)) return;
    return { titleFont: d.titleFont, position: d.position, textColor: d.textColor, reason: String(d.reason ?? "") };
  } catch {}
}

const sameLayout = (a: Design, b: Design) =>
  a.titleFont === b.titleFont && a.position === b.position && a.textColor === b.textColor;

const dataUrl = (data: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

export async function designNotice(opts: {
  apiKey: string;
  model: string;
  image: { data: Uint8Array; mimeType: string };
  text: OverlayText;
  concept?: string; // 카톡에서 사장님이 적은 컨셉. 폰트 분위기를 고를 때 참고한다.
  fonts: Record<TitleFont, LoadedFont>;
  fallback: Design;
}): Promise<{ design: Design; png: Uint8Array }> {
  const render = (d: Design) =>
    overlayText(
      opts.image.data,
      opts.image.mimeType,
      opts.text,
      { title: opts.fonts[d.titleFont], body: opts.fonts.basic },
      d,
    );

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let last: { design: Design; png: Uint8Array } | undefined;
  let previousId: string | undefined;
  let input: unknown[] = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `${opts.concept ? `컨셉: ${opts.concept}\n` : ""}제목: ${opts.text.title || "(없음)"}\n안내 문구: ${opts.text.subtitle ?? "(없음)"}\n추천 폰트: ${opts.fallback.titleFont}\n아래는 글자를 얹을 배경 이미지다.`,
        },
        { type: "input_image", image_url: dataUrl(opts.image.data, opts.image.mimeType), detail: "low" },
      ],
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const started = Date.now();
      const res = await callResponses(
        opts.apiKey,
        {
          model: opts.model,
          instructions: INSTRUCTIONS,
          input,
          tools: TOOLS,
          tool_choice: "required", // 매번 도구를 부르게 한다
          parallel_tool_calls: false,
          reasoning: { effort: "minimal" }, // 빠르게 답하도록 생각을 최소로. 추론 모델이 아니면 이 줄을 지운다
          previous_response_id: previousId,
        },
        signal,
      );
      previousId = res.id;
      console.log("designer turn", turn + 1, `${Date.now() - started}ms`);

      const call = res.output.find((o) => o.type === "function_call");
      if (!call) break;
      const design = parseDesign(call.arguments);
      if (!design) {
        input = [{ type: "function_call_output", call_id: call.call_id, output: "값이 잘못됐어요. 다시 골라 주세요." }];
        continue;
      }
      console.log("designer", call.name, JSON.stringify(design));

      if (call.name === "finalize") {
        if (last && sameLayout(last.design, design)) return { design, png: last.png };
        return { design, png: await render(design) };
      }

      // render_preview: 실제로 그려서 결과를 에이전트에게 보여 준다.
      const png = await render(design);
      last = { design, png };
      input = [
        { type: "function_call_output", call_id: call.call_id, output: "미리보기를 만들었어요. 다음 이미지를 확인하세요." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "이 미리보기가 괜찮으면 finalize, 아니면 값을 바꿔 render_preview를 다시 부르세요." },
            { type: "input_image", image_url: dataUrl(png, "image/png"), detail: "low" },
          ],
        },
      ];
    }
  } catch (err) {
    // 시간 초과나 API 오류여도 공지는 만들어야 하므로 아래 대체안으로 넘어간다.
    console.log("designer failed", err instanceof Error ? err.message : err);
  }

  return last ?? { design: opts.fallback, png: await render(opts.fallback) };
}
