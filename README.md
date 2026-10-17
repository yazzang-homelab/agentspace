# agentspace

AI 에이전트와 사람이 같은 브라우저를 나눠 쓰기 위한 Linux용 브라우저 서비스입니다. 설치된 Chromium 계열 브라우저 위에서 동작하고, 에이전트에게 **태스크 스페이스** 단위의 격리된 창, 접근성 스냅샷, CDP 접근을 제공합니다.

> **비공식 프로젝트입니다.** agentspace는 CitroLabs 및 ego 제품과 관련이 없고, 그쪽의 보증이나 지원을 받지 않습니다. 오픈소스(MIT) [ego-browser SDK](https://github.com/citrolabs/ego-lite/tree/main/package/ego-browser)가 Linux에서 동작하도록 공개 문서를 기준으로 호환 런타임을 독자적으로 구현했습니다. "ego"는 해당 소유자의 상표이며, 이 문서에서는 호환 대상을 가리킬 때만 사용합니다.

## 특징

- **ego-browser SDK 호환**
  - `globalThis.ego` 바인딩을 [native-bindings-api.md](https://github.com/citrolabs/ego-lite/blob/main/docs/native-bindings-api.md) 기준으로 구현했습니다.
  - SDK의 브라우저 API(`taskSpace`, `page.snapshot()`, `page.click()` 등)는 그대로 씁니다. 바꾼 것은 명령 이름과 안내 문구뿐입니다(`patches/`).
- **태스크 스페이스**
  - 에이전트 작업마다 별도 창을 씁니다. 그 창에서 열린 팝업도 같은 스페이스에 속합니다.
  - 에이전트는 자기 스페이스의 탭만 보고 조작할 수 있습니다. 원시 CDP 메시지도 스페이스 단위로 걸러집니다.
- **스냅샷**
  - 접근성 트리를 `root` 기반 들여쓰기 텍스트로 출력합니다. 각 요소에는 `[ref=N, loc=..., url=...]` 표기가 붙습니다.
  - 일반 iframe과 다른 사이트 iframe(OOPIF) 안의 내용도 포함합니다.
- **사람과 협업**: 제어판에서 에이전트 스페이스의 제어권을 넘겨받고, 다시 에이전트에게 돌려줄 수 있습니다.
- **프로필**
  - 프로필마다 독립된 Chromium 데이터 디렉터리를 씁니다.
  - Chrome·Chromium·Edge·Brave 프로필을 가져올 수 있습니다.
- **헤드풀/헤드리스**: 데스크톱 세션에서는 창이 보이는 모드로, 서버에서는 헤드리스로 자동 선택합니다.

## 구조

```
agentspace (CLI) ──unix socket──▶ agentspace daemon
                                     ├─ Chromium (프로필별, CDP)
                                     ├─ 스페이스 레지스트리
                                     ├─ Node 헬퍼 (스크립트 실행: globalThis.ego + SDK)
                                     └─ 제어판 (127.0.0.1)
```

| 파일 | 역할 |
| --- | --- |
| `lib/cli.mjs` | `agentspace` 명령 |
| `lib/daemon.mjs` | 데몬, 스페이스 관리, RPC, 제어판 서버 |
| `lib/browser-host.mjs`, `lib/chromium.mjs` | Chromium 실행과 브라우저 수준 CDP 연결 |
| `lib/channel.mjs` | 스페이스별 CDP 다중화·필터링, JS 다이얼로그 유지 |
| `lib/snapshot.mjs` | 접근성 스냅샷 생성 |
| `lib/node-host.mjs`, `lib/ego-client.mjs` | 스크립트 실행 헬퍼와 `globalThis.ego` 바인딩 |
| `lib/clipboard.mjs` | `page.keyboard.paste()`용 브라우저 클립보드 트랜잭션 |
| `lib/importer.mjs`, `lib/profiles.mjs` | 프로필 관리와 가져오기 |
| `sdk/` | 업스트림 ego-browser SDK 빌드본 (MIT, `sdk/UPSTREAM.json`) |
| `patches/` | SDK에 적용하는 패치 (Linux 클립보드, 명령 이름) |
| `skill/` | 에이전트 진입 스킬 |

## 설치

필요한 것:

- Chromium 계열 브라우저 (`chromium`, `google-chrome`, `brave-browser`, `microsoft-edge` 중 하나)
- `git`, `curl`

Node.js 22 이상이 없으면 설치 스크립트가 Node 24를 `runtime/node`에 내려받습니다.

```bash
git clone https://github.com/yazzang-homelab/agentspace.git ~/.local/opt/agentspace
~/.local/opt/agentspace/install.sh
```

설치 스크립트가 하는 일:

- `~/.local/bin/agentspace` 링크를 만듭니다.
- 에이전트 스킬을 `~/.agents/skills/agentspace`에 복사합니다.
- `agentspace.desktop`을 설치합니다.
- systemd 사용자 서비스 `agentspace.service`를 등록합니다.

제거는 `install.sh --uninstall`로 합니다. 프로필과 스페이스 데이터는 남겨 둡니다.

## 사용

```bash
agentspace start        # 데몬과 기본 프로필 브라우저 시작
agentspace guide        # 에이전트용 사용 가이드 출력
agentspace run <<'EOF'
const task = await taskSpace("example");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(await page.snapshot());
EOF
agentspace run task.mjs # 파일로 실행 (-e '<코드>'도 가능, 터미널에서 인자 없이 실행하면 REPL)
agentspace panel        # 스페이스 제어판 URL (화면이 있으면 창으로 엽니다)
agentspace open <url>   # 사용자용 창 열기
agentspace profiles     # 프로필 목록
agentspace profiles detect
agentspace profiles import chrome Default
agentspace status | stop | upgrade
agentspace help <명령>  # 명령별 도움말
```

`-i, --instance <이름>`을 주면 데이터와 소켓이 분리된 별도 인스턴스를 씁니다.

데몬은 `agentspace` 명령을 처음 실행할 때 자동으로 시작합니다. 에이전트 하네스가 명령이 끝날 때 자식 프로세스를 정리한다면, 데몬이 함께 종료되지 않도록 systemd 사용자 서비스로 띄워 두세요.

### 환경 변수

| 변수 | 의미 |
| --- | --- |
| `AGENTSPACE_CHROMIUM` | 사용할 브라우저 실행 파일 |
| `AGENTSPACE_HEADLESS` | `1`이면 헤드리스, `0`이면 헤드풀. 기본은 `DISPLAY`/`WAYLAND_DISPLAY` 유무로 정합니다. |
| `AGENTSPACE_CHROMIUM_FLAGS` | 브라우저에 추가로 넘길 플래그 |
| `AGENTSPACE_HOME` | 데이터 디렉터리. 기본값 `~/.local/share/agentspace` |
| `AGENTSPACE_NODE` | Node.js 22 이상 실행 파일 |
| `AGENTSPACE_AGENT_CURSOR` | `0`이면 에이전트 커서 표시를 끕니다. |

Node 헬퍼는 호출한 셸의 환경 변수와 작업 디렉터리를 물려받지 않습니다. `agentspace run --sdk-path <index.js>`로 번들 SDK 대신 다른 SDK 빌드를 쓸 수 있습니다.

## 개발

```bash
npm test           # 단위 테스트 + 실브라우저 통합 테스트 (헤드리스 Chromium)
npm run e2e        # 업스트림 ego-browser real-browser E2E 스위트를 이 구현으로 실행
npm run build:sdk  # 업스트림 SDK를 고정 커밋 + patches/로 다시 빌드
npm run bench      # 쇼핑 작업 벤치마크 (agentspace vs 일반 Chromium)
```

호환 범위와 구현 방식은 [docs/compatibility.md](docs/compatibility.md)에, 일반 Chromium "computer use" 방식과 비교한 벤치마크는 [docs/benchmark.md](docs/benchmark.md)에 있습니다.

## 제약

- 사용자가 에이전트 스페이스를 직접 조작하려면 제어판에서 *Take control*을 눌러야 합니다. 사람의 입력을 감지해 제어권을 자동으로 넘기지는 않습니다.
- 위치·카메라 같은 기기 권한 프롬프트가 떠도 제어권이 자동으로 넘어가지 않습니다.
- 데스크톱 키링(v11)으로 암호화된 쿠키는 가져와도 복호화되지 않습니다. 프로필은 `--password-store=basic`을 쓰기 때문입니다.

## 라이선스

MIT. `sdk/`와 `patches/`의 대상 코드는 citrolabs/ego-lite의 MIT 코드입니다(`sdk/LICENSE`).
