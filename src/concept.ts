// 카톡 메시지를 컨셉과 공지 문구로 나눈다.
// 따옴표 안의 내용만 사진에 넣을 문구이고, 나머지는 이미지 컨셉(장면 설명)이다.
// 예) 크리스마스 컨셉으로 산타 옷을 입혀줘, 공지는 "마운틴독 크리스마스 당일에도 오픈합니다"로 해줘

// 휴대폰 키보드마다 따옴표 모양이 달라서 " “ ” 「」 『』 ‘’를 모두 받는다.
const QUOTED = /["“”]([^"“”]+)["“”]|[「『]([^」』]+)[」』]|‘([^’]+)’/g;

export type ParsedMessage = {
  concept: string;
  texts: string[]; // 따옴표 안의 문구들. 첫 번째는 제목, 나머지는 안내 문구
};

export function parseMessage(message: string): ParsedMessage {
  const texts: string[] = [];
  const concept = message
    .replace(QUOTED, (_, a, b, c) => {
      const text = String(a ?? b ?? c).trim();
      if (text) texts.push(text);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { concept, texts };
}
