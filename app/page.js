import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#fbf4ea] via-[#f7efe4] to-[#f4eadf] px-4 py-6 font-sans text-zinc-800">
      <main className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-sm flex-col">
        <section className="relative flex flex-1 flex-col overflow-hidden rounded-[2.2rem] border border-[#f0ddca] bg-[#fff9f0] p-6 shadow-[0_20px_50px_rgba(120,82,56,0.12)]">
          <div className="pointer-events-none absolute inset-0">
            <span className="absolute left-[-8px] top-8 text-6xl opacity-90">🍰</span>
            <span className="absolute right-[-10px] top-10 text-6xl opacity-90">🍣</span>
            <span className="absolute left-[-8px] top-[34%] text-6xl opacity-90">🍣</span>
            <span className="absolute right-[-10px] top-[33%] text-6xl opacity-90">🥗</span>
            <span className="absolute left-[-10px] bottom-[22%] text-6xl opacity-90">🥞</span>
            <span className="absolute right-[-8px] bottom-[20%] text-6xl opacity-90">🍬</span>
            <span className="absolute left-5 top-4 h-20 w-20 rounded-full bg-[#fff7ef]/70 blur-lg" />
            <span className="absolute right-8 bottom-10 h-20 w-20 rounded-full bg-[#fff7ef]/70 blur-lg" />
          </div>

          <header className="relative z-10 mt-3 text-center">
            <h1 className="text-[2.3rem] font-extrabold leading-tight tracking-[-0.03em] text-[#4f3b2d]">
              당신의 맛BTI를
              <br />
              찾아보세요!
            </h1>
          </header>

          <div className="relative z-10 flex flex-1 items-center justify-center py-6">
            <div className="relative flex h-44 w-44 items-center justify-center rounded-full border-[3px] border-[#d39a63] bg-gradient-to-b from-[#fff6e8] to-[#ffe5c8] shadow-[0_14px_28px_rgba(117,86,60,0.2)]">
              <div className="absolute h-32 w-32 rounded-full border-2 border-[#e7bc8f]" />
              <div className="absolute h-12 w-2 -rotate-45 rounded-full bg-gradient-to-b from-[#ff7e4b] to-[#d24f2d]" />
              <div className="absolute h-4 w-4 rounded-full bg-[#fffaf4]" />
              <span className="absolute -left-11 text-5xl">🥄</span>
              <span className="absolute -right-11 text-5xl">🔪</span>
            </div>
          </div>

          <div className="relative z-10 pb-3">
            <Link
              href="/quiz"
              className="mx-auto block w-[78%] rounded-full border-2 border-[#cf6b30] bg-gradient-to-b from-[#ff8f3f] to-[#f06d28] px-6 py-3.5 text-center text-[2rem] font-black tracking-wide text-white shadow-[0_10px_20px_rgba(211,106,48,0.35)] transition hover:brightness-105 active:scale-[0.99]"
            >
              시작
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
