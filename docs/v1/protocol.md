# OptiCast 프로토콜 v1

순환 방송형 단방향 광학 전송. 송신자는 한 주기(cycle)의 프레임을 무한 반복하고(프레임 바이트 F(t+T) = F(t)),
수신자는 아무 시점에나 합류해 순서와 무관하게 블록을 모은다. ACK·핸드셰이크·시간 동기화는 없다.

## 계층

| 계층 | v1 구현 | 위치 |
|---|---|---|
| Application | 임의 바이너리 (JSON은 그중 하나) | — |
| Envelope | 메타데이터, SHA-256 | `src/core/envelope.ts` |
| Coding | 선택적 deflate-raw, 고정 크기 블록 (FEC 없음) | `src/core/transfer.ts` |
| Framing | magic/version/type/id/index/count/len + CRC-32 | `src/core/frame.ts` |
| Optical | **QR Code byte mode** (기준점·방향·quiet zone·심볼 내부 RS ECC) | `src/sender/qr.ts` |
| Rendering | ANSI 터미널 (`half` / `bg`) | `src/sender/terminal.ts` |
| Receiver | 카메라 → 축소 → 3×3 디노이즈 → jsQR → 프레임 → 조립 → SHA-256 | `src/receiver/` |

## 프레임

한 프레임 = 광학 심볼 하나(v1에서는 QR 하나). 정수는 big-endian.

| offset | size | 필드 |
|---|---|---|
| 0 | 2 | magic `"OC"` (0x4F 0x43) |
| 2 | 1 | protocol version = 1 |
| 3 | 1 | type: 0 = META, 1 = DATA |
| 4 | 4 | transfer id = CRC-32(envelope bytes) |
| 8 | 2 | block index (DATA) / 0 (META) |
| 10 | 2 | block count (DATA 블록 총수, 1–65535) |
| 12 | 2 | payload length *n* |
| 14 | *n* | payload |
| 14+*n* | 4 | CRC-32 over bytes [0, 14+*n*) |

오버헤드 18바이트. CRC는 화면 갱신 중 찍힌 찢어진 프레임과 타 QR을 걸러내며, QR 자체 ECC와 별개다.

## Envelope (META payload)

| offset | size | 필드 |
|---|---|---|
| 0 | 4 | 원본 크기 |
| 4 | 4 | 인코딩 크기 (압축 후 = DATA payload 합) |
| 8 | 2 | block size (마지막 블록만 짧을 수 있음) |
| 10 | 1 | compression: 0 = none, 1 = deflate-raw |
| 11 | 32 | 원본 SHA-256 |
| 43 | 1+m | MIME 길이 + UTF-8 |
| .. | 1+f | 파일명 길이 + UTF-8 |

META는 한 프레임에 들어가야 하므로 파일명은 확장자를 보존하며 바이트 예산에 맞게 잘린다.
transfer id가 envelope에서 유도되므로 내용 *또는* 블록 크기·압축이 바뀌면 id도 바뀐다 —
수신자가 호환되지 않는 두 방송의 블록을 섞을 수 없다. 같은 입력·파라미터는 같은 프레임 열을 만든다.

## 주기

```
[META] D0 D1 … D9 [META] D10 … D19 [META] … D(N-1)   → 반복
```

`--meta-every` (기본 10) 데이터 프레임마다 META를 넣어, 어느 시점에 합류해도 곧 메타데이터를 받는다.

프레임 바이트는 매 주기 같지만 광학 심볼은 다르다: 주기 c에서는 QR 마스크를 인코더 선택값에서 c칸 돌린다
(`(auto + c) mod 8`). 고정된 카메라 자세에서 특정 모듈 무늬가 센서 격자와 겹쳐 매번 읽히지 않는 경우가 있는데
(시뮬레이션: 기본 마스크 0/6 → 다른 마스크 6/6), 같은 그림을 그대로 반복하면 그 블록은 영원히 오지 않는다.
마스크는 QR 형식 정보에 들어 있으므로 수신기는 아무것도 알 필요가 없다.

수신기는 같은 블록이 다시 보이는 간격으로 주기 길이를 잰다(놓친 주기는 표본을 늘릴 뿐이므로 최근 8개 중 최솟값).
남은 블록이 있으면 "남은 블록 K개 — 송신 화면이 T마다 한 바퀴 돕니다"로 안내한다.

## 수신 규칙

1. CRC가 맞는 첫 DATA 프레임의 (transfer id, count)에 **임시로** 잠근다. 검증된 META가 오면 확정하고,
   확정 전에 다른 id의 검증된 META가 오면 그쪽으로 갈아탄다(이전 방송의 잔여 프레임에 붙잡히지 않도록).
   확정 후 다른 id는 `foreign`으로 세기만 한다.
2. DATA는 META보다 먼저 와도 보관한다. 중복은 버린다.
3. META는 `crc32(payload) == transfer id`이고 count가 `ceil(encodedSize / blockSize)`와 맞을 때만 받는다.
4. 완료 = META 보유 ∧ 모든 블록 보유. 이후 블록 길이 검사 → (선언 크기로 제한된) inflate → 길이 검사 → SHA-256.
5. SHA-256까지 일치해야만 성공. 실패하면 파일을 내놓지 않는다.

## 알려진 한계 (v1)

- 프레임 간 FEC 없음: 모든 블록을 각각 한 번은 봐야 한다. 프레임 손실률 p, 블록 N개면 필요한 주기 수가
  대략 `ln(N / ln 2) / ln(1/p)` (중앙값)로 N에 따라 늘어난다 — 큰 파일은 마지막 몇 블록을 기다리는 꼬리가 길다.
  MVP-2에서 RS erasure 또는 fountain 코드로 "아무 블록이나 N·(1+ε)개"로 바꾼다.
- 블록 수 65535 상한 (uint16).
- 광학 밀도는 QR 상한 (v40-L 2953 B/프레임). 고밀도 격자는 MVP-3.
