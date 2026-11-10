// 기념일별 이미지 생성 프롬프트. 글자는 overlay.ts에서 코드로 얹으므로
// 모델에게는 글자를 넣지 말고 아래쪽을 비워 두라고 요청한다.

import type { FontStyle } from "./fonts";

export type Occasion = {
  label: string;
  scene: string;
  defaultTitle: string;
  // 제목 폰트 분위기. 해당 폰트가 R2에 없으면 기본 폰트로 대신한다.
  titleFont: FontStyle;
};

export const OCCASIONS: Record<string, Occasion> = {
  christmas: {
    label: "크리스마스",
    scene:
      "a cozy Christmas scene with a decorated tree, warm string lights, gift boxes and a small Santa hat on the dog",
    defaultTitle: "메리 크리스마스",
    titleFont: "rounded",
  },
  halloween: {
    label: "할로윈",
    scene:
      "a cute, not scary Halloween scene with jack-o'-lanterns, autumn leaves and a small witch hat or cape on the dog",
    defaultTitle: "해피 할로윈",
    titleFont: "rounded",
  },
  newyear: {
    label: "새해",
    scene:
      "a bright New Year celebration with soft confetti, golden balloons and a festive ribbon on the dog",
    defaultTitle: "새해 복 많이 받으세요",
    titleFont: "rounded",
  },
  seollal: {
    label: "설날",
    scene:
      "a Korean Lunar New Year (Seollal) scene with a colorful hanbok-style outfit on the dog, traditional patterns and yut-nori pieces",
    defaultTitle: "설 연휴 영업 안내",
    titleFont: "bold",
  },
  chuseok: {
    label: "추석",
    scene:
      "a Korean Chuseok harvest festival scene with a full moon, songpyeon rice cakes, persimmons and a hanbok-style outfit on the dog",
    defaultTitle: "추석 연휴 영업 안내",
    titleFont: "bold",
  },
  notice: {
    label: "일반 공지",
    scene: "a clean, bright cafe interior with soft natural light and a few plants",
    defaultTitle: "영업 안내",
    titleFont: "bold",
  },
};

// 시안마다 분위기를 다르게 해서 고를 수 있게 한다.
const VARIANT_STYLES = [
  "photo-realistic, warm and cozy lighting",
  "soft pastel colors, gentle storybook feel while keeping the dog realistic",
  "bright, cheerful and colorful, playful composition",
];

// 모든 이미지 프롬프트에 공통으로 넣는 규칙.
// 원본 사진의 구도를 지키고, 요청하지 않은 것(특히 보이지 않던 몸)을 지어내지 않게 한다.
// 글자 자리는 디자인 에이전트가 위·아래 중 빈 곳을 골라 정하므로, 이미지에서 미리 비워 두라고 하지 않는다.
const KEEP_ORIGINAL = [
  "Keep the dog exactly as it is: same breed, face, fur color, markings, expression and pose. Do not replace it with a different dog.",
  "Keep the original framing and crop of the photo. Show only the parts of the dog that are visible in the original photo:",
  "if it is a close-up of the face, keep it a face close-up and do not draw the body, legs or paws. Do not zoom out or extend the scene beyond the original frame.",
  "Change only what is requested (outfit, accessories, background, art style). Do not add other objects, animals or people that were not requested.",
  "If an outfit is requested but the dog's body is not visible, show only the part that fits in the frame (such as the collar area) or use headwear instead.",
  "The final image will be cropped to a 4:5 portrait around the center, so keep the dog's face near the center.",
  "Do not add any text, letters, numbers, logos or watermarks, even if the request mentions notice text.",
].join(" ");

export function buildPrompt(occasion: Occasion, variant: number, extra?: string): string {
  const style = VARIANT_STYLES[variant % VARIANT_STYLES.length];
  return [
    "Edit this photo into a social media notice image for a dog cafe.",
    `Change the background and decorations to ${occasion.scene}.`,
    `Style: ${style}.`,
    extra ? `Additional request: ${extra}` : "",
    KEEP_ORIGINAL,
  ]
    .filter(Boolean)
    .join(" ");
}

// 이미 만든 시안(글자 없는 이미지)을 조금만 고칠 때 쓰는 프롬프트
export function buildRevisionPrompt(instruction: string): string {
  return [
    `Edit this image with only this change: ${instruction}.`,
    "Keep everything else the same: the dog's appearance, pose and position, the framing, colors, lighting and art style.",
    KEEP_ORIGINAL,
  ].join(" ");
}

// 사장님이 말로 적은 컨셉(한국어)으로 장면을 만드는 프롬프트. 카카오 챗봇에서 쓴다.
export function buildConceptPrompt(concept: string): string {
  return [
    "Edit this photo into a social media notice image for a dog cafe.",
    `Apply this concept requested by the cafe owner (written in Korean): ${concept || "밝고 깔끔한 애견카페 분위기"}.`,
    "Follow the art style the concept asks for (for example cartoon or illustration). If no style is mentioned, keep it photo-realistic with warm, inviting lighting.",
    KEEP_ORIGINAL,
  ].join(" ");
}
