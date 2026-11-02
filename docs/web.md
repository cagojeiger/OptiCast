# DiodeCam 웹 — 수신기와 설정 페이지

폰 브라우저(아이폰 Safari 기준)에서 카메라로 터미널을 찍어 파일을 복원한다. 데스크톱에서는 같은 주소가 설정 페이지(1절)를 낸다. 모든 처리는 기기 안에서 하고 아무것도 업로드하지 않는다.
주소: https://cagojeiger.github.io/diodecam/ (공유 → 홈 화면에 추가하면 앱처럼 열리고 오프라인에서도 동작한다)

## 1. 화면

같은 주소가 기기에 따라 다른 화면을 낸다: 데스크톱은 **설정 페이지**(송신기 다운로드·`send` 명령·터미널 예시·수신기 QR), 폰은 **수신기**.
설정 페이지는 `setup.js`만 싣고 워커·wasm을 받지 않는다. 화면은 칠하기 전에 `index.html`이 고르고, 나머지 주소 옵션은 `main.js`가 읽는다.

| 조건·주소 옵션 | 효과 |
|---|---|
| 마우스가 있는 데스크톱(`(hover: hover) and (pointer: fine)`) | 설정 페이지 |
| 그 밖(폰), 또는 홈 화면 앱(`display-mode: standalone`, iOS `navigator.standalone`) | 수신기 |
| `?receiver=1` | 데스크톱에서도 수신기(e2e가 쓴다) |
| `?max=256` | 받을 파일 상한, MiB(기본 64, 1–512). 넘는 전송의 META는 메모리를 잡기 전에 거부 |
| `?scan=1920` | 디코더에 넘기는 이미지 폭(기본 영상 폭과 1920 중 작은 값, 64–영상 폭) |
| `?cap=3840` | 카메라에 요청하는 폭(16:9, 기본 1920, 640–3840). `?scan=`을 같은 값으로 주면 모듈당 픽셀 2배, 처리 약 4배 |
| `?debug=1` | 카메라 위에 표식과 타일 중심을 찍고, 측정값 시트에 WASM 통계 JSON을 보인다 |

수신기는 한 화면, 고정 배치(`DESIGN.md`). 세로(기본): 도구 줄(제목, [Get the sender] [Reset] [Stats and diagnostics] 아이콘) → 카메라(남는 높이 전부.
모서리 가이드, 격자를 찾으면 초록 테두리, 받는 중엔 진행 링, 완료하면 ✓) → 파일 이름·크기 → 4 px 진행 막대 →
**상태 띠**(한 자리에서 색만 바뀜: `○ Idle` 회색 · `● Receiving` 반전 · `✓ Received` 초록 · `✕ Error` 빨강) → 안내 한 줄(항상 자리 확보)
→ [Start/Stop] [Download] [Share · Save]. iPhone SE Safari의 375×553 안에 스크롤 없이 들어간다.

모든 버튼은 모든 상태에 있고, 쓸 수 없을 때는 비활성(테두리만)이다. 자리와 크기는 바뀌지 않는다.

가로(높이 540px 이하): 왼쪽이 카메라, 오른쪽 250px 열에 나머지. 노치 쪽은 safe-area만큼 띄운다.

[Stats and diagnostics] 아이콘(ⓘ)은 시트를 연다: 촬영·처리 fps, 디코드 시간, 타일 인식률, 격자, 모듈 크기, 실패 단계, 남은 시간, 카메라 해상도,
렌즈 이름, 다른 전송, 전송 ID, 카메라 선택, [Copy diagnostics](6절). [Get the sender] 아이콘은 PC로 링크 보내기와 tar.gz 직접 받기 시트다.

## 2. 상태 흐름

```
[Start] → Opening the camera… → Frame the whole sender screen → Grid found. Waiting for the file header…
  → N pieces to go · about T (안내 줄: M pieces resumed) → 복원 + SHA-256 → ✓ Received (카메라 자동 정지, Share · Save 활성)
```

| 상태 | 카메라 | 띠 | Start/Stop | Download | Share · Save | Reset |
|---|---|---|---|---|---|---|
| 시작 전 | 가이드, 안내 | ○ Idle | Start (주) | 비활성 | 비활성 | 비활성 |
| 받는 중 | 영상, 테두리, 링 | ● Receiving | Stop | 비활성 | 비활성 | 활성 |
| 완료 | ✓ | ✓ Received · SHA-256 verified | Start | 활성 | 활성 (주, 공유 시트가 파일을 받을 때) | 활성 |
| 오류 | 가이드 | ✕ Error | Start | 받은 파일 있으면 | 받은 파일 있으면 | 활성 |

