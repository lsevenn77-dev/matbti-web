"use client";

import { useState } from "react";

export default function ResultShareButtons({ code, typeName }) {
  const [copied, setCopied] = useState(false);

  const getShareUrl = () => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/result/${code.toLowerCase()}`;
  };

  const handleCopyLink = async () => {
    const url = getShareUrl();
    if (!url) return;

    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleKakaoShare = () => {
    const url = encodeURIComponent(getShareUrl());
    const text = encodeURIComponent(`내 맛BTI 결과는 ${code} (${typeName})!`);
    window.open(
      `https://sharer.kakao.com/talk/friends/picker/link?url=${url}&text=${text}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const handleInstagramShare = async () => {
    const shareUrl = getShareUrl();
    if (!shareUrl) return;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `맛BTI 결과 ${code}`,
          text: `내 맛BTI 결과는 ${code} (${typeName})`,
          url: shareUrl,
        });
        return;
      } catch {
        // 사용자가 공유창을 닫은 경우도 있으므로 fallback 로직으로 이동
      }
    }

    await navigator.clipboard.writeText(shareUrl);
    window.open("https://www.instagram.com/", "_blank", "noopener,noreferrer");
  };

  return (
    <div className="mt-6 rounded-2xl border border-[#ead9cb] bg-white/75 p-4">
      <p className="text-center text-sm font-semibold text-[#7b5f4b]">공유하기</p>
      <div className="mt-3 grid grid-cols-1 gap-2">
        <button
          type="button"
          onClick={handleCopyLink}
          className="rounded-xl border border-[#e4cdbb] bg-white px-3 py-2 text-sm font-semibold text-[#5f4738] transition hover:bg-[#f8f1ea]"
        >
          {copied ? "복사 완료!" : "주소 복사하기"}
        </button>
        <button
          type="button"
          onClick={handleKakaoShare}
          className="rounded-xl bg-[#FEE500] px-3 py-2 text-sm font-semibold text-[#3b2a00] transition hover:brightness-95"
        >
          카카오톡에 공유하기
        </button>
        <button
          type="button"
          onClick={handleInstagramShare}
          className="rounded-xl bg-gradient-to-r from-[#f9ce34] via-[#ee2a7b] to-[#6228d7] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-95"
        >
          인스타에 공유하기
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-[#8f725e]">
        인스타는 앱 정책상 직접 첨부 대신 공유창 또는 링크 복사로 열려요.
      </p>
    </div>
  );
}
