// 개발·테스트용 업로드 화면. 부모님용 화면은 카카오톡 챗봇이 맡는다.
// 카톡 챗봇과 같은 흐름(컨셉을 말로 적기 → 시각적 요청만 뽑기 → 이미지 생성 → 디자인 에이전트)을 웹에서 시험한다.
export function uploadPage(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>공지 이미지 만들기</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px; background: #faf8f5; color: #222; }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input, select, textarea, button { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px; font-size: 16px; border: 1px solid #ccc; border-radius: 8px; }
  label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }
  label.check input { width: auto; margin: 0; }
  button { margin-top: 20px; background: #c0492b; color: #fff; border: 0; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; }
  #status { margin-top: 16px; white-space: pre-wrap; }
  #results img { width: 100%; border-radius: 8px; }
  .card { margin-top: 20px; padding: 12px; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card button { margin-top: 8px; }
  .card .note { margin-top: 8px; font-size: 14px; color: #666; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>공지 이미지 만들기</h1>
<form id="form" method="post" action="/api/notices" enctype="multipart/form-data">
  <label>관리자 토큰 <input type="password" name="token" required></label>
  <label>강아지 사진 <input type="file" name="photo" accept="image/jpeg,image/png" required></label>
  <label>컨셉 (사진을 어떻게 바꿀지 말로 적기) <textarea name="concept" rows="3" placeholder="크리스마스 컨셉으로 산타 모자를 씌우고 배경을 바꿔줘"></textarea></label>
  <label>제목 (이미지에 들어갈 글자, 비우면 글자 없이, 최대 2줄) <textarea name="title" rows="2" placeholder="크리스마스 당일에도 오픈합니다"></textarea></label>
  <label>부제 (최대 2줄) <textarea name="subtitle" rows="2" placeholder="12월 24~25일 정상 영업합니다"></textarea></label>
  <label>시안 개수 <select name="count"><option>1</option><option selected>2</option><option>3</option></select></label>
  <label class="check"><input type="checkbox" name="skipAi"> AI 없이 원본 사진에 글자만 넣기</label>
  <button>만들기</button>
</form>
<div id="status"></div>
<div id="results"></div>
<script>
  const form = document.getElementById("form");
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    results.innerHTML = "";
    status.textContent = "만드는 중이에요. 30초 정도 걸릴 수 있어요...";
    try {
      const res = await fetch("/api/notices", { method: "POST", body: new FormData(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const messages = [...data.errors.map((e) => "일부 시안 실패: " + e), ...data.notes];
      status.textContent = messages.length ? messages.join("\\n") : "완료!";
      for (const image of data.images) results.append(variantCard(data.id, image));
    } catch (err) {
      status.textContent = "실패: " + err.message;
    } finally {
      button.disabled = false;
    }
  });

  // 시안 하나와 그 아래 수정 요청 글 상자. 고친 결과로 바뀐 뒤에도 계속 고칠 수 있다.
  function variantCard(id, image) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<img alt="공지 시안">' +
      '<textarea rows="2" placeholder="이 시안에서 바꾸고 싶은 점 (예: 모자를 초록색으로, 배경을 더 밝게)"></textarea>' +
      '<button type="button">이 시안 수정하기</button>' +
      '<div class="note"></div>';
    const img = card.querySelector("img");
    const input = card.querySelector("textarea");
    const button = card.querySelector("button");
    const note = card.querySelector(".note");
    let base = image.base;
    img.src = image.url;

    button.addEventListener("click", async () => {
      if (!input.value.trim()) {
        note.textContent = "어떻게 바꿀지 적어 주세요.";
        return;
      }
      const body = new FormData();
      body.append("token", form.elements.token.value);
      body.append("base", base);
      body.append("instruction", input.value);
      button.disabled = true;
      note.textContent = "고치는 중이에요. 20초 정도 걸릴 수 있어요...";
      try {
        const res = await fetch("/api/notices/" + id + "/revise", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const previous = img.src;
        img.src = data.image.url;
        base = data.image.base;
        input.value = "";
        note.innerHTML = "";
        note.append("수정했어요. ");
        const link = document.createElement("a");
        link.href = previous;
        link.target = "_blank";
        link.textContent = "이전 버전 보기";
        note.append(link);
        if (data.notes.length) note.append("\\n" + data.notes.join("\\n"));
      } catch (err) {
        note.textContent = "실패: " + err.message;
      } finally {
        button.disabled = false;
      }
    });
    return card;
  }
</script>
</body>
</html>`;
}
