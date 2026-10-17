# 업스트림 SDK 패치

`scripts/build-sdk.sh`와 `scripts/run-upstream-e2e.sh`는 citrolabs/ego-lite를 `sdk/UPSTREAM.json`에 적힌 커밋으로 체크아웃한 뒤, 이 디렉터리의 `*.patch`를 이름 순서대로 적용하고 빌드합니다.

## 0001-linux-browser-clipboard.patch

업스트림의 `page.keyboard.paste()`는 macOS(osascript)와 Windows(PowerShell) 클립보드 호스트만 지원하고, Linux에서는 오류를 냅니다. 이 패치는 Linux 분기를 추가합니다. 추가된 분기는 agentspace가 제공하는 바인딩 두 개를 사용합니다.

- `ego.beginClipboardTransaction({ text, html? })` → `{ transactionId }`
- `ego.finishClipboardTransaction(transactionId)` → `"restored" | "changed"`

데몬은 붙여넣기를 받는 브라우저 안에서 트랜잭션을 처리합니다(`lib/clipboard.mjs`).

1. 숨김 헬퍼 탭에서 이전 text/html 값을 저장합니다.
2. 붙여넣을 내용을 클립보드에 씁니다.
3. 붙여넣기가 끝나면, 그사이 다른 쓰기가 없었을 때만 이전 값을 복원합니다.

X11/Wayland 세션에서는 데스크톱 클립보드를, 헤드리스에서는 브라우저 내부 클립보드를 사용합니다. 패치에는 업스트림 단위 테스트(`clipboard.test.mjs`) 갱신도 포함되어 있습니다.

## 0002-agentspace-command-names.patch

SDK와 사용 가이드가 사람·에이전트에게 보여 주는 명령 이름을 agentspace CLI에 맞춥니다. 브라우저 API와 바인딩 계약은 바꾸지 않습니다.

| 업스트림 | 패치 후 |
| --- | --- |
| `ego-browser nodejs` | `agentspace run` |
| `ego-browser skill` | `agentspace guide` |
| `ego-browser upgrade` | `agentspace upgrade` |
| `[ego-browser:skill]`, `[ego-browser:notice]`, `[ego-browser:skill-stale]`, `[ego-browser:pages]` | `[agentspace:guide]`, `[agentspace:notice]`, `[agentspace:skill-stale]`, `[agentspace:pages]` |
| 가이드 속 "Ego Lite", "ego-browser" 제품명 | agentspace |

업스트림 단위 테스트와 real-browser E2E 케이스의 기대 문자열도 함께 바꿉니다. 패치를 적용한 업스트림 단위 테스트는 533개 모두 통과합니다.
