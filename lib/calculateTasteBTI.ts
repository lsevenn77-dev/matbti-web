import { tasteQuestions, type TasteAxis } from "../data/questions";
import { tasteTypes, type TasteType } from "../data/tasteTypes";

export interface TasteScores {
  S: number;
  D: number;
  H: number;
  M: number;
  F: number;
  E: number;
  T: number;
  L: number;
}

export interface ScaleAnswer {
  questionId: number;
  type: "scale";
  value: 1 | 2 | 3 | 4 | 5;
}

export interface ChoiceAnswer {
  questionId: number;
  type: "choice";
  selectedIndex?: 0 | 1;
  scoreTo?: TasteAxis;
  points?: number;
}

export type TasteAnswer = ScaleAnswer | ChoiceAnswer;

export interface TasteBTIResult {
  code: string;
  scores: TasteScores;
  typeData?: TasteType;
}

/**
 * 점수 객체를 0점으로 초기화한다.
 * 각 축(S/D, H/M, F/E, T/L)의 누적 점수를 여기서 관리한다.
 */
function createEmptyScores(): TasteScores {
  return { S: 0, D: 0, H: 0, M: 0, F: 0, E: 0, T: 0, L: 0 };
}

/**
 * scale(1~5) 값을 축 점수로 변환한다.
 * 규칙:
 * - 5 = left +2
 * - 4 = left +1
 * - 3 = 0
 * - 2 = right +1
 * - 1 = right +2
 */
function applyScaleScore(
  scores: TasteScores,
  leftAxis: TasteAxis,
  rightAxis: TasteAxis,
  value: 1 | 2 | 3 | 4 | 5
) {
  if (value === 5) scores[leftAxis] += 2;
  if (value === 4) scores[leftAxis] += 1;
  if (value === 2) scores[rightAxis] += 1;
  if (value === 1) scores[rightAxis] += 2;
}

/**
 * choice 문항 점수를 반영한다.
 * - answer.scoreTo/answer.points가 있으면 우선 사용
 * - 없으면 question.options[selectedIndex]의 axis를 사용
 * - points 기본값은 1점
 */
function applyChoiceScore(
  scores: TasteScores,
  answer: ChoiceAnswer,
  optionAxis?: TasteAxis
) {
  const targetAxis = answer.scoreTo ?? optionAxis;
  const point = answer.points ?? 1;

  if (!targetAxis) return;
  scores[targetAxis] += point;
}

/**
 * 각 축의 최종 한 글자를 선택한다.
 * 동점이면 rightLetter를 우선 선택해서
 * D, M, F, L 우선 규칙을 만족한다.
 */
function pickLetter(
  scores: TasteScores,
  leftLetter: TasteAxis,
  rightLetter: TasteAxis
) {
  return scores[leftLetter] > scores[rightLetter] ? leftLetter : rightLetter;
}

/**
 * answers 배열을 받아 맛BTI 결과를 계산한다.
 * 반환값: code(4글자), scores(점수표), typeData(결과 타입 상세 데이터)
 */
export function calculateTasteBTI(answers: TasteAnswer[]): TasteBTIResult {
  const scores = createEmptyScores();
  const questionMap = new Map(tasteQuestions.map((q) => [q.id, q]));

  for (const answer of answers) {
    const question = questionMap.get(answer.questionId);
    if (!question) continue;

    if (answer.type === "scale" && question.type === "scale") {
      applyScaleScore(scores, question.axis[0], question.axis[1], answer.value);
      continue;
    }

    if (answer.type === "choice" && question.type === "choice") {
      const selectedOption =
        answer.selectedIndex !== undefined
          ? question.options[answer.selectedIndex]
          : undefined;

      applyChoiceScore(scores, answer, selectedOption?.axis);
    }
  }

  const code = [
    pickLetter(scores, "S", "D"),
    pickLetter(scores, "H", "M"),
    pickLetter(scores, "F", "E"),
    pickLetter(scores, "T", "L"),
  ].join("");

  return {
    code,
    scores,
    typeData: tasteTypes[code],
  };
}
