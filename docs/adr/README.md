# Architecture Decision Records

구조적 결정과 이유만 적는다. 비트 단위 규격은 [`../protocol.md`](../protocol.md)가 기준이다.

| ADR | 결정 |
|---|---|
| [0001](0001-optical-channel.md) | 단방향 방송, `▀` 반블록 격자, 독립 검증되는 타일 |
| [0002](0002-coding.md) | 타일 안 RS(128,108) + CRC-32C, 타일 간 RaptorQ, 반복되는 META |
| [0003](0003-implementation.md) | Rust 공유 코어, 의존성 최소 CLI, 빌드 없는 웹 수신기, 정적 배포 |

| 계층 | 선택 |
|---|---|
| 화면 | `' '`/`'▀'` + 반전, 색 없음, `ESC[?2026h` 동기화 출력 |
| 격자 | 위치 표식 4개, 타이밍 줄 4개, 형식 정보 ×3 + CRC-8, 1024모듈 타일 |
| 부호 | `reed-solomon` 0.2.1, `crc` 3(CRC-32C), `raptorq` 2.0.1, `sha2`, `flate2` |
| 송신 | Rust 바이너리, `crossterm`(raw 모드·크기만), `signal-hook` |
| 수신 | 순수 JS ES 모듈 + Worker + Rust→WASM(C ABI), 자체 비전 |
| 배포 | GitHub Pages(수신기), GitHub Releases(musl 정적 바이너리) |
