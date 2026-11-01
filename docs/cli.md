# DiodeCam CLI — 송신기

터미널에서 파일을 화면 프레임으로 끝없이 방송한다. 화면 형식은 [`protocol.md`](protocol.md)를 따른다.

## 1. 명령과 옵션

```
diodecam send <FILE> [--fps 24] [--profile auto|ssh|vt100] [--max-bytes 64MiB] [--no-compress]
diodecam --help | --version
```

| 옵션 | 기본 | 설명 |
|---|---|---|
| `--fps` | 24 | 1~60. 30이면 30fps 카메라와 위상이 고정될 수 있어 시작 전에 안내한다 |
| `--profile` | auto | `ssh`(반블록) / `vt100`(공백 + 반전). auto 규칙은 protocol 1절 |
| `--max-bytes` | 64MiB | `512KiB`, `1GiB`, `10MB` 같은 단위 |
| `--no-compress` | | deflate를 시도하지 않음 |

`<FILE>`은 **일반 파일 하나**만 받는다. 디렉터리는 `tar czf out.tgz dir/`로 묶으라고 안내하고, 장치·FIFO·소켓,
상한을 넘는 파일, 터미널이 아닌 출력은 화면을 바꾸기 전에 거부한다. 옵션은 `--name value`와 `--name=value` 둘 다 된다.

## 2. 화면

| 상태 | 화면 |
|---|---|
| 전송 중 | 격자가 fps마다 바뀌고 아래 2줄이 상태 줄 |
| 일시 정지 | 마지막 격자를 그대로 두고 상태 줄에 `PAUSED` |
| 창이 너무 작음 | `Terminal too small …`, 필요한 최소 크기, `[q] quit`. 창을 키우면 바로 전송으로 돌아간다 |

창 크기가 바뀌면(SIGWINCH) 다음 프레임부터 새 배치로 그린다. 조각 번호와 전송 ID는 배치와 무관하므로 전송이 이어진다.

## 3. 상태 줄 (아래 2줄, ASCII만)

```
 DiodeCam  report.pdf 1.00 MB -> 412 KB deflate  id 3f2a9c1e  ssh 199x106  19 tiles 1.73 KB/frame
 00:41  source 100% [##########]  +repair 13,420  24 fps  41.5 KB/s  phone needs ~10s of view  [+/-] fps [space] pause [q] quit
```

- **phone needs**: 필요한 조각 수(K + 2) ÷ 초당 DATA 조각 수(fps × (N − 1/m), fps는 측정값이 있으면 측정값). 폰이 화면을 이만큼 보고 있으면 된다.
- **source**: 원본 조각 한 바퀴의 진행률. **+repair**: 그 뒤로 보낸 복구 조각 수.
- **fps**: 목표와 실제(최근 2초 동안 write가 끝난 시각으로 잰 값)가 다르면 `24/11 fps`처럼 둘 다 보인다(SSH가 느릴 때).
- 폭이 좁으면 키 안내 → 진행 막대 → ID 순서로 빼고, 그래도 넘치면 자른다. 열 C − 1을 넘지 않고 공백으로 채운다. 크기 단위는 SI.

## 4. 키와 종료

| 키 | 동작 |
|---|---|
| `+` / `-` | fps 2, 3, 5, 8, 10, 12, 15, 20, 24, 30 단계 |
| space | 일시 정지 / 재개 |
| `q`, ESC, Ctrl-C | 종료(대체 화면과 raw 모드 복원) |

- 키는 별도 스레드가 stdin에서 바이트로 읽는다. 화살표 같은 이스케이프 시퀀스는 버린다.
- **stdin이 EOF면 터미널이 사라진 것**(SSH 끊김, tmux 강제 종료)이므로 SIGHUP이 오지 않아도 끝낸다.
- 종료 코드: 정상 0, 입력 오류 1, 사용법 오류 2, Ctrl-C 130, SIGTERM 143, SIGHUP 또는 터미널 끊김 129.
  두 번째 SIGTERM/SIGHUP은 즉시 종료한다.
- 끝나면 한 줄을 남긴다: `diodecam: report.pdf id 3f2a9c1e: 1,234 frames in 00:52, source 100%, +repair 13,420 (quit)`

## 5. 코드 구조 (`crates/diodecam-cli/src`)

| 파일 | 역할 |
|---|---|
| `main.rs` | 진입점: 인자 → 실행 → 종료 코드 |
| `args.rs` | 사용법 문구, 인자 파싱(라이브러리 없음), 프로필 선택 |
| `file.rs` | 보낼 파일 검사, 크기 단위 해석 |
| `send.rs` | 송신 루프: 타이밍, 키, 크기 변경, 그리기, fps 측정 |
| `status.rs` | 상태 줄과 숫자 형식 |
| `term.rs` | raw 모드·대체 화면 복원, 신호, 키 입력 스레드 |
| `frames.rs` | 숨김 명령 `frames`: 연속 프레임의 ANSI를 JSON 줄로(수신기 테스트용) |

의존성은 `diodecam-core`, `crossterm`(raw 모드와 크기만), `signal-hook`뿐이다.
