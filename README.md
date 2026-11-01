# OptiCast

SSH 터미널에 그린 흑백 격자를 폰 카메라로 찍어 파일을 옮기는 단방향 오프라인 파일 전송.
네트워크, USB, 앱 설치가 필요 없다.

> 상태: v0.2.0. 실기기(아이폰 Safari)로 16.9 MB를 받아 원본과 바이트 단위로 같은 것을 확인했다.
> 설계 배경은 notegate `daily:/research/2026/10/2026-10-31-cyclic-optical-file-transfer-concept.md`,
> 구현 정리는 `daily:/research/2026/11/2026-11-01-opticast-implementation.md`에 있다.

```
 server terminal (SSH)                          iPhone Safari
+---------------------------+  light, 24 fps   +--------------------------------+
| $ opticast send file      | ---------------> | camera -> grid -> tiles        |
|   half-block grid of      |  no ACK          | -> RaptorQ -> SHA-256 -> save  |
|   tiles, sent forever     |  one-way         |   (all in the browser)         |
+---------------------------+                  +--------------------------------+
```

## 사용법

1. 폰 Safari에서 **https://cagojeiger.github.io/OptiCast/** 를 열고 [카메라 시작]을 누른다.
2. 서버에 송신기를 받아서 보낸다. 리눅스용은 정적 바이너리라 받자마자 실행된다.

   ```sh
   curl -fsSL https://github.com/cagojeiger/OptiCast/releases/latest/download/opticast-x86_64-unknown-linux-musl.tar.gz | tar xz
   ./opticast-x86_64-unknown-linux-musl/opticast send report.pdf
   ```

   다른 대상: `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`.
3. 폰으로 터미널 화면 전체를 비춘다. 테두리가 초록이면 잘 읽히는 중이다. 놓친 화면은 신경 쓰지 않아도 된다.
4. "수신 완료"가 뜨면 카메라가 저절로 꺼진다. [파일 저장]이나 [공유]로 저장한 **다음에** 터미널에서 `q`를 누른다.

폴더는 `tar czf out.tgz dir/`로 묶어서 보낸다.

| 키 | 동작 |
|---|---|
| `+` / `-` | fps를 2·3·5·8·10·12·15·20·**24**·30 단계로 조절 |
| `space` | 일시 정지 |
| `q`, `Esc`, `Ctrl-C` | 종료 (터미널 화면 복원) |

| 송신 옵션 | 기본 | 설명 |
|---|---|---|
| `--fps` | 24 | 30은 30fps 카메라와 위상이 고정될 수 있어 경고한다 |
| `--profile` | auto | `ssh`(반블록) / `vt100`(공백 + 반전). auto는 비UTF-8 tmux/screen에서 `vt100` |
| `--max-bytes` | 64MiB | 입력 크기 상한 |
| `--no-compress` | | deflate를 시도하지 않음 |

`opticast plan <파일> [--cols C --rows R]`은 보내지 않고 터미널 크기별 예상 시간만 보여 준다.
수신기 주소 옵션: `?max=256`(MiB, 기본 64, 최대 512), `?scan=1920`(디코드 폭), `?debug=1`(검출 표시와 내부 상태).

## 속도

24fps, 손실 없음, 압축이 안 되는 파일 기준. 터미널 크기는 자동으로 계산하고, 전송 중에 창 크기를 바꿔도 끊기지 않는다.

| 터미널 | 격자 | 프레임당 | 초당 | 1 MB | 64 MiB |
|---|---|---|---|---|---|
| 80×24 | 79×44 | 173 B | 4.2 KB/s | 약 4분 13초 | 약 4시간 29분 |
| 120×40 | 119×76 | 624 B | 15 KB/s | 약 1분 11초 | 약 1시간 14분 |
| **200×55** | 199×106 | 1.73 KB | **41.5 KB/s** | **약 26초** | 약 27분 |
| 240×67 | 239×130 | 2.59 KB | 62 KB/s | 약 17초 | 약 18분 |

200×55까지 시뮬레이션으로 검증했고, 그보다 큰 화면은 계산값이다(카메라가 모듈을 구분할 수 있어야 한다).

## 동작 원리

