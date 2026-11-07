# 애견카페 AI 비서: 공지 이미지 생성

강아지 사진을 올리면 ChatGPT 이미지 모델(OpenAI API)이 기념일 분위기 이미지로 바꾸고, 한글 제목·부제를 코드로 얹어 R2에 저장합니다.

## 구조

- `src/index.ts`: Hono 서버. `POST /api/notices`(시안 생성), `GET /images/*`(이미지 제공), `GET /`(테스트 화면)
- `src/occasions.ts`: 기념일별 장면과 프롬프트
- `src/openai.ts`: OpenAI 이미지 편집 API 호출
- `src/overlay.ts`: resvg-wasm으로 한글 글자 합성, 인스타 피드 비율(1080×1350, 4:5)로 자르기
- `src/fonts.ts`: 기본 폰트(Pretendard)와 제목 폰트 불러오기
- `src/page.ts`: 개발용 업로드 화면

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # OpenAI API 키와 관리자 토큰 입력
npm run dev                      # http://localhost:8787
```

"AI 없이 원본 사진에 글자만 넣기"를 체크하면 OpenAI 키 없이도 글자 합성을 시험할 수 있습니다.

## 제목 폰트 추가

기념일마다 제목 폰트 분위기가 정해져 있습니다(`src/occasions.ts`의 `titleFont`).

| 이름 | 쓰는 곳 | 예시 폰트 |
|---|---|---|
| `rounded` | 크리스마스, 할로윈, 새해 | 카페24 써라운드, 배민 주아체 |
| `bold` | 설날, 추석, 일반 공지 | G마켓 산스 Bold, 배민 도현체 |

폰트는 **공식 배포처**에서 TTF나 OTF로 받아 R2의 `fonts/` 아래에 확장자 없이 올립니다. 올리지 않은 폰트는 기본 폰트(Pretendard)로 대신합니다.

```bash
# 로컬 개발용
npx wrangler r2 object put dog-cafe-assistant/fonts/rounded --file ./fonts/둥근폰트.ttf --local
# 배포용
npx wrangler r2 object put dog-cafe-assistant/fonts/rounded --file ./fonts/둥근폰트.ttf --remote
```

`fonts/` 폴더는 `.gitignore`에 들어 있어 저장소에 올라가지 않고, `/images/` 주소로도 공개되지 않습니다(재배포 금지 라이선스 대비).

## 배포

```bash
npx wrangler r2 bucket create dog-cafe-assistant
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

`wrangler.jsonc`의 `STORE_NAME`에 가게 이름을 넣으면 이미지 맨 아래에 표시됩니다.
# Mountain_dog_assistant
