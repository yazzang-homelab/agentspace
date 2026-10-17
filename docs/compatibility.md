# 호환 범위와 구현 방식

agentspace는 ego-browser SDK가 기대하는 호스트 계약을 Linux에서 구현합니다. 계약의 근거는 모두 공개 자료입니다. 업스트림 레포 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)의 다음 파일들을 참고했습니다.

- `docs/native-bindings-api.md`
- `docs/native-snapshot-ref-requirement.md`
- `docs/native-sdk-lifecycle-requirement.md`
- `docs/native-javascript-dialog-requirement.md`
- `package/ego-browser`의 소스와 테스트

## CLI

| 명령 | 동작 |
| --- | --- |
| `nodejs [-e <script> \| < file \| REPL] [--sdk-path <path>]` | `globalThis.ego`와 SDK를 설치한 Node 헬퍼에서 스크립트를 실행합니다. top-level await를 지원하고, REPL은 `.cell`/`.end`/`.cancel`/`.exit`를 받습니다(입력 하나당 64 MiB). |
| `skill [--sdk-path <path>]` | SDK `index.js` 옆의 `ego-browser/SKILL.md`를 출력합니다. |
| `import list \| --browser <b> [--profile <dir>...] [--clear-existing-profiles] [--no-default]` | Chromium 계열 프로필을 새 프로필로 복사합니다. |
| `upgrade` | 설치 위치를 `git pull --ff-only`로 업데이트하고 데몬을 재시작합니다. |
| `--ego-server-name=<name>` | 이름별로 데이터·소켓을 분리한 별도 서비스를 씁니다. |
| `start`, `stop`, `status`, `open`, `panel` | agentspace 전용 수명 주기 명령입니다. |

## 바인딩 (`globalThis.ego`)

`native-bindings-api.md`의 메서드를 모두 구현했습니다.

- 인자 검증은 동기적으로 하고, 잘못된 인자에는 `EGO_INVALID_ARGUMENT` 오류를 던집니다.
- 실행 중 생긴 오류는 `{ error, error_code }` 객체로 resolve합니다. `snapshot`만 예외로, 오류 시 reject합니다.
- `onCDPMessage`와 `onSendCDPMessageError`는 함수만 받는 콜백 슬롯입니다.

Linux용 확장 바인딩이 두 개 있습니다: `beginClipboardTransaction`, `finishClipboardTransaction`. 자세한 내용은 `patches/README.md`를 보세요.

## 태스크 스페이스

- **에이전트 스페이스**
  - 새 창으로 시작합니다.
  - 이후 탭은 스페이스 안의 탭에서 `window.open`을 호출해 같은 창에 엽니다.
  - 스페이스 탭이 연 팝업 창은 같은 스페이스에 합류합니다.
- **사용자 스페이스**: 사람이 연 창은 사용자 스페이스가 되며, `claimTaskSpace`로 에이전트가 가져올 수 있습니다.
- **소유 상태**: `agent`, `agentDelegatedToUser`, `user` 세 가지입니다.
  - 위임 상태에서는 에이전트의 자동화 호출이 `EGO_TASK_SPACE_USER_IN_CONTROL`로 막힙니다.
  - 상태는 `$AGENTSPACE_HOME/spaces.json`에 저장되어 데몬을 재시작해도 유지됩니다.
- **CDP 브리지**
  - 스페이스마다 브라우저 수준 연결을 하나 두고, 여러 클라이언트의 요청 id와 세션 소유권을 분리합니다.
  - `Target.*` 이벤트와 `Target.getTargets` 결과는 스페이스 소속 타깃만 남기고 걸러냅니다.
  - `Browser.close`처럼 브라우저 전체에 영향을 주는 명령은 막습니다.
- **JS 다이얼로그**
  - 스크립트 실행이 끝나도 다이얼로그는 열린 채 에이전트 소유로 남습니다.
  - 다음 실행에서 `Page.enable`을 보내면 `Page.javascriptDialogOpening`을 다시 전달합니다.

## 스냅샷

`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`, `Page.getFrameTree`, `DOM.getFrameOwner`를 조합해 SDK가 파싱하는 텍스트 형식을 만듭니다.

- **트리 형태**
  - 문서마다 `root` 줄로 시작하고 2칸씩 들여씁니다. iframe과 OOPIF 아래에는 중첩 `root`가 옵니다.
  - 빈 텍스트와 빈 컨테이너는 제거합니다. 자식이 하나뿐인 무명 컨테이너는 그 자식으로 대체합니다.
  - 텍스트 노드는 하나당 한 줄로 출력합니다.
- **참조(ref)**
  - 조작 가능한 노드에는 `ref`를 붙입니다.
  - 렌더러가 달라 `backendNodeId`가 겹치면 다른 번호를 부여합니다.
  - 최상위 문서가 아닌 노드의 ref에는 `frameId`가 붙습니다.
- **안정 로케이터**: 하나의 노드로만 해석될 때만 붙입니다. 우선순위는 다음과 같습니다.
  1. 고유한 `id` (자동 생성된 id는 제외)
  2. 고유한 role + 이름
  3. `placeholder`
  4. `aria-label`

  링크는 고유한 href만 로케이터로 씁니다.
- **범위**
  - `only_within_viewport`는 화면 밖 노드를 제외하되, 화면 안에 보이는 자손은 남깁니다.
  - `subtree`는 `root` 노드 아래만 출력합니다.

## 검증

업스트림 `package/ego-browser/scripts/run-real-browser-e2e.mjs`는 69개 케이스로 SDK를 실제 브라우저에서 검증합니다. 이 스위트를 `EGO_BROWSER_REAL_E2E_CLI=bin/ego-browser`로 실행해(`npm run e2e`) Chromium 155에서 다음 결과를 확인했습니다.

- 헤드리스: 69/69 통과
- Xvfb 위 헤드풀: 69/69 통과
