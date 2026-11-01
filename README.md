# OptiCast

SSH 터미널에 그린 흑백 격자를 폰 카메라로 찍어 파일을 옮기는 단방향 오프라인 파일 전송.
네트워크, USB, 앱 설치가 필요 없다. 실기기(아이폰 Safari)로 16.9 MB를 받아 원본과 바이트 단위로 같은 것을 확인했다.

## 사용법

1. 폰 Safari에서 **https://cagojeiger.github.io/OptiCast/** 를 열고 [카메라 시작].
2. 서버에서 보낸다(리눅스용은 정적 바이너리):

   ```sh
   curl -fsSL https://github.com/cagojeiger/OptiCast/releases/latest/download/opticast-x86_64-unknown-linux-musl.tar.gz | tar xz
   ./opticast-x86_64-unknown-linux-musl/opticast send report.pdf
   ```

   다른 대상: `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`. 폴더는 `tar czf`로 묶는다.
3. 터미널 화면 전체를 비춘다. 테두리가 초록이면 잘 읽히는 중이고, 놓친 화면은 신경 쓰지 않아도 된다.
4. "수신 완료"가 뜨면 [파일 저장]이나 [공유]로 저장한 **다음에** 터미널에서 `q`.

키: `+`/`-` fps, space 일시정지, `q` 종료. 옵션: `--fps`(기본 24), `--max-bytes`(기본 64MiB), `--profile auto|ssh|vt100`,
`--no-compress`. 수신기 주소 옵션: `?max=256`(MiB, 최대 512), `?scan=1920`, `?debug=1`.

## 속도

24fps, 손실 없음, 압축이 안 되는 파일. 터미널 크기는 자동으로 계산하고, 전송 중에 창 크기를 바꿔도 이어진다.

| 터미널 | 프레임당 | 초당 | 1 MiB |
|---|---|---|---|
| 80×24 | 173 B | 4.1 KB/s | 약 4분 13초 |
| 120×40 | 624 B | 15 KB/s | 약 1분 11초 |
| **200×55** | 1.73 KB | **41.5 KB/s** | **약 26초** |
| 240×67 | 2.59 KB | 62 KB/s | 약 17초 |

## 동작 원리

```
송신: 파일 → RaptorQ 조각 96 B → 타일 128 B (RS 패리티 + CRC-32C 포함) → ▀ 격자 → 터미널
수신: 카메라 → 격자 검출 → 타일 RS·CRC → 아무 조각이나 K + 2개 → 복원 → SHA-256 → 저장
```

원본 조각을 한 바퀴 보낸 뒤 섞은 복구 조각을 끝없이 보내므로, 어떤 조각을 놓쳤는지와 상관없이 개수만 채우면 된다.
규격은 [`docs/protocol.md`](docs/protocol.md), 결정과 이유는 [`docs/adr/`](docs/adr/README.md).

## 개발

```
crates/opticast-core/    배치·타일·RS·RaptorQ·META·ANSI·수신 조립 (I/O 없음, wasm32 빌드)
crates/opticast-cli/     opticast 바이너리
crates/opticast-vision/  카메라 영상에서 격자 검출과 샘플링
crates/opticast-wasm/    vision + core 를 C ABI wasm 으로
crates/opticast-sim/     테스트용 래스터라이저와 가상 카메라
web/                     수신 페이지 (빌드 없는 JS + Worker)
tools/, test/            wasm 빌드, 로컬 서버, e2e, 테스트
```

```sh
cargo test --workspace --release      # Rust 테스트
pnpm install && pnpm typecheck
pnpm wasm && pnpm test                # web/opticast.wasm 빌드 후 JS 테스트
pnpm serve                            # http://localhost:5173 에서 수신기
pnpm e2e                              # 실제 송신 프레임 → 가상 카메라 → Chrome 수신기, 바이트 비교
pnpm e2e --url https://cagojeiger.github.io/OptiCast/ --resize-to 160x45 --headed
```

이 Mac처럼 rustup 기본 툴체인이 x86_64이면 cargo 앞에 `RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
DEVELOPER_DIR=/Library/Developer/CommandLineTools`를 붙인다(`pnpm` 스크립트는 자동). `main` push는 Pages를,
`v*` 태그는 릴리스를 만든다. PR은 squash 머지, 제목은 `type(scope): 설명 (#N)`.

## 안전 경계

격리망 데이터 반출은 조직의 명시적 승인과 보안 정책을 따라야 한다. 카메라도 반출 경로다.
송신 CLI는 크기 상한만 검사한다. 수신 웹은 아무것도 업로드하지 않고, 복원한 파일을 열지 않으며 사용자 동작으로만 저장한다.

## 라이선스

Apache-2.0
