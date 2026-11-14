// 이미지 모델(OpenAI 이미지 편집)에 넘기는 프롬프트.
// 글자는 overlay.ts에서 코드로 얹으므로, 이미지에는 어떤 글자도 그리지 않게 한다.
// 사장님 말 원문은 넘기지 않고, visualConcept.ts가 뽑은 시각적 요청만 넘긴다.

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
  "Do not add any text, letters, numbers, logos or watermarks anywhere in the image, even if the request mentions notice text.",
  "Do not draw chalkboards, signs, menus, papers, banners or screens with writing on them. If such an object appears, leave it blank.",
].join(" ");

// 이미 만든 시안(글자 없는 이미지)을 조금만 고칠 때 쓰는 프롬프트
export function buildRevisionPrompt(instruction: string): string {
  return [
    `Edit this image with only this change: ${instruction}.`,
    "Keep everything else the same: the dog's appearance, pose and position, the framing, colors, lighting and art style.",
    KEEP_ORIGINAL,
  ].join(" ");
}

// 새 공지를 만들 때 쓰는 프롬프트(카톡과 웹 테스트 화면 공통). visualConcept는 사장님 말에서 시각적 요청만 뽑은 영어 설명이다(visualConcept.ts).
// 사장님 말 원문은 넘기지 않는다. 원문을 넘기면 지시 문장을 그림 속 글씨로 그려 넣는다.
export function buildConceptPrompt(visualConcept: string): string {
  return [
    "Edit this photo into a social media notice image for a dog cafe.",
    visualConcept
      ? `Apply these visual changes: ${visualConcept}`
      : "Place the dog in a bright, clean and cozy dog cafe setting.",
    "Follow the art style requested above (for example cartoon or illustration). If no style is mentioned, keep it photo-realistic with warm, inviting lighting.",
    KEEP_ORIGINAL,
  ].join(" ");
}
