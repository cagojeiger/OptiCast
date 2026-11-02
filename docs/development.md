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

시뮬레이터는 둘이다. `tools/sim`(TS)은 실제 송신 ANSI 바이트를 VTerm으로 재생해 배포되는 wasm과 `web/wasm.js`에 넣는다(수신기 테스트, e2e, `tools/floor.ts`, 설정 페이지 그림).
`crates/diodecam-sim`(Rust)은 `ModuleGrid`를 3D 자세(yaw·pitch·roll), 렌즈 왜곡, 밝은·어두운 테마로 그려 vision 테스트 안에서 바로 쓴다.
새 vision 시나리오는 Rust 쪽에 넣고, TS 쪽은 wasm과 JS를 거쳐야 하는 것만 늘린다. `docs/web.md` 3·7절의 바닥 숫자는 TS 시뮬레이터 값이다.

언어: 본문 한국어; 화면 문구·DESIGN.md·코드와 주석은 영어; 문서는 화면 문구를 영어 그대로 인용한다.

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
node tools/floor.ts [cols] [rows]      # 디코더 바닥: 모듈 px × 블러별 타일 인식률 (vision 변경 전후 비교 기준선, 송신기와 wasm을 먼저 빌드)
node tools/third-party-licenses.ts     # THIRD_PARTY_LICENSES.md: 송신기에 링크되는 크레이트의 라이선스 전문 (Cargo.lock이 바뀌면 다시 만든다)
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

- `.github/workflows/ci.yml`: PR과 `main`에서 typecheck, rustfmt, clippy, cargo test, WASM 빌드, JS 테스트(CI에서는 wasm 수신기 테스트를
  건너뛰지 않는다), 사이트 조립. 조립은 통과한 WASM과 `web/`을 복사하고 `__V__`를 커밋 해시로, `__VERSION__`을 `Cargo.toml`의 버전으로
  바꾸며, 버전을 못 읽거나 자리표시자가 남으면 실패한다. `main`이면 그 사이트를 GitHub Pages에 배포한다. 테스트가 깨진 커밋은 배포되지 않고,
  같은 브랜치에서는 실행이 한 번에 하나만 돈다. 새 push는 도는 실행을 기다리지만 기다리는 실행은 하나만 남으므로,
  그 사이에 더 새 push가 오면 기다리던 실행은 취소되고 가장 새 커밋만 배포된다(옛 실행을 다시 돌리면 그 커밋이 다시 배포된다).
  커밋 해시가 오프라인 캐시 이름이 되므로 새 배포는 다음 온라인 접속에서 옛 캐시를 대체한다.
- `v*` 태그 → `.github/workflows/release.yml`: 태그 커밋이 테스트(cargo test, typecheck, WASM 빌드와 JS 테스트)를 통과하면 `diodecam-<target>.tar.gz`(+ sha256) 4종을 릴리스에 올린다. 아카이브에는 바이너리, LICENSE, THIRD_PARTY_LICENSES.md, README가 들어간다.
  파일 이름에 버전이 없으므로 `releases/latest/download/…` 주소가 고정이다.
- PR은 squash 머지하고, 커밋 제목은 `type(scope): 설명 (#N)`이다.