```
송신: 파일 → (deflate) → RaptorQ 조각 96 B → 타일 128 B (+ RS 패리티, CRC-32C) → ▀ 격자 → 터미널
수신: 카메라 → 격자 검출 → 타일 RS·CRC → 조각 모으기 → 아무 조각이나 K + 2개 → 복원 → SHA-256 → 저장
```

- 처음에는 원본 조각을 한 바퀴 보내고, 그다음부터는 여러 원본을 섞은 복구 조각을 끝없이 새로 만든다.
  어떤 조각을 놓쳤는지는 상관없이 개수만 채우면 된다. 원본을 하나도 못 받아도 복구 조각 K개로 풀린다.
- 타일마다 따로 검증하므로, 화면이 바뀌는 도중에 찍힌 사진에서도 섞인 줄이 지나간 타일만 버린다.
- 결정과 그 이유, 기술 스택: [`docs/adr/`](docs/adr/README.md)

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/adr/`](docs/adr/README.md) | 결정 기록 11개, 기술 스택 |
| [`docs/protocol-v2.md`](docs/protocol-v2.md) | 비트 단위 프레임 규격 |
| [`docs/receiver-v2.md`](docs/receiver-v2.md) | 수신기 설계 |
| [`docs/optical-v2.md`](docs/optical-v2.md) | 설계 탐색 기록 (찢어짐 모델, 용량 계산) |
| [`docs/v1/`](docs/v1/README.md) | v1 개념 검증 (TypeScript + QR) |

## 개발

```
crates/opticast-core/    배치·타일·RS·RaptorQ·META·ANSI·수신 조립 (I/O 없음, wasm32 빌드)
crates/opticast-cli/     opticast 바이너리 (send, plan)
crates/opticast-vision/  카메라 영상에서 격자 검출과 샘플링 (외부 의존 없음)
crates/opticast-wasm/    vision + core 를 C ABI wasm 으로
crates/opticast-sim/     테스트용 래스터라이저와 가상 카메라
web/                     수신 페이지 (TypeScript, Vite, Worker)
tools/                   wasm 빌드, e2e, 시뮬레이터, 측정 도구
src/, test/              v1 (TypeScript + QR) 코드와 테스트
.github/workflows/       CI, Pages 배포, 릴리스
```

```sh
cargo build --release                  # target/release/opticast
cargo test --workspace --release       # Rust 테스트
pnpm install
pnpm typecheck
pnpm wasm:build && pnpm test           # 수신 WASM 빌드 후 TS 테스트
pnpm dev:v2                            # 수신기 로컬 실행 (localhost)
pnpm dev:v2:lan                        # 같은 LAN의 폰에서 접속 (자체 서명 HTTPS)
pnpm e2e:v2                            # 실제 송신 프레임 → 가상 카메라 → Chrome 수신기, 바이트 비교
pnpm e2e:v2 --url https://cagojeiger.github.io/OptiCast/ --resize-to 160x45   # 배포본, 전송 중 크기 변경
pnpm e2e:v2 --headed --hold 20         # 보이는 Chrome으로 시연
cargo test -p opticast-cli --test tmux_probe -- --ignored --nocapture        # 실제 tmux 화면 캡처로 복원
```

이 Mac처럼 rustup 기본 툴체인이 x86_64이면 cargo 앞에
`RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin DEVELOPER_DIR=/Library/Developer/CommandLineTools`를 붙인다
(`pnpm` 스크립트는 `tools/cargo.ts`가 자동으로 붙인다).

- `main`에 push하면 수신기가 GitHub Pages에 다시 배포된다.
- `v*` 태그를 push하면 송신 바이너리 4종이 릴리스에 올라간다.
- PR은 squash로 머지하고, 커밋 제목은 `type(scope): 설명 (#N)` 형식으로 쓴다.

## 안전 경계

격리망 데이터 반출은 조직의 명시적 승인과 보안 정책을 따라야 한다. 카메라도 반출 경로다.
송신 CLI는 크기 상한만 검사한다. 허용 목록, 민감정보 검사, 감사 기록은 아직 없다.
수신 웹은 서버 업로드나 원격 전송을 하지 않고, 복원한 파일을 열지 않으며 사용자 동작으로만 저장한다.

## 라이선스

Apache-2.0
