# ADR 0009: 수신기 — 브라우저 + 자체 비전을 Rust→WASM(C ABI)으로, Worker에서 실행

- Status: Accepted
- Date: 2026-11-01

## Context

아이폰 Safari에서 1080p 카메라 프레임을 초당 수십 장 처리해야 한다. 한 장마다 격자 검출, 원근 보정, 샘플링, RS, RaptorQ를 거친다.
앱 설치는 없다([0001](0001-one-way-optical-channel.md)). 격자가 QR이 아니므로([0003](0003-custom-frame-layout.md)) QR 디코더도 쓸 수 없다.

## Decision

- 수신기는 **정적 웹 페이지**(TypeScript + Vite)다. getUserMedia로 후면 카메라를 연다(1920×1080, frameRate ideal 60).
- **프레임 획득**: requestVideoFrameCallback(없으면 requestAnimationFrame) → canvas `drawImage`/`getImageData` →
  버퍼를 transfer로 Worker에 넘긴다. 이전 프레임을 처리하는 중이면 새 프레임은 건너뛴다.
- **Worker 안에 WASM 하나**(`opticast-wasm` = `opticast-vision` + `opticast-core`)를 둔다.
- **비전은 직접 구현**한다(`opticast-vision`, 외부 의존 없음).
  1. 휘도 변환
  2. 적분 영상으로 국소 평균 이진화
  3. 런 길이 1:1:3:1:1 패턴으로 큰 표식 탐색(두 극성 모두), 세로·가로·대각선 교차 확인
  4. 타이밍 줄로 W, H와 모듈 간격 계산
  5. FI 판독
  6. BR 작은 표식까지 4점 호모그래피
  7. 타이밍 줄 잔차가 0.3모듈을 넘으면 가장자리 기반 보정
  8. 모듈마다 3×3 평균 샘플링
- 다음 프레임은 직전 위치 근처를 먼저 추적하고, 실패하면 전체 탐색으로 돌아간다.
- **WASM 인터페이스**는 wasm-bindgen 없이 C ABI 함수만 내보낸다(`alloc`, `dealloc`, `receiver_new/process/stats/file/…`).
  통계는 JSON으로 넘긴다. `cargo build` 하나로 빌드된다.

## Rationale

대안과 선택 이유:

- **TypeScript 비전(v1, jsQR)**: QR 전용이고, 노이즈에 약하며 느렸다.
- **OpenCV.js**: 수 MB인데 필요한 것은 일부다.
- **zxing-cpp WASM**: QR 전용이다.
- **wasm-bindgen**: 편하지만 추가 도구와 생성 코드가 필요하다. 내보낼 함수가 10개 남짓이라 C ABI로 충분하다.
- **메인 스레드에서 처리**: 화면이 끊긴다. Worker로 분리한다.
- **자체 비전 + WASM** (채택): 격자 구조를 알고 있으므로 일반 검출기보다 훨씬 적게 일한다. 송신기와 같은 core를 쓴다
  ([0008](0008-rust-shared-core.md)).

측정: 네이티브 1080p 전체 탐색 9.2 ms, 추적 1.7 ms. e2e(720p, Chrome WASM)에서 디코드 2.5 ms, 처리 30fps. WASM 크기 약 420 KB.

## Consequences

- 디코더에 넘기는 폭은 기본 min(영상 폭, 1920)이고 `?scan=`으로 바꾼다.
- 알려진 한계: 720p에서 200×55 + 기울기 + 흐림 2이면 실패한다. 렌즈 왜곡 k1 > 0.018이면 실패한다. 어두운 주변이 TL 표식을 가리면 실패한다.
- 렌즈 왜곡 모델은 단순하다(가장자리 보간). 실기기 데이터를 보고 보강한다.
