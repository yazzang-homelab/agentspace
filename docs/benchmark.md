# 벤치마크: agentspace vs 일반 Chromium "computer use"

같은 쇼핑 작업을 두 방식으로 수행해 비교했습니다. 하나는 agentspace를 통한 방식, 다른 하나는 일반 Chromium을 직접 조작하는 화면 기반(computer use) 방식입니다. 에이전트가 브라우저 도구를 부르는 흐름처럼 **라운드마다 프로세스를 하나씩** 띄웠습니다. 라운드는 "행동 → 기대 상태 대기 → 관찰"로 구성됩니다.

- 측정일: 2026-10-18 00:42 (KST)
- 환경: Intel Xeon E-2124G(4코어), 메모리 7 GiB, Debian 13
- 브라우저: Chromium 155.0.8059.79, 두 방식 모두 헤드리스로 같은 바이너리를 사용
- 런타임: Node.js v24.22.0
- 반복: 5회. 표의 값은 중앙값입니다.
- 재현: `npm run bench` (원시 결과는 `bench/results/headless.json`)

## 작업

`bench/app.mjs`의 결정적인 로컬 쇼핑 앱에서 6라운드를 진행합니다. 라운드 구성은 아래 라운드별 표와 같습니다. 성공 기준은 마지막 화면에 `Order ORD-1042 for Ada Lovelace: Mechanical Keyboard K2 (express)`가 나오는 것이고, 모든 반복에서 두 방식 다 성공했습니다.

| | agentspace | 일반 Chromium (raw CDP) |
| --- | --- | --- |
| 한 라운드 | `agentspace run` 스크립트 1회 | `node bench/raw-round.mjs` 1회 |
| 대상 지정 | 시맨틱 로케이터 (`loc=role:button[name="Sign in"]`) | 요소 중심 좌표 클릭, `Input.insertText`로 입력 |
| 대기 | SDK `waitForURL` / `waitForFunction` | `Runtime.evaluate` 50ms 폴링 |
| 관찰 | `page.snapshot()` (뷰포트 접근성 트리 텍스트) | 스크린샷 PNG (함께 기록한 `outerHTML` 크기는 참고용) |

일반 Chromium 쪽은 모델이 스크린샷을 보고 좌표를 고르는 과정을 DOM 좌표로 대신했습니다. 따라서 이 쪽에는 좌표를 잘못 찍는 실패가 없고, 모델 추론 시간은 양쪽 모두 측정에 넣지 않았습니다.

## 결과 요약

| 지표 | agentspace | 일반 Chromium |
| --- | ---: | ---: |
| 작업 전체 (6라운드) 중앙값 | **3,120 ms** (2,853–3,193) | **1,358 ms** (1,306–1,462) |
| 빈 라운드 고정 비용 | 125 ms | 99 ms |
| 콜드 스타트 (브라우저 기동) | 684 ms | 219 ms |
| 관찰 토큰 합계 (6라운드) | **≈1,931** (텍스트) | **≈8,311** (스크린샷) / ≈4,060 (HTML이었다면) |
| 관찰 데이터 크기 합계 | 7.7 KB 텍스트 | 152 KB PNG / 16 KB HTML |
| 상주 메모리 (작업 종료 시점) | 950 MiB | 839 MiB |

토큰은 추정치입니다. 텍스트는 4자당 1토큰, 이미지는 Anthropic이 공개한 근사식인 `가로×세로/750`으로 계산했습니다(1280×813 → 약 1,388토큰).

## 라운드별

