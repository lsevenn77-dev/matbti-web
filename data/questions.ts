export type TasteAxis = "S" | "D" | "H" | "M" | "F" | "E" | "T" | "L";

export type QuestionType = "scale" | "choice";

export interface BaseQuestion {
  id: number;
  type: QuestionType;
  axis: [TasteAxis, TasteAxis];
  text: string;
}

export interface ScaleQuestion extends BaseQuestion {
  type: "scale";
  scaleMin: 1;
  scaleMax: 5;
  // scaleMin(1)은 axis[1] 쪽, scaleMax(5)는 axis[0] 쪽 성향으로 계산하기 쉽다.
  minLabel: string;
  maxLabel: string;
}

export interface ChoiceOption {
  text: string;
  axis: TasteAxis;
}

export interface ChoiceQuestion extends BaseQuestion {
  type: "choice";
  options: [ChoiceOption, ChoiceOption];
}

export type TasteQuestion = ScaleQuestion | ChoiceQuestion;

export const tasteQuestions: TasteQuestion[] = [
  {
    id: 1,
    type: "scale",
    axis: ["S", "D"],
    text: "음식을 고를 때, 담백하고 깊은 맛보다 달달하고 바로 만족되는 맛에 더 끌린다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 2,
    type: "scale",
    axis: ["H", "M"],
    text: "스트레스를 받으면 순한 음식보다 맵고 자극적인 음식이 더 당긴다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 3,
    type: "scale",
    axis: ["E", "F"],
    text: "처음 가는 식당에서는 익숙한 메뉴보다 처음 보는 메뉴를 더 시도해보고 싶다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 4,
    type: "scale",
    axis: ["T", "L"],
    text: "음식은 맛도 중요하지만, 바삭함·쫄깃함·꾸덕함 같은 식감이 더 기억에 남는다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 5,
    type: "scale",
    axis: ["S", "D"],
    text: "디저트나 달콤한 음식이 식사만큼 중요하거나 자주 생각나는 편이다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 6,
    type: "scale",
    axis: ["H", "M"],
    text: "매운 음식은 힘들어도 자꾸 생각나고, 먹고 나면 오히려 만족감이 크다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 7,
    type: "scale",
    axis: ["F", "E"],
    text: "새로운 음식이 보여도 실패할까 봐 익숙한 메뉴를 고르는 편이다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 8,
    type: "scale",
    axis: ["L", "T"],
    text: "식감이 평범해도 풍미가 깊고 조화로우면 만족스럽다.",
    scaleMin: 1,
    scaleMax: 5,
    minLabel: "전혀 아니다",
    maxLabel: "매우 그렇다",
  },
  {
    id: 9,
    type: "choice",
    axis: ["S", "D"],
    text: "평소 자주 생각나는 음식은 어떤 쪽에 더 가깝다.",
    options: [
      {
        text: "케이크, 달달한 빵, 달콤한 간식류",
        axis: "S",
      },
      {
        text: "국밥, 구이, 담백한 집밥류",
        axis: "D",
      },
    ],
  },
  {
    id: 10,
    type: "choice",
    axis: ["H", "M"],
    text: "강하게 당기는 음식이 먹고 싶을 때 더 먼저 떠오르는 쪽은?",
    options: [
      {
        text: "엽떡, 닭발, 마라, 불닭 같은 강한 메뉴",
        axis: "H",
      },
      {
        text: "치즈피자, 크림파스타, 국물요리 같은 순한 메뉴",
        axis: "M",
      },
    ],
  },
  {
    id: 11,
    type: "choice",
    axis: ["F", "E"],
    text: "새로운 맛집을 발견했을 때 내 반응은?",
    options: [
      {
        text: "가장 인기 많고 익숙한 메뉴부터 본다",
        axis: "F",
      },
      {
        text: "시그니처나 처음 보는 메뉴부터 궁금하다",
        axis: "E",
      },
    ],
  },
  {
    id: 12,
    type: "choice",
    axis: ["T", "L"],
    text: "같은 음식이라면 무엇이 더 중요해?",
    options: [
      {
        text: "한입 먹었을 때 바삭하거나 쫄깃한 느낌",
        axis: "T",
      },
      {
        text: "먹을수록 퍼지는 깊은 향과 풍미",
        axis: "L",
      },
    ],
  },
  {
    id: 13,
    type: "choice",
    axis: ["S", "D"],
    text: "간식이나 가벼운 한 끼를 고를 때 더 자주 손이 가는 쪽은?",
    options: [
      {
        text: "케이크, 크로플, 마카롱 같은 달콤한 메뉴",
        axis: "S",
      },
      {
        text: "샌드위치, 소금빵, 치즈류처럼 짭짤하고 담백한 메뉴",
        axis: "D",
      },
    ],
  },
  {
    id: 14,
    type: "choice",
    axis: ["H", "M"],
    text: "처음 보는 음식 중에서 더 끌리는 쪽은?",
    options: [
      {
        text: "너무 자극적이지 않고 편하게 먹을 수 있는 메뉴",
        axis: "M",
      },
      {
        text: "맵고 강한 인상이 있는 메뉴",
        axis: "H",
      },
    ],
  },
  {
    id: 15,
    type: "choice",
    axis: ["F", "E"],
    text: "메뉴판을 볼 때 더 마음이 가는 쪽은?",
    options: [
      {
        text: "평소 좋아하던 익숙한 맛 조합",
        axis: "F",
      },
      {
        text: "한 번도 안 먹어본 색다른 조합",
        axis: "E",
      },
    ],
  },
  {
    id: 16,
    type: "choice",
    axis: ["T", "L"],
    text: "가장 '와 맛있다'고 느끼는 순간은?",
    options: [
      {
        text: "씹을 때 식감이 확 살아날 때",
        axis: "T",
      },
      {
        text: "먹고 나서 풍미가 오래 남을 때",
        axis: "L",
      },
    ],
  },
];
