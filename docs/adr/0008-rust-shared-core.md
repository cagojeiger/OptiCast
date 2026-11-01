# ADR 0008: Rust 송신기와 송수신 공유 코어

- Status: Accepted
- Date: 2026-11-01

## Context

송신기는 격리된 서버에서 돌아야 한다. 그런 서버에는 런타임(Node, Python)을 들이기 어렵고, 배포판마다 glibc 버전이 다르며,
아키텍처도 x86_64와 aarch64가 섞여 있다. 또 송신기가 그리는 형식과 수신기가 읽는 형식이 조금이라도 어긋나면 안 된다.

v1은 TypeScript 하나로 양쪽을 공유했지만, 송신하려면 서버에 Node 22가 있어야 했다.

## Decision

- 언어는 **Rust**다.
- **`opticast-core`**: 배치, 타일, RS, RaptorQ, META, ANSI 생성, 수신 조립. I/O가 없고 wasm32로 빌드된다.
  송신 CLI와 수신 WASM([0009](0009-wasm-receiver.md))이 **같은 코드**를 쓴다.
- **`opticast-cli`**: `opticast send | plan`.
  - clap 4: 인자 처리
  - crossterm 0.28: raw 모드, 터미널 크기, 키 입력, 크기 변경 이벤트
  - signal-hook 0.3: SIGTERM/SIGHUP을 받으면 터미널을 복원하고 끝낸다. 두 번째 신호는 즉시 종료한다.
  - libc: 입력 파일을 `O_NONBLOCK`으로 열어 FIFO에서 멈추지 않게 한다.
- 배포 바이너리: 리눅스는 musl 정적 링크(x86_64, aarch64), macOS는 arm64와 x86_64. 약 1 MB짜리 파일 하나다.

## Rationale

대안과 선택 이유:

- **TypeScript/Node(v1)**: 서버에 Node 22가 필요하다. 단일 실행 파일로 묶는 방법(pkg, SEA)은 크고 불안정하다.
- **Go**: 정적 바이너리는 쉽지만, 브라우저 수신기와 코어를 공유하기 어렵다(TinyGo WASM은 제약과 크기 문제가 있다).
- **C/C++**: 공유는 되지만 메모리 안전성과 빌드 부담이 있다.
- **Python**: 런타임이 필요하다.
- **Rust** (채택): 정적 바이너리와 같은 코드의 wasm32 빌드를 둘 다 얻는다. RaptorQ와 RS가 순수 Rust 크레이트로 있다.

## Consequences

- 규격 변경은 core 한 곳에서 하면 송신과 수신에 동시에 반영된다.
- 테스트는 core 단위 테스트, ANSI 왕복 e2e, CLI 검증, 실제 tmux 화면 캡처 복원으로 구성된다(Rust 테스트 120개, 리눅스 CI에서도 실행).
- 개발용 Mac에서 rustup 기본 툴체인이 x86_64인 문제는 `tools/cargo.ts`가 자동으로 우회한다.
- 알려진 문제: 터미널이 비정상으로 사라지면(SSH 끊김, tmux 강제 종료) 송신기가 CPU 100%로 남는다. SIGTERM으로는 끝난다.
  수정 계획은 0.5초마다 `/dev/tty`를 확인해 터미널이 없으면 끝내는 것이다.
