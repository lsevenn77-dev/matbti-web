# 배경음악 파일 넣는 법

`tracks.json` 에 분위기별 음원을 적으면, 그 분위기에서는 합성 음악 대신 이 파일을 반복 재생한다.
비어 있으면 브라우저가 분위기에 맞는 음악을 직접 합성해서 튼다.

```json
{
  "lobby":   { "url": "/audio/lobby.mp3",   "volume": 0.6 },
  "village": { "url": "/audio/village.mp3", "volume": 0.5 },
  "tension": { "url": "/audio/tension.mp3", "volume": 0.5 },
  "romance": { "url": "/audio/romance.mp3", "volume": 0.3 },
  "upbeat":  { "url": "/audio/upbeat.mp3",  "volume": 0.5 },
  "emotion": { "url": "/audio/emotion.mp3", "volume": 0.6 },
  "warm":    { "url": "/audio/warm.mp3",    "volume": 0.6 },
  "calm":    { "url": "/audio/calm.mp3",    "volume": 0.5 }
}
```

| 분위기 | 쓰이는 단계 |
|---|---|
| waiting | 대기 화면 (지금: waiting.mp3, 직접 만든 Suno 곡) |
| lobby | 입장 안내 |
| tension | 첫인상 선택, 데이트 상대 지목 |
| romance | 데이트 중 (음성이 우선이라 작게) |
| village | 숙소 자유 구경, 데이트에 안 뽑혀 숙소 대기 |
| quiet | 자기소개 — 음악 없이 환경음만 (파일 지정 불가) |
| upbeat | 미니게임, 사다리타기 |
| emotion | 최종 선택 |
| warm / calm | 결과 (커플 성사 / 불발) |

- 누가 말하는 중이면 음악은 자동으로 35% 로 줄어든다.
- 상업적 사용이 허락된 음원만 넣을 것. 방송 프로그램 음악·비슷하게 만든 곡은 쓰지 않는다.
