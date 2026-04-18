import Link from "next/link";
import { tasteTypes } from "../../../data/tasteTypes";
import ResultShareButtons from "../../../components/ResultShareButtons";

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(tasteTypes).map((code) => ({
    code: code.toLowerCase(),
  }));
}

export default async function ResultPage({ params }) {
  const resolvedParams = await params;
  const code = resolvedParams?.code?.toUpperCase() ?? "";
  const typeData = tasteTypes[code];
  const imageSrc = `/taste-types/${code.toLowerCase()}.png`;

  if (!typeData) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#f8f1ea] via-[#f5ece3] to-[#efe3d7] px-4 py-8 font-sans text-zinc-800">
        <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm items-center justify-center">
          <section className="w-full rounded-[2.5rem] border border-white/60 bg-white/70 p-8 text-center shadow-[0_30px_60px_rgba(120,82,56,0.15)] backdrop-blur-xl">
            <p className="text-sm font-semibold tracking-[0.18em] text-[#9f7f64]">맛BTI</p>
            <h1 className="mt-4 text-2xl font-bold text-[#5b4637]">결과를 찾을 수 없어요</h1>
            <p className="mt-3 text-sm leading-relaxed text-[#7a5d48]">
              잘못된 코드이거나 아직 결과가 준비되지 않았을 수 있어요.
            </p>

            <div className="mt-6 flex gap-3">
              <Link
                href="/quiz"
                className="w-full rounded-2xl bg-[#5f4738] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#513d31]"
              >
                다시 테스트하기
              </Link>
              <Link
                href="/"
                className="w-full rounded-2xl border border-[#d8c0af] bg-white px-4 py-3 text-sm font-semibold text-[#5f4738] transition hover:bg-[#f8f1ea]"
              >
                홈으로
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f8f1ea] via-[#f5ece3] to-[#efe3d7] px-4 py-8 font-sans text-zinc-800">
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm items-center justify-center">
        <section className="relative w-full overflow-hidden rounded-[2.5rem] border border-white/60 bg-white/72 p-7 shadow-[0_30px_60px_rgba(120,82,56,0.15)] backdrop-blur-xl">
          <div className="pointer-events-none absolute inset-0">
            <span className="absolute left-6 top-12 h-3 w-3 rounded-full bg-[#f3d2bd]/55" />
            <span className="absolute right-8 top-20 h-2.5 w-2.5 rounded-full bg-[#dfc0a8]/55" />
            <span className="absolute right-8 bottom-24 h-3 w-3 rounded-full bg-[#e8c8b2]/55" />
            <span className="absolute left-8 top-16 text-3xl opacity-15">🍽️</span>
            <span className="absolute right-7 top-24 text-2xl opacity-15">✨</span>
            <span className="absolute right-8 bottom-20 text-3xl opacity-15">🥐</span>
          </div>

          <div className="relative z-10">
            <p className="text-center text-sm font-semibold tracking-[0.18em] text-[#9f7f64]">맛BTI RESULT</p>

            <div className="mt-5 rounded-3xl border border-[#ecd9ca] bg-gradient-to-br from-[#fff8f2] to-[#fff2e8] px-5 py-5 text-center shadow-[0_10px_24px_rgba(120,82,56,0.1)]">
              <p className="text-xs font-semibold tracking-[0.12em] text-[#9a775d]">나의 타입 코드</p>
              <p className="mt-2 text-4xl font-black tracking-[0.22em] text-[#553f30]">{typeData.code}</p>
              <h1 className="mt-3 text-2xl font-extrabold text-[#4f3d30]">{typeData.name}</h1>
            </div>

            <div className="mt-5 overflow-hidden rounded-3xl border border-[#ead9cb] bg-white/80 p-2 shadow-[0_10px_20px_rgba(120,82,56,0.08)]">
              <img
                src={imageSrc}
                alt={`${typeData.name} 캐릭터`}
                className="h-auto w-full rounded-2xl object-cover"
              />
            </div>

            <p className="mt-5 rounded-2xl border border-[#ead9cb] bg-[#fff8f2] px-4 py-3 text-center text-sm font-semibold leading-relaxed text-[#6f5442]">
              {typeData.shortDescription}
            </p>

            <p className="mt-5 rounded-2xl bg-white/80 px-4 py-5 text-sm leading-7 text-[#5d493a]">
              {typeData.longDescription}
            </p>

            <div className="mt-6">
              <h2 className="text-sm font-semibold text-[#8b6a51]">좋아할 음식 예시</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {typeData.favoriteFoods.map((food) => (
                  <span
                    key={food}
                    className="rounded-full border border-[#e4cdbb] bg-white px-3 py-1.5 text-xs font-semibold text-[#614938] shadow-[0_4px_10px_rgba(120,82,56,0.08)]"
                  >
                    {food}
                  </span>
                ))}
              </div>
            </div>

            <Link
              href="/quiz"
              className="mt-7 block w-full rounded-2xl bg-[#5f4738] px-6 py-4 text-center text-base font-semibold text-white shadow-[0_10px_24px_rgba(95,71,56,0.35)] transition hover:-translate-y-0.5 hover:bg-[#513d31] active:translate-y-0"
            >
              다시 테스트하기
            </Link>

            <ResultShareButtons code={typeData.code} typeName={typeData.name} />
          </div>
        </section>
      </main>
    </div>
  );
}