| 상황 | 표시 |
|---|---|
| 검증 실패 | 안내 줄 `Verification failed, collecting again`, 저장분을 버리고 다시 모은다 |
| [Stop] | `Paused. Start the camera to continue.` |
| 상한 초과 | `File too large: N MiB > limit 64 MiB (change it with ?max=)` (메모리를 잡기 전에 거부) |
| 디코더 오류 | 안내 줄 `Decoder error. Reload to resume from the saved progress.` (카메라 정지) |
| 카메라 불가 | 띠 ✕ Error와 한 문장: 권한 거부 `Camera permission denied. …`, 카메라 없음 `No camera found on this device.`, 다른 앱이 사용 중 `The camera is in use by another app. …`, 요청한 설정 불가 `This camera cannot give the requested video. …`, HTTPS/localhost가 아님 `The camera is unavailable. …`. 그 밖의 오류는 브라우저의 메시지 |
| 이어 받기 실패 | 저장분을 불러오다 메모리가 모자라면 띠 ✕ Error, `Could not restore the saved progress. Reload to try again.` 저장분은 지우지 않는다 |
| 받은 파일이 남음 | 새로고침 뒤: `The file from last time is still here. Save or share it.` + ✓ 띠(받은 시각) |

카메라 위 상태 글은 우선순위가 가장 높은 하나만 보인다: 카메라·공유 실패 > 카메라를 여는 중 > 상한 초과 > 완료(받은 파일) > 정지 > 찾는 중 > 받는 중.
카메라·공유 실패는 다음 동작까지 남는다.

## 3. 안내 규칙

- **테두리 색**(매 프레임): 타일 70% 이상 통과 초록, 1개 이상 주황, 0개 빨강.
- **조언**(최근 2초, 위에서부터 먼저 맞는 것):

| 조건 | 조언 |
|---|---|
| 격자가 절반 미만 프레임에서만 보임, 주로 표식에서 실패 | `Frame the whole screen, all four corner marks` |
| 〃, 주로 타이밍 줄·형식 정보에서 실패 | `The grid is blurred: hold still, at a distance that focuses` (모듈이 작으면 아래 두 줄) |
| 〃, 주로 기하(왜곡)에서 실패 | `The grid looks bent: face the screen, a little further back` |
| 인식률 ≥ 90% | `You can raise the sender fps (+)` |
| 인식률 < 70%, 모듈 < 4.5 px, 영상이 세로 | `Hold the phone sideways for a larger grid` (가로로 들면 격자 칸이 두 배 가까이 크게 찍힌다) |
| 인식률 < 70%, 모듈 < 4.5 px | `The grid cells are small: move closer or enlarge the terminal font` |
| 인식률 < 70% | `Lower the sender fps (-)` |

- **모듈 크기**는 디코더 영상에서 모듈 한 칸의 픽셀 수(가로·세로 간격 중 작은 값)다. 기준 4.5 px는 TS 시뮬레이터(`tools/sim`)로
  잰 바닥(7절, `node tools/floor.ts`)에 실기기의 초점 흔들림만큼 여유를 둔 값이다. 세로로 든 1080p 카메라는 200열 터미널을 꽉 채워도
  약 4.5 px, 가로로 들면 약 8 px이다.
- **남은 시간** = 남은 조각 ÷ 최근 5초 동안 새 조각의 초당 개수. 송신 상태 줄의 `phone needs`와 같은 식이다.

## 4. 저장과 이어 받기

- 완료 기준은 RaptorQ 복원 → (선언 크기까지만 inflate) → 크기 일치 → SHA-256 일치. 그 전에는 저장 버튼이 비활성이다.
- 공유 시트가 파일을 받으면 [Share · Save](AirDrop, 파일 앱)가 주 버튼이고, 아니면 [Download](Blob)가 주 버튼이다.
  파일을 자동으로 열지 않는다.
- **받은 파일은 공유에 성공하거나, 다음 파일을 다 받거나, [Reset]을 누를 때까지 이 브라우저의 IndexedDB에 남는다**
  (하나만, 최대 24시간). 저장하기 전에 탭이 닫혀도 새로고침하면 다시 보인다. 다른 전송의 META가 보이면 카드만 닫힌다.
  저장하지 않은 파일에 [Reset]을 누르면 한 번 묻는다. 저장된 바이트를 읽을 수 없으면(브라우저가 지운 경우) 버린다.
