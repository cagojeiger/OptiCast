# Architecture Decision Records

OptiCast v2의 구조적 결정과 그 이유만 기록한다. 비트 단위 동작 계약은 [`protocol-v2.md`](../protocol-v2.md),
수신기 설계는 [`receiver-v2.md`](../receiver-v2.md), 결정에 이르기까지의 탐색(찢어짐 모델, 용량 계산)은
[`optical-v2.md`](../optical-v2.md)가 소유한다. 규격과 ADR이 다르면 규격이 맞고, ADR을 고친다.

```mermaid
flowchart LR
    CH[단방향 채널] --> RENDER[화면 인코딩]
    RENDER --> LAYOUT[프레임 배치]
    LAYOUT --> TEAR[타일 + 찢어짐]
    TEAR --> RS[타일 안 RS]
    RS --> RQ[타일 간 RaptorQ]
    RQ --> META[META + 전송 ID]
    META --> CORE[Rust 공유 코어]
    CORE --> RECV[WASM 수신기]
    RECV --> SAFE[수신 안전]
    SAFE --> DIST[배포]
```

| 계층 | ADR | 결정 | 상태 |
|---|---|---|---|
| 제품 | [0001](0001-one-way-optical-channel.md) | SSH 터미널 → 폰 브라우저, 피드백 없는 방송 | Accepted |
| 화면 | [0002](0002-ssh-render-profile.md) | `▀` 반블록 + 반전, 색 코드 없음 (대체 `vt100`) | Accepted |
| 화면 | [0003](0003-custom-frame-layout.md) | QR 대신 터미널 전체를 쓰는 자체 격자 | Accepted |
| 화면 | [0004](0004-tiles-and-tear-tolerance.md) | 1024모듈 타일, 동기화 출력, 기본 24fps | Accepted |
| 부호 | [0005](0005-tile-error-correction.md) | 타일 안 RS(128,108) + CRC-32C + 백색화 | Accepted |
| 부호 | [0006](0006-raptorq-fountain.md) | 타일 간 RaptorQ 체계적 파운틴 | Accepted |
| 부호 | [0007](0007-meta-tile-and-transfer-id.md) | 반복되는 META 타일, 내용 기반 전송 ID, 선택적 deflate | Accepted |
| 구현 | [0008](0008-rust-shared-core.md) | Rust 송신기, 송수신 공유 코어 | Accepted |
| 구현 | [0009](0009-wasm-receiver.md) | 브라우저 + 자체 비전 Rust→WASM(C ABI), Worker | Accepted |
| 구현 | [0010](0010-receiver-safety-and-resume.md) | SHA-256 확인 전 저장 금지, 크기 상한, IndexedDB 이어 받기 | Accepted |
| 운영 | [0011](0011-distribution.md) | 수신기 GitHub Pages, 송신기 GitHub Releases(musl 정적) | Accepted |

## 한눈에 보는 기술 스택

| 계층 | 선택 | 구현 |
|---|---|---|
| 송신 화면 | `' '`/`'▀'` + SGR 7(반전), 색 없음, `ESC[?2026h` 동기화 출력 | `opticast-core` `ansi.rs`, `frame.rs` |
| 프레임 | 위치 표식 4개, 타이밍 줄 4개, 형식 정보 ×3 + CRC-8 | `layout.rs` |
| 타일 안 | Reed–Solomon(128,108) GF(2⁸) + CRC-32C + xorshift32 백색화 | `reed-solomon` 0.2.1, `crc` 3 |
| 타일 간 | RaptorQ (RFC 6330), 조각 96 B | `raptorq` 2.0.1 |
| 무결성·압축 | SHA-256, deflate-raw(작아질 때만) | `sha2` 0.10, `flate2`(순수 Rust 백엔드) |
| 송신 CLI | Rust 단일 바이너리 (`send`, `plan`) | clap 4, crossterm 0.28, signal-hook 0.3, libc |
| 수신 비전 | 적분 영상 이진화, 런 길이 표식 탐색, 4점 호모그래피, 추적 | `opticast-vision` (외부 의존 없음) |
| 수신 런타임 | wasm32 C ABI + Web Worker + requestVideoFrameCallback | `opticast-wasm`, `web/` (TypeScript, Vite) |
| 수신 저장 | IndexedDB 이어 받기, Wake Lock | `web/store.ts`, `web/main.ts` |
| 배포 | GitHub Pages(Actions), GitHub Releases(musl 정적 + macOS) | `.github/workflows/` |
