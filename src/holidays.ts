// 기념일 안내에 쓰는 날짜 목록. 날짜를 넣거나 빼려면 이 파일만 고치면 된다.
//
// rule
//   must  : 꼭 안내한다. 영업 시간이 바뀌거나 손님이 몰릴 수 있는 날.
//   judge : 에이전트가 판단한다. 사진·이벤트 공지에 어울리면 안내한다.
//
// 넣지 않기로 한 날: 발렌타인데이, 화이트데이, 빼빼로데이, 복날(애견카페에 민감한 날)

export type HolidayRule = "must" | "judge";

export type FixedHoliday = {
  key: string; // 영문 이름. 안내 기록(reminders/연도-key.json)에 쓴다
  name: string;
  monthDay: string; // MM-DD
  rule: HolidayRule;
};

// 며칠 전에 안내할지
export const REMIND_DAYS_BEFORE = 3;

// 해마다 날짜가 같은 날
export const FIXED_HOLIDAYS: FixedHoliday[] = [
  // 꼭 안내
  { key: "newyear", name: "새해 첫날(신정)", monthDay: "01-01", rule: "must" },
  { key: "childrensday", name: "어린이날", monthDay: "05-05", rule: "must" },
  { key: "christmas", name: "크리스마스", monthDay: "12-25", rule: "must" },
  { key: "yearend", name: "연말(12월 31일)", monthDay: "12-31", rule: "must" },

  // 강아지·반려동물 기념일 (에이전트 판단)
  { key: "puppyday", name: "국제 강아지의 날", monthDay: "03-23", rule: "judge" },
  { key: "petday", name: "반려동물의 날", monthDay: "04-11", rule: "judge" },
  { key: "dogday", name: "세계 개의 날", monthDay: "08-26", rule: "judge" },
  { key: "animalday", name: "세계 동물의 날", monthDay: "10-04", rule: "judge" },
  { key: "halloween", name: "할로윈", monthDay: "10-31", rule: "judge" },
  { key: "mungmungday", name: "개의 날(멍멍멍 데이)", monthDay: "11-01", rule: "judge" },

  // 시험용: 11월 10일 오전 9시 크론에서 안내가 오는지 확인한 뒤 지운다.
  { key: "test", name: "테스트 기념일(시험용)", monthDay: "11-13", rule: "must" },
];

// 공휴일은 공공데이터포털 특일 정보 API에서 받는다. (SPCDE_API_KEY가 있을 때만)
// 모든 공휴일은 꼭 안내하고, 위 목록과 겹치는 날은 같은 key를 써서 한 번만 안내한다.
export const API_HOLIDAY_KEYS: Record<string, string> = {
  "1월1일": "newyear",
  "설날": "seollal",
  "어린이날": "childrensday",
  "추석": "chuseok",
  "기독탄신일": "christmas",
};
