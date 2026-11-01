# ADR 0011: 배포 — 수신기는 GitHub Pages, 송신기는 GitHub Releases

- Status: Accepted
- Date: 2026-11-01

## Context

카메라 API는 HTTPS(보안 컨텍스트)에서만 동작한다. LAN 개발 서버의 자체 서명 인증서는 접속할 때마다 경고가 뜨고,
수신하려면 맥이 켜져 있어야 한다. 송신기는 서버마다 받아야 하고, 리눅스 서버는 glibc 버전과 아키텍처가 제각각이다.

## Decision

- **수신기**: `main`에 push하면 `.github/workflows/pages.yml`이 wasm과 Vite를 빌드해 GitHub Pages에 배포한다
  (build_type = workflow). 주소는 https://cagojeiger.github.io/OptiCast/ 이고, 자원 경로는 상대 경로(`base: './'`)다.
- **송신기**: `v*` 태그를 push하면 `.github/workflows/release.yml`이 musl 정적 바이너리(x86_64, aarch64)와
  macOS 바이너리(arm64, x86_64)를 빌드해 릴리스에 올린다. 파일 이름에 버전을 넣지 않고 sha256을 함께 올린다.
  그래서 `releases/latest/download/opticast-<target>.tar.gz` 주소가 항상 최신을 가리킨다.
- **CI**(`ci.yml`): PR과 `main`에서 rustfmt, cargo test, core의 wasm 빌드, 타입 검사, vitest를 돌린다.
- **머지 규칙**: PR 하나를 squash 커밋 하나로 합친다. 제목은 `type(scope): 설명 (#N)`이다.

## Rationale

대안과 선택 이유:

- **LAN 개발 서버(`pnpm dev:v2:lan`)**: 개발용으로 남긴다. 인증서 경고가 뜨고 맥이 필요하다.
- **빌드 결과를 `gh-pages` 브랜치에 직접 푸시**(처음 방식): 수동이라 소스와 빌드가 어긋날 수 있다. Actions로 바꾸고 브랜치는 지웠다.
- **자체 호스팅**: 운영 부담이 있다. Pages는 정적, HTTPS, 무료다.
- **glibc 동적 바이너리**: 서버마다 glibc 버전 차이로 실행이 안 될 수 있다. musl 정적 링크가 안전하다.
- **버전이 붙은 파일 이름**: 설치 명령이 릴리스마다 바뀐다.

## Consequences

- 수신기 주소는 공개되어 누구나 열 수 있다. 정적 페이지이고 업로드가 없으므로 노출 위험은 없다.
- 오프라인 폰에서 쓰려면 미리 한 번 열어 둬야 한다. PWA 오프라인 캐시는 아직 없다.
- 서버 설치는 한 줄이다:
  `curl -fsSL https://github.com/cagojeiger/OptiCast/releases/latest/download/opticast-x86_64-unknown-linux-musl.tar.gz | tar xz`
- 리눅스 바이너리는 정적 링크까지만 확인했고, 실제 리눅스에서 실행해 보는 일은 남아 있다(같은 코드의 리눅스 CI 테스트는 통과).
