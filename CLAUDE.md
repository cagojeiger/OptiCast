# CLAUDE.md

## 프로젝트 경계

- crate는 책임 단위다. 각 crate가 자기 `src/`와 `tests/`를 소유하며, 쓰는 곳의 수나 크기를 이유로 합치지 않는다.
- `diodecam-core`는 화면 형식(배치·타일·RS·RaptorQ·META·ANSI), 송신 일정(`Transfer`)과 수신 조립(`Assembler`)만 소유한다. I/O·시계·스레드·카메라를 알지 못하며 wasm32로 빌드된다.
- `diodecam-cli`는 송신 바이너리의 인자, 파일 읽기, 터미널(raw 모드·크기·SIGWINCH), 키, 상태 줄을 소유한다. 영상 처리와 브라우저를 알지 못한다.
- `diodecam-vision`은 회색조 카메라 영상 → 모듈 격자(검출·추적·샘플링)만 소유한다. 타일·조립·ABI를 알지 못한다.
- `diodecam-wasm`은 배선을 소유한다: vision과 core `Assembler`의 수신 세션, 통계 JSON, 이어 받기 직렬화, C ABI. 영상 알고리즘과 화면 형식을 직접 구현하지 않는다.
- `diodecam-sim`은 테스트 전용(`publish = false`) 가상 터미널·카메라다. 진짜 송신 프레임을 위해 core에 의존하지만, 시험 대상인 vision과는 코드(호모그래피 등)를 공유하지 않는다(독립 오라클).
- `web/`은 빌드 없는 수신 페이지, `tools/`는 개발 도구(빌드, 서버, e2e, TS 시뮬레이터), `test/`는 JS 테스트다.
- 수신 웹은 아무것도 업로드하지 않고, 복원한 파일을 열지 않으며, 사용자 동작으로만 저장한다.

## 문서

- `docs/`는 한국어로 쓴다. 규격은 `protocol.md`, 송신기는 `cli.md`, 수신기는 `web.md`, 개발은 `development.md`, 결정은 `adr/`에 둔다.
- 화면 형식을 바꾸면 `protocol.md`와 core 테스트를 같은 변경에서 고친다.
- Accepted ADR의 의미가 바뀌면 기존 ADR을 `Superseded`로 표시하고 새 ADR에 현재 결정을 기록한다.

## 검증

```text
cargo fmt --all --check
cargo test --workspace --release
cargo clippy --workspace --all-targets --release -- -D warnings
pnpm typecheck && pnpm wasm && pnpm test
pnpm e2e        # 수신 경로(web/, wasm, vision)를 바꿨을 때
```

PR은 squash 머지하고, 커밋 제목은 `type(scope): 설명 (#N)`이다.
