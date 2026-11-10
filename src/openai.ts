// OpenAI 이미지 편집 API(ChatGPT 이미지 모델)로 강아지 사진을 기념일 이미지로 바꾼다.

export type GeneratedImage = { data: Uint8Array; mimeType: string };

type OpenAIImageResponse = {
  data?: { b64_json?: string }[];
  error?: { message: string };
};

export async function generateImage(opts: {
  apiKey: string;
  model: string;
  photo: Uint8Array;
  photoMimeType: string;
  prompt: string;
}): Promise<GeneratedImage> {
  const form = new FormData();
  form.append("model", opts.model);
  form.append("prompt", opts.prompt);
  form.append("image[]", new Blob([opts.photo], { type: opts.photoMimeType }), "photo");
  // 원본 사진 비율에 가깝게 만든다. 세로로 고정하면 얼굴 사진의 위아래를 새로 그려 넣게 된다.
  // (마지막에 글자를 얹을 때 4:5로 가운데를 잘라낸다)
  form.append("size", "auto");
  form.append("quality", "medium");
  // gpt-image-2는 input_fidelity 옵션을 받지 않는다. 원본 유지는 프롬프트로 요청한다.

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });

  const body = (await res.json()) as OpenAIImageResponse;
  if (!res.ok) {
    throw new Error(`OpenAI 요청 실패 (${res.status}): ${body.error?.message ?? "알 수 없는 오류"}`);
  }

  const b64 = body.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI 응답에 이미지가 없습니다.");
  }
  return { data: new Uint8Array(Buffer.from(b64, "base64")), mimeType: "image/png" };
}
