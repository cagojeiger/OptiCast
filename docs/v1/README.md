# OptiCast v1 — 개념 검증 (TypeScript + QR)

> 이 문서는 v1 기록이다. 현재 제품은 v2(Rust 송신기 + WASM 수신기)이고 [루트 README](../../README.md)가 설명한다.
> v1에서 확인한 한계(화면을 다 못 쓰는 QR, 찢어진 프레임 전체 손실, 반복 대기)가 v2 결정의 출발점이다
> ([ADR 0003](../adr/0003-custom-frame-layout.md), [ADR 0006](../adr/0006-raptorq-fountain.md)).
> v1 코드(`src/`, `tools/e2e-fake-camera.ts`, `tools/probe/`)는 비교용으로 남아 있고 `pnpm send`, `pnpm e2e`로 그대로 돈다.
> 프레임 규격: [`protocol.md`](protocol.md).

송신 화면에 QR 프레임을 순환 반복하고, 스마트폰 브라우저가 카메라로 찍어 조립한다. FEC 없이 반복만 쓴다.

## 빠른 시작

요구 사항: Node ≥ 22.18 (TypeScript를 빌드 없이 직접 실행), pnpm.

```sh
pnpm install

# 송신: 터미널에서 프레임을 무한 반복 (+/- 속도, space 일시정지, q 종료)
pnpm send samples/approved.json

# 계획만 보기: QR 버전, 블록 수, 주기 시간
pnpm opticast plan samples/approved.json

# 수신: 같은 LAN의 폰에서 https://<이 PC의 IP>:5173 접속
#       (자체 서명 인증서 경고 → 계속 진행 → "카메라 시작")
pnpm dev:lan
```

카메라 API는 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작하므로 `dev:lan`은 자체 서명 HTTPS로 뜬다.
수신 페이지는 정적 파일(`pnpm build` → `dist/receiver/`)이라 어디든 HTTPS로 호스팅하면 된다.
수신기 URL 옵션: `?scan=960` (디코드 해상도), `?denoise=0` (디노이즈 끄기, A/B 비교용), `?rate=0.5` (동영상 재생 속도).
QR v20 이상을 쓰면 `?scan=1920`을 붙인다 — 1080p 카메라 영상을 960으로 줄이면 모듈이 너무 작아진다.

수신 중에는 "남은 블록 K개 — 송신 화면이 T마다 한 바퀴 돕니다"라고 안내한다. 놓친 블록은 다음 주기에 다시 나오니
그대로 비추고 있으면 된다. 주기 길이 T는 같은 블록이 다시 보이는 간격으로 수신기가 직접 잰다.

## 전송 시간 가늠

FEC가 없으므로 모든 블록을 한 번씩은 봐야 한다. 한 주기 시간 = 프레임 수 ÷ fps. 손실이 있으면 몇 주기가 더 필요하다.
1 MB 기준 (`pnpm opticast plan <파일> --qr-version N`으로 직접 확인):

| QR | 터미널 최소 | 압축 안 되는 1 MB | 예시 JSON 1 MB (→ 134 KB deflate, 압축률은 내용에 따라 다름) |
|---|---|---|---|
| v10 (기본 상한), 2 fps | 61×33 | 주기 49분 · 손실 5%면 약 2.5시간 | 주기 6.5분 · 약 15분 |
| v10, 5 fps | 61×33 | 주기 20분 · 약 1시간 | 주기 2.6분 · 약 6분 |
| v25 + `?scan=1920`, 5 fps | 121×63 | 주기 3.9분 · 약 10분 | 주기 31초 · 약 1분 |

손실 5%일 때 필요한 주기 수는 블록 5378개 기준 약 3주기, 706개 기준 약 2.3주기다 (중앙값, `ln(N/ln2)/ln(1/p)`).
fps를 올리면 QR 하나가 화면에 머무는 시간이 줄어 손실률이 오른다 — 실기기에서 맞춰야 할 값이다.

## 송신 옵션

| 옵션 | 기본 | 설명 |
|---|---|---|
| `--fps` | 2 | 초당 프레임. 전송 중 `+`/`-`로 조절 |
| `--ecc` | M | QR 오류 정정 L/M/Q/H |
| `--qr-version` | 자동 | 고정 QR 버전. 자동이면 터미널에 맞는 최대값 (`--max-version` 이하) |
| `--max-version` | 10 | 자동 선택 상한. 클수록 프레임당 용량↑, 카메라 인식 난도↑ |
| `--render` | half | `half`: ▀ 반블록(밀도 2배) / `bg`: 배경색 공백(글꼴 무관) |
| `--quiet` | 2 | quiet zone 모듈 수 |
| `--meta-every` | 10 | 데이터 N프레임마다 META 삽입 |
| `--cycles` | ∞ | N주기 후 종료 |
| `--max-bytes` | 1 MiB | 입력 크기 상한 |
| `--no-compress` | | deflate 끄기 |

## 검증

```sh
pnpm typecheck
pnpm test                      # 프로토콜·조립·광학 경로 단위 테스트 (34개)
pnpm e2e                       # 실제 Chrome + 가짜 카메라로 수신기 번들 end-to-end
pnpm e2e --items 600 --qr-version 10 --noise 16 --sender-fps 3.3   # 가혹 조건
pnpm e2e --items 1500 --qr-version 25 --camera 1920x1080 --scan 1920 --cycles 2   # 큰 QR, 고정 카메라 2주기
pnpm e2e --items 600 --camera-fps 30 --sender-fps 10 --cycles 2   # 폰 카메라 30fps, 송신 10fps
node tools/probe/distortions.ts   # 노이즈·블러·크기별 인식률 표
node tools/probe/tmux-cli.ts      # 실제 CLI 프로세스를 tmux에서 띄워 화면 캡처로 복원
node tools/probe/tear-model.ts    # 화면 갱신 도중 촬영(찢어짐) 시간 모델, 반복 vs 파운틴
node tools/probe/ssh-profile.ts   # v2 기본 프로필(▀ + 반전) 테마·줄 간격별 점 오류
```