- `cagojeiger.github.io`는 같은 계정의 모든 Pages 사이트가 함께 쓰는 출처(origin)라서, 그 사이트들의 스크립트도 이
  IndexedDB를 읽을 수 있다. 민감한 환경이면 전용 도메인에 배포한다.
- 받는 중인 타일은 5초마다(새 조각이 있을 때) 그리고 탭이 숨겨질 때 IndexedDB에 저장한다. META가 보이면 같은 전송 ID의
  저장분을 불러온다. 더 적은 조각으로 덮어쓰지 않고, 7일이 지나거나 합계 128 MiB를 넘으면 오래된 것부터 지운다. 완료되면 지운다.
- 받는 동안 Wake Lock으로 화면 꺼짐을 막는다.

## 5. 홈 화면 앱과 오프라인

- `manifest.webmanifest`(standalone, 아이콘 = 렌즈 고리 안에 카메라가 읽는 격자, 흑백, `tools/icons.ts`)와 `apple-touch-icon`으로 홈 화면에 앱처럼 추가된다.
- `sw.js`는 배포본에서만, 페이지 `load` 뒤에 등록된다(`__V__`가 커밋으로 바뀐 경우). 주소에 버전이 없는 유일한 파일이다:
  브라우저가 서비스 워커 스크립트를 직접 다시 확인하고, 내용(버전)이 배포마다 바뀐다.
- 배포마다 캐시 하나(`diodecam-<커밋>`)를 설치 때 채우고, 새 배포가 활성화되면 옛 캐시를 지운다. 페이지는 네트워크 우선
  (3초 안에 응답이 없으면 캐시), 나머지는 주소에 버전이 있어 이번 배포의 캐시 우선이다.
- Pages는 쿼리를 무시하므로 설치 중에 새 배포가 올라오면 파일이 섞일 수 있다. 설치 전후로 페이지의 버전을 확인하고,
  어긋나거나 하나라도 실패하면 그 캐시를 지운다(이전 배포의 캐시를 계속 쓴다).
- 홈 화면 앱은 Safari와 저장소가 따로라서, Safari에서 받던 진행분과 받은 파일은 앱에서 보이지 않는다.

## 6. 진단

실기기에서 인식이 안 될 때 원인이 무엇인지(조준, 초점, 왜곡, 모듈 크기, 렌즈 전환) 숫자로 가르기 위한 것이다.

- **실패 단계**: 프레임마다 영상 처리가 어디까지 갔는지(`stage`: finders → timing → format → geometry → done, 7절)를
  WASM 통계로 받는다. 최근 2초에 가장 많이 멈춘 단계와 비율을 보인다(예: `timing lines 40%`).
- **카메라 선택**: 아이폰 Pro의 기본 후면 카메라(트리플·듀얼 광각)는 가까이 찍을 때 광각과 초광각을 스스로 오간다(iOS 17+).
  웹에서는 막을 수 없으므로 목록에서 단일 렌즈("Back Camera")를 고를 수 있다. 선택은 이 브라우저에만 기억하고(localStorage),
  그 카메라가 없으면 기본 카메라로 돌아간다.
- **[Copy diagnostics]**: 카메라를 켠 뒤의 기록을 JSON으로 클립보드에 넣는다. 앱 버전, 브라우저, 렌즈 이름, 카메라 설정과
  `getCapabilities()`, 단계별 프레임 수, 모듈 크기 분위수, 잔차, 최근 fps·인식률·조언, 격자, 진행률이 담긴다.
  파일 이름·내용·크기, 전송 ID(둘을 합치면 어떤 파일인지 대조할 수 있다), 장치 ID는 넣지 않는다. 렌즈를 바꿔 가며 복사한 두 기록을 비교하면 렌즈 전환이 원인인지 알 수 있다.

## 7. 영상 처리 (`crates/diodecam-vision`)

1. **휘도**: RGBA → Y = (77R + 150G + 29B) >> 8.
2. **이진화**: 적분 영상으로 국소 평균 임계값(창 = 영상 폭 / 40, 최소 15 px). 극성을 모르므로 두 극성 모두 시도한다.
3. **위치 표식** (`finders`): 행마다 런 길이 1:1:3:1:1을 찾고 열·대각선으로 교차 확인한다. 직각에 가장 가까운 꼭짓점이 TL,
   외적의 부호로 TR/BL을 가른다. 표식의 바깥 고리 색이 극성(1)이다.
