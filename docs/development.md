# 개발

## 구조

crate는 책임 단위다. 쓰는 곳의 수나 크기를 이유로 합치지 않는다.

```
crates/diodecam-core/    화면 형식(배치·타일·RS·RaptorQ·META·ANSI), 송신 일정, 수신 조립. I/O·시계·카메라를 모른다. wasm32 빌드
crates/diodecam-cli/     송신 바이너리: 인자, 파일, 터미널, 키, 상태 줄 (docs/cli.md). 영상 처리·브라우저를 모른다
crates/diodecam-vision/  회색조 카메라 영상 → 모듈 격자 (docs/web.md 7절). 타일·조립·ABI를 모른다
crates/diodecam-wasm/    배선: vision + core Assembler 수신 세션, 통계 JSON, 이어 받기, C ABI
crates/diodecam-sim/     테스트 전용 가상 터미널·카메라. 시험 대상인 vision과 코드를 공유하지 않는다
web/                     수신 페이지 (docs/web.md, DESIGN.md)
tools/                   wasm 빌드, 로컬 서버, e2e 와 시뮬레이터, 아이콘·QR 생성
test/                    receiver.test.ts (node:test)
```

## 빌드와 테스트

```sh
cargo build --release                  # target/release/diodecam
cargo test --workspace --release       # Rust 테스트
cargo test -p diodecam-cli --test tmux_probe -- --ignored   # 실제 tmux 화면 캡처로 복원, 크기 변경, q
pnpm install && pnpm typecheck         # JSDoc 타입 검사 (tsc, 빌드 아님)
pnpm wasm && pnpm test                 # web/diodecam.wasm 빌드 후 JS 테스트
pnpm serve                             # http://localhost:5173 에서 수신기 (오프라인 캐시 없음: sw.js는 배포본에서만)
node tools/icons.ts                    # web/icon.svg 와 icon-*.png 다시 만들기
node tools/qr.ts                       # web/qr.svg (수신기 주소 QR, 데스크톱 설정 페이지용) 다시 만들기
node tools/terminal-example.ts         # web/example-terminal.svg (설정 페이지의 송신 화면 예시, 실제 프레임) 다시 만들기
```

rustup 기본 툴체인이 x86_64인 Mac에서는 cargo 앞에 `RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
DEVELOPER_DIR=/Library/Developer/CommandLineTools`를 붙인다. `pnpm` 스크립트는 `tools/cargo.ts`가 자동으로 붙인다.

## e2e (폰 없이)

`diodecam frames`(숨김 명령)가 만든 실제 프레임 ANSI → 가상 터미널 → 30fps 가상 카메라(기울기, 흐림, 노이즈,
화면 전환 중 찢어진 캡처) → `.y4m` → Chrome 가짜 카메라 → 수신기 → 받은 파일을 원본과 바이트 비교.

```sh
pnpm e2e                               # 로컬 web/ 를 띄워서 (끝나면 새로고침 후 받은 파일이 다시 보이는지도)
pnpm e2e --url https://cagojeiger.github.io/diodecam/   # 배포본
pnpm e2e --resize-to 160x45            # 전송 중 창 크기 변경
pnpm e2e --cols 120 --rows 40 --reload-after 6          # 새로고침 후 IndexedDB 이어 받기
pnpm e2e --headed --hold 20            # 보이는 Chrome 으로 시연
```

## 배포와 릴리스

- `.github/workflows/ci.yml`: PR과 `main`에서 rustfmt, clippy, cargo test, typecheck, WASM 빌드, JS 테스트. `main`이면 통과한
  WASM과 `web/`을 복사하고 `__V__`를 커밋 해시로, `__VERSION__`을 `Cargo.toml`의 버전으로 바꿔 GitHub Pages에 배포한다. 테스트가 깨진 커밋은 배포되지 않고,
  같은 브랜치의 실행은 push 순서대로 하나씩 돈다(옛 실행을 다시 돌리면 그 커밋이 다시 배포된다).
  커밋 해시가 오프라인 캐시 이름이 되므로 새 배포는 다음 온라인 접속에서 옛 캐시를 대체한다.
- `v*` 태그 → `.github/workflows/release.yml`: `diodecam-<target>.tar.gz`(+ sha256) 4종을 릴리스에 올린다.
  파일 이름에 버전이 없으므로 `releases/latest/download/…` 주소가 고정이다.
- PR은 squash 머지하고, 커밋 제목은 `type(scope): 설명 (#N)`이다.