| 라운드 | agentspace ms | Chromium ms | agentspace 관찰 토큰 | 스크린샷 토큰 | HTML 토큰 | PNG 크기 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. 로그인 페이지 열기 | 433 | 229 | 171 | 1,388 | 451 | 13.3 KB |
| 2. 로그인 | 659 | 265 | 657 | 1,371 | 1,322 | 46.4 KB |
| 3. 상품 검색 | 473 | 212 | 365 | 1,388 | 676 | 27.9 KB |
| 4. 장바구니 담기 | 300 | 179 | 366 | 1,388 | 678 | 28.3 KB |
| 5. 장바구니 → 결제 | 441 | 216 | 253 | 1,388 | 564 | 20.2 KB |
| 6. 폼 작성·주문 | 793 | 263 | 119 | 1,388 | 369 | 16.3 KB |

## 해석

**지연 시간은 일반 Chromium이 약 2.3배 빠릅니다.** 차이 약 1.8초의 대부분은 라운드마다 반복되는 고정 비용입니다. 별도로 한 번 쪼개서 측정한 값은 다음과 같습니다(따뜻한 스페이스 기준).

- 빈 라운드: 125 ms. CLI → 데몬 → Node 헬퍼를 거치고 SDK를 로드하는 비용입니다.
- `taskSpace()` 재선택: 약 116 ms. 스페이스 조회, Page 레이블 장부 복원, 백그라운드 탭 탐색 초기화가 포함됩니다.
- `page.fill()` 한 번: 130–160 ms. 동작 가능 여부 확인, 화면 안으로 스크롤, 실제 키 입력 이벤트가 포함됩니다.
- `page.snapshot()`: 25–30 ms. 관찰 자체는 저렴합니다.

정리하면 라운드당 약 240 ms(× 6라운드 ≈ 1.45초)가 "매번 새 프로세스로 스페이스에 다시 붙는" 비용입니다. 나머지는 SDK가 행동 전후에 수행하는 안전 확인 비용입니다. 반면 일반 Chromium 쪽은 좌표를 그대로 찍고, 대상이 존재하는지만 폴링합니다.

**관찰 비용은 agentspace가 스크린샷 대비 약 4.3배, HTML 대비 약 2.1배 적습니다.** 에이전트 루프에서는 라운드마다 수 초씩 걸리는 모델 추론과 입력 토큰이 실제 비용을 좌우합니다. 그래서 라운드당 수백 ms의 차이보다 관찰 토큰 차이가 전체 비용에 더 크게 작용할 가능성이 높습니다. 스냅샷에는 다음 행동에 바로 쓸 수 있는 `ref`와 안정 로케이터가 들어 있어, 좌표를 추론할 필요도 없습니다. 아래는 4라운드 관찰의 일부입니다.

```
root
  banner
    navigation
      link "Products" [ref=269, loc=href:/shop, url=http://127.0.0.1:44833/shop]
      link "Cart (1)" [ref=272, loc=href:/cart, url=http://127.0.0.1:44833/cart]
  main
    search
      label_text
        text "Search"
        textbox "Search" value="keyboard" [ref=251, loc=role:textbox[name="Search"]]
    paragraph
      text "4 results"
    heading "Mechanical Keyboard K2" level=2
    button "Add Mechanical Keyboard K2 to cart" disabled [ref=296, loc=role:button[name="Add Mechanical Keyboard K2 to cart"]]
      text "Added"
```

**메모리는 agentspace가 약 110 MiB 더 씁니다.** 데몬 Node 프로세스, 브라우저 시작 창, 작업 스페이스 창이 따로 떠 있기 때문입니다.

## 한계

- 결정적인 로컬 페이지 하나로 측정했습니다. 실제 사이트의 네트워크 지연과 동적 UI는 반영되지 않았습니다.
- 일반 Chromium 쪽은 DOM으로 좌표를 구했으므로, 실제 화면 기반 에이전트의 오클릭이나 재시도 비용은 포함되지 않았습니다. 그쪽 성공률은 이 벤치보다 낮을 수 있습니다.
- 헤드리스 기준입니다. 헤드풀에서는 렌더링 비용이 더 들고, agentspace는 에이전트 커서 애니메이션도 그립니다.
- 토큰 수는 추정식이며 모델 토크나이저로 센 값이 아닙니다.
