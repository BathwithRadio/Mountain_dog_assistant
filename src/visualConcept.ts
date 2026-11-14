// 사장님이 적은 말에서 "사진을 어떻게 바꿀지"만 뽑아 이미지 모델에 넘길 영어 장면 설명으로 바꾼다.
//
// 이미지 모델에 한국어 요청을 그대로 넘기면, "수요일에 일하고 목요일에 쉰다고 해줘" 같은
// 공지 내용이나 지시 문장을 칠판·간판 글씨로 그려 넣는 일이 생긴다.
// 그래서 이미지 생성 전에 작은 모델로 시각적인 요청(옷, 소품, 배경, 그림체)만 남기고,
// 공지 내용·영업 정보·지시 문장은 버린다. 시각적인 요청이 없으면 빈 문자열을 돌려준다.

const INSTRUCTIONS = `You turn a Korean dog-cafe owner's message into a short English description of visual changes for an image editing model.
Keep ONLY visual requests: outfits or accessories for the dog, background or setting, season or holiday decorations, lighting, art style (cartoon, illustration, etc.).
Drop everything else: notice text, opening hours, dates, closing days, prices, events, and any instructions about what to say or announce.
Never include any words that should appear as text in the image.
Translate faithfully: describe only what the owner asked for, in their own terms. Do not add props, colors or details they did not mention.
Only when the owner names a theme without details (e.g. just "Christmas concept"), you may add one or two typical elements of that theme.
If the message has no visual request at all, output exactly: NONE
Output one plain English sentence (or NONE), nothing else.

The message may contain leftover fragments where quoted notice text was removed (e.g. "공지는 로 해줘"); ignore them.`;

type ResponseBody = {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  error?: { message: string };
};

export async function toVisualConcept(opts: { apiKey: string; model: string; message: string }): Promise<string> {
  if (!opts.message.trim()) return "";
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        instructions: INSTRUCTIONS,
        input: opts.message,
        reasoning: { effort: "minimal" }, // 빠르게. 추론 모델이 아니면 이 줄을 지운다
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as ResponseBody;
    if (!res.ok) throw new Error(body.error?.message ?? `OpenAI 오류 (${res.status})`);
    const text = (body.output ?? [])
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join(" ")
      .trim();
    console.log("visual concept", JSON.stringify(text));
    return text === "NONE" ? "" : text.slice(0, 500);
  } catch (err) {
    // 실패하면 시각적 요청 없이 기본 장면으로 만든다. (원문을 넘기면 글씨를 그려 넣을 수 있으므로)
    console.log("visual concept failed", err instanceof Error ? err.message : err);
    return "";
  }
}