4. **타이밍 줄과 FI** (`timing`, `format`): y = 5, x = 5 타이밍 줄에서 W, H와 모듈 간격을 잡는다. 먼저 경계를 하나씩 세고(선명할 때
   가장 정밀), 블러로 경계가 뭉개지면 줄 전체의 1-0-1-0 **위상**으로 간격을 맞춘다(8모듈 창, 절반 이상의 창이 일관돼야 한다).
   형식 정보(위 사본, 실패하면 아래 사본; 블러용 임계값으로 한 번 더)로 확정한다. 위상으로 센 W, H는 FI와 1모듈 안에서 맞아야 한다
   (먼 쪽 표식이 줄 끝이 아니라 줄 중간의 가짜 표식이면 여기서 걸린다).
5. **호모그래피** (`geometry`): TL(5.5, 5.5), TR(W − 5.5, 5.5), BL(5.5, H − 5.5)과 예측 위치 근처의 BR 작은 표식(W − 4.5, H − 4.5).
   네 타이밍 줄을 위상으로 재서 창마다의 어긋남을 줄을 따라 펼친다(위상은 2모듈 주기라 그대로는 ±1에서 감긴다). 한 줄이라도
   1.25모듈을 넘게 어긋나면 기하를 버린다(가짜 표식이나 틀린 축척은 모든 창이 일관된 채 어긋남만 0에서 k모듈까지 커진다). 잔차가
   0.1모듈을 넘으면 그 어긋남으로 보정(렌즈 왜곡)을 섞는다. BR 작은 표식은 블러로 고리가 붙으면 템플릿 탐색으로 찾는다.
6. **샘플링** (`done`): 모듈 중심의 3×3 평균을 7×7모듈 국소 평균과 비교한다. 임계값을 이웃 네 모듈 평균 쪽으로 0·½·¾ 옮겨 보고
   아는 모듈(표식·타이밍·FI)을 가장 적게 틀리는 쪽을 쓴다(블러로 이웃이 번져 들어올 때).
7. **추적**: 다음 프레임은 직전 표식 근처부터 찾고, 실패하면 전체 탐색으로 돌아간다.

타일 디코드와 조립은 protocol 6절. 알려진 한계: 렌즈 왜곡 k1 > 0.018, 아이폰의 자동 렌즈 전환(6절의 카메라 선택으로 우회),
작은 모듈 — `node tools/floor.ts` 기준(TS 시뮬레이터 `tools/sim`, 1080p, 기울기 약간) 선명하면 2.9 px, 블러 2 px이면 3.4 px, 블러 3 px이면 4.9 px부터 전부 읽는다.
실기기는 초점이 흔들리므로 ⓘ 조언의 기준은 4.5 px(`MIN_MODULE_PX`)로 둔다.

## 8. 코드 구조 (`web/`, 빌드 없음)

| 파일 | 역할 |
|---|---|
| `index.html`, `style.css` | 화면(수신기 세로·가로 배치, 데스크톱 설정 페이지) |
| `setup.js` | 설정 페이지: 타깃 선택, 명령 복사, 파일 이름 인용, 테마 버튼 |
| `help.html`, `privacy.html`, `terms.html`, `licenses.html` | 정적 문서 페이지(영어) |
| `qr.svg`, `example-terminal.svg`, `icon.svg` | `node tools/qr.ts`, `node tools/terminal-example.ts`, `node tools/icons.ts`가 만든다 |
| `main.js` | 카메라(rVFC → canvas → Worker), 화면 갱신, 저장·공유, 받은 파일 보관, 이어 받기, 카메라 선택, 진단 |
| `worker.js` | WASM 수신기를 소유. 프레임마다 정확히 한 번 응답, 예외는 치명 오류 |
| `wasm.js` | `diodecam.wasm`(C ABI) 래퍼 |
| `metrics.js` | 인식률·속도·남은 시간·모듈 크기·실패 단계·조언 같은 순수 함수 |
| `store.js` | IndexedDB: 이어 받기 타일, 받은 파일 |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | 홈 화면 앱과 오프라인 캐시(아이콘은 `node tools/icons.ts`로 만든다) |

모든 내부 주소에 `?v=__V__`가 붙고, 배포(CI)가 커밋 해시로 바꾼다. 푸터와 진단의 `__VERSION__`은 `Cargo.toml`의 버전으로 바뀐다(버전의 원본은 하나). 배포 직후에도 두 버전의 파일이 섞이지 않는다.
