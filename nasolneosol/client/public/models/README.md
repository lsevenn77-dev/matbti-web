# 캐릭터 3D 모델 (GLB)

`manifest.json` 의 `캐릭터ID → { url, headScale?, mipmaps? }` 로 코드 캐릭터 대신 GLB 를 표시한다.
불러오기에 실패하면 코드 캐릭터로 자동 대체된다.

## 제작 과정 (12명 모두 같은 방식)
1. GPT Image 2.6 으로 정면 A-포즈 원본 이미지 생성 (캐릭터 시안 시트 기준)
2. Higgsfield Meshy 7 image-to-3D (15,000 폴리곤, 텍스처, 리깅)
3. **UV 섬 재배치**: 생성 텍스처는 조각(UV 섬)이 여백 없이 붙어 있어 밉맵에서 옆 조각 색이 번진다
   (검은 머리에 흰 금). 섬마다 8px 여백을 두고 다시 배치하고 여백을 바깥 색으로 채움 (`scripts/repack_glb.py`)
4. 옛 텍스처·TANGENT 등 미사용 데이터 제거 → 1개 약 2MB
5. Higgsfield 저장소에 올린 주소를 manifest 에 등록 (CORS 허용 확인). 정식 서비스 전 R2 로 이전 예정

## 캐릭터별 보정
- c09 보라: 생성 모델의 머리 비율이 작음(키의 33.5%, 다른 캐릭터 약 40%) → headScale 1.2
- c11 미소: 머리 비율 36% → headScale 1.1