폰 없이 검증하는 방법: `tools/sim/`의 가상 터미널이 송신기가 실제로 쓰는 ANSI 바이트를 재생해 픽셀로 만들고,
가상 카메라가 원근·디포커스·센서 노이즈·글레어를 입힌 뒤 `.y4m` 동영상으로 굽는다.
Chrome의 `--use-file-for-fake-video-capture`로 이것을 카메라로 물려 **실제 수신기 번들**을 돌린다.
영상은 주기 중간에서 시작하고, QR마다 첫 카메라 프레임은 위/아래가 다른 "찢어진" 화면이다.
Chrome은 이 파일을 그대로 반복 재생하므로 한 루프에서 실패한 프레임은 매 루프 실패한다 — `--cycles N`은 노이즈가 매번 다른
N주기를 찍어, 놓친 블록을 다음 주기에 만회하는 실제 상황을 재현한다.

## 개념 검증 결과 (2026-10-31, 시뮬레이션)

| 시나리오 | 결과 |
|---|---|
| 6.5 KB JSON → 1.5 KB deflate, 12블록, QR v8-M, σ=8, 5 fps | 3.3초, 바이트 일치 |
| 48.9 KB JSON → 10.8 KB, 56블록, QR v10-M, σ=16, 3.3 fps | 18.9초 (1주기), 바이트 일치 |
| 48.9 KB, 17블록, QR v20-M, 960×540 카메라 | 5.8초 (1주기), 바이트 일치 |
| 48.9 KB, 56블록, QR v10-M, 카메라 30fps, **송신 10fps** | 6.3초 (1주기, 손실 0). 15fps는 2주기, 스캔 20회/s로 줄이면 3.7주기 |
| 123 KB → 27 KB, 28블록, QR v25-M, 1920×1080 카메라 고정, `?scan=1920` | 16.9초 (2주기: 1주기에 놓친 2블록을 2주기에 만회), 바이트 일치 |
| 실제 `opticast send` (tmux TTY) 화면 캡처 | 4캡처로 복원, 바이트 일치 |
| 찢어진 프레임 | 전부 디코드 실패로 처리 (손상 0) — 잘못된 데이터 유입 없음 |

시뮬레이션이 찾아낸 두 가지:

1. **줄 간격 줄무늬**: 블록 글리프가 줄 높이를 다 채우지 않는 글꼴은 어두운 영역에 밝은 가로줄을 남겨
   QR 기준점 검출을 깨뜨렸다. → 같은 색 두 모듈은 배경색 공백, 다른 색일 때만 `▀`(fg=위, bg=아래)를 쓰도록
   바꿔 줄 간격이 항상 배경색(=아래 모듈 색)으로 칠해지게 했다.
2. **노이즈 절벽**: jsQR(ZXing HybridBinarizer와 같은 로직)은 8×8 블록 밝기 범위가 24 미만일 때만 평탄하다고 본다.
   스캔 해상도에서 σ≈5를 넘는 노이즈는 흰 영역을 얼룩으로 만든다. → 워커에서 3×3 박스 블러 후 디코드:
   1920×1080 센서 기준 σ=16에서 0/4 → 4/4.
3. **고정 자세에서 영원히 안 읽히는 프레임**: v25를 고정 카메라로 찍으면 특정 블록 하나가 노이즈를 바꿔도 매번 실패했다
   (기본 마스크 0/6, 같은 바이트를 다른 마스크로 그리면 대부분 6/6). 모듈 무늬가 센서 격자와 겹치는 문제라
   같은 그림을 반복해서는 "기다리면 된다"가 성립하지 않는다. → 송신기가 주기마다 QR 마스크를 한 칸씩 돌린다.
   프레임 바이트·프로토콜은 그대로이고, 수신 측 변경도 없다. 27/28에서 멈추던 시나리오가 2주기 만에 완료.

**아직 검증 안 된 것 (실기기 테스트 필요)**: 모아레, 롤링 셔터, 화면 반사, 실제 폰 자동 초점·노출,
iOS Safari 카메라 동작, 실제 터미널별 글리프 렌더링.

## 구조

```
src/core/       공유 프로토콜 (Node·브라우저 공통, Web 표준 API만 사용)
  frame.ts        프레임 직렬화 + CRC-32
  envelope.ts     META 메타데이터, 파일명 정규화
  transfer.ts     파일 → 주기 프레임, Assembler(수신 조립·검증)
src/sender/     송신 CLI (Node)
  qr.ts           광학 계층 v0: QR byte mode
  terminal.ts     ANSI 렌더링 (half / bg)
  plan.ts         터미널 크기 → QR 버전 선택
  cli.ts          send / plan
src/receiver/   수신 웹 (Vite)
  main.ts         카메라·동영상 입력, UI, 다운로드
  scanner.worker.ts  디코드 워커
  preprocess.ts   3×3 디노이즈
tools/sim/      가상 터미널·가상 카메라·y4m·png
tools/probe/    인식률 표, 실제 CLI tmux 검증
tools/e2e-fake-camera.ts
docs/v1/protocol.md
```
