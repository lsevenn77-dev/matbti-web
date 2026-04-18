"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { tasteQuestions } from "../../data/questions";
import { calculateTasteBTI } from "../../lib/calculateTasteBTI";

const SCALE_LABELS = ["전혀 아니다", "아니다", "보통이다", "그렇다", "매우 그렇다"];

export default function QuizPage() {
  const router = useRouter();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState([]);

  const currentQuestion = tasteQuestions[currentIndex];
  const currentAnswer = useMemo(
    () => answers.find((answer) => answer.questionId === currentQuestion?.id),
    [answers, currentQuestion?.id]
  );
  const isLastQuestion = currentIndex === tasteQuestions.length - 1;
  const canGoNext = !!currentAnswer;

  const progress = useMemo(() => {
    return Math.round(((currentIndex + 1) / tasteQuestions.length) * 100);
  }, [currentIndex]);

  const updateAnswer = (questionId, value) => {
    setAnswers((prev) => [
      ...prev.filter((answer) => answer.questionId !== questionId),
      { questionId, value },
    ]);
  };

  const handleScaleSelect = (value) => {
    updateAnswer(currentQuestion.id, value);
  };

  const handleChoiceSelect = (optionIndex) => {
    updateAnswer(currentQuestion.id, optionIndex);
  };

  const handlePrev = () => {
    if (currentIndex === 0) return;
    setCurrentIndex((prev) => prev - 1);
  };

  const handleNext = () => {
    if (!canGoNext) return;
    if (isLastQuestion) {
      const formattedAnswers = answers
        .map((answer) => {
          const question = tasteQuestions.find((q) => q.id === answer.questionId);
          if (!question) return null;

          if (question.type === "scale") {
            return {
              questionId: question.id,
              type: "scale",
              value: answer.value,
            };
          }

          return {
            questionId: question.id,
            type: "choice",
            selectedIndex: answer.value,
          };
        })
        .filter(Boolean);

      const result = calculateTasteBTI(formattedAnswers);
      router.push(`/result/${result.code.toLowerCase()}`);
      return;
    }
    setCurrentIndex((prev) => prev + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f8f1ea] via-[#f5ece3] to-[#efe3d7] px-4 py-8 font-sans text-zinc-800">
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm flex-col items-center justify-center">
        <section className="relative flex h-[680px] w-full flex-col rounded-[2.5rem] border border-white/60 bg-white/65 p-6 shadow-[0_30px_60px_rgba(120,82,56,0.15)] backdrop-blur-xl">
          <header className="pt-2">
            <p className="text-center text-sm font-semibold tracking-[0.18em] text-[#9f7f64]">
              맛BTI
            </p>
            <h1 className="mt-3 text-center text-xl font-bold text-[#5b4637]">
              나의 맛 성향 알아보기
            </h1>
          </header>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-[#8b6a51]">
              <span>
                {currentIndex + 1} / {tasteQuestions.length}
              </span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#ecdccf]">
              <div
                className="h-full rounded-full bg-[#8f6a4d] transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="mt-8 flex-1">
            <p className="text-lg font-semibold leading-relaxed text-[#4f3d30]">
              {currentQuestion.text}
            </p>

            {currentQuestion.type === "scale" ? (
              <div className="mt-6 space-y-2">
                {SCALE_LABELS.map((label, index) => {
                  const scaleValue = index + 1;
                  const isSelected = currentAnswer?.value === scaleValue;

                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => handleScaleSelect(scaleValue)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left text-sm font-medium transition ${
                        isSelected
                          ? "border-[#8f6a4d] bg-[#f0e1d5] text-[#553f2f]"
                          : "border-[#ead9cb] bg-white/90 text-zinc-700 hover:border-[#d7b9a1]"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {currentQuestion.options.map((option, optionIndex) => {
                  const isSelected = currentAnswer?.value === optionIndex;

                  return (
                    <button
                      key={option.text}
                      type="button"
                      onClick={() => handleChoiceSelect(optionIndex)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left text-sm font-medium transition ${
                        isSelected
                          ? "border-[#8f6a4d] bg-[#f0e1d5] text-[#553f2f]"
                          : "border-[#ead9cb] bg-white/90 text-zinc-700 hover:border-[#d7b9a1]"
                      }`}
                    >
                      {option.text}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handlePrev}
              disabled={currentIndex === 0}
              className="w-full rounded-2xl border border-[#d8c0af] bg-white px-5 py-4 text-base font-semibold text-[#5f4738] transition hover:bg-[#f8f1ea] disabled:cursor-not-allowed disabled:opacity-50"
            >
              이전
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!canGoNext}
              className="w-full rounded-2xl bg-[#5f4738] px-5 py-4 text-base font-semibold text-white shadow-[0_10px_24px_rgba(95,71,56,0.35)] transition disabled:cursor-not-allowed disabled:bg-[#c5afa0] disabled:shadow-none"
            >
              {isLastQuestion ? "완료" : "다음"}
            </button>
          </div>

          {isLastQuestion && canGoNext ? (
            <p className="mt-3 text-center text-xs text-[#7a5d48]">
              마지막 질문입니다. 다음 단계에서 결과 계산을 연결할 수 있어요.
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
