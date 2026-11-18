# ulanzi-claude-deck

Ulanzi D200X 덱으로 Claude 데스크톱 앱의 Code 탭을 다루는 Ulanzi Studio 플러그인과 기본 프로필입니다. Anthropic이나 Ulanzi가 만든 공식 도구가 아닙니다. Claude는 Anthropic의 상표입니다.

## 하는 일

- **세션 키 여덟 개**: 최근 Code 세션 여덟 개의 상태를 그립니다. 컨텍스트가 얼마나 찼는지, 작업 중인지, 확인이 필요한지, 권한을 기다리는지 보여 줍니다. 권한이나 질문을 기다리는 세션의 키는 깜빡입니다. 키를 누르면 그 세션을 앞으로 가져옵니다.
- **주간 사용량 키 두 개**: 이번 주 전체 사용량과 Fable 사용량, 초기화까지 남은 시간을 그립니다. Claude 앱이 이미 받아 둔 응답을 앱의 캐시에서 읽습니다. 네트워크 요청을 보내지 않고 로그인 정보도 쓰지 않습니다.
- **노브 세 개**: Scroll Dial은 대화를 한 화면씩 스크롤합니다. Effort Dial은 지금 모델의 effort를 바꿉니다. Session Dial은 이전·다음 세션으로 넘깁니다.

확인한 환경은 두 가지입니다.

- macOS(arm64), Ulanzi Studio 3.4.8, Claude 데스크톱 앱 5.1231.0
- Windows 11, Ulanzi Studio 3.4.8, Claude 데스크톱 앱 5.11492.5.0(Microsoft Store판)

세션 키와 사용량 키는 Claude 앱의 공식 문서에 없는 로컬 파일 형식을 읽습니다. 그래서 Claude 앱이 업데이트되면 두 키가 동작하지 않을 수 있습니다.

## 들어 있는 것

| 경로 | 내용 |
|---|---|
| `dials/` | Ulanzi Studio 플러그인 "Claude Dials" |
| `deckkeys.swift` | 노브가 Claude 앱에 키 입력을 보낼 때 쓰는 맥 프로그램. 설치 스크립트가 빌드합니다 |
| `deckkeys.cs` | 같은 일을 하는 Windows 프로그램. `cmd`를 Ctrl로 보냅니다. 설치 스크립트가 Windows에 들어 있는 C# 컴파일러로 빌드합니다 |
| `install_dials.sh` | 맥 설치 스크립트 |
| `install_dials.ps1` | Windows 설치 스크립트 |
| `team/claude-default.ulanziDeckProfile` | 덱의 위 두 줄(세션 키 여덟 개, 사용량 키 두 개)이 든 기본 프로필 |

## Claude에게 설치 맡기기

Claude 데스크톱 앱의 Code 탭에서 Claude에게 설치를 맡길 수 있습니다. 저장소 주소를 주고 "받아서 README대로 설치해 줘"라고 요청합니다. 순서는 아래 "맥에서 설치하기"와 "Windows에서 설치하기"를 따릅니다.

Claude는 아래 단계를 터미널 명령으로 직접 합니다.

- 저장소 받기
- Command Line Tools와 Node가 있는지 확인
- Homebrew가 있을 때 `brew install`로 Node와 `zstd` 설치
- Ulanzi Studio 종료
- `bash install_dials.sh`로 플러그인 설치
- Finder를 거쳐 Ulanzi Studio 실행
- 기본 프로필을 불러온 뒤 `dials.log` 확인

아래 단계는 사람이 해야 합니다.

- Ulanzi Studio 설치와 D200X 연결
- Command Line Tools 설치. macOS 확인 창을 눌러야 합니다.
- Homebrew가 없을 때 Homebrew 설치. 관리자 암호가 필요합니다. 플러그인은 Homebrew가 설치한 `zstd`만 찾으므로, Homebrew가 없으면 주간 사용량 키가 동작하지 않습니다.
- macOS가 Claude 앱의 Finder 제어나 Ulanzi Studio 제어를 허용할지 물으면 허용 누르기
- 시스템 설정에서 Ulanzi Studio의 손쉬운 사용 켜기. 노브를 쓸 때만 필요하고, Studio를 실행하기 전에 합니다.
- 셋째 줄 키와 노브를 Studio 화면에서 끌어다 놓기

"기본 프로필 불러오기"는 Studio 화면을 눌러서 합니다. Claude 앱에서 computer use를 켜고 Ulanzi Studio 접근을 허락하면 Claude가 직접 합니다. Studio의 프리셋 카드는 Studio 창을 앞으로 가져와야 눌립니다. computer use를 쓰지 않으면 사람이 그 절을 따라 합니다.

Windows에서는 Ulanzi Studio 종료, `install_dials.ps1` 실행, Studio 실행, `dials.log` 확인을 Claude가 합니다. 기본 프로필 불러오기와 노브 놓기는 사람이 합니다.

## 받기

```bash
git clone https://github.com/paul-0320/ulanzi-claude-deck.git
```

```bash
cd ulanzi-claude-deck
```

아래 명령은 모두 이 폴더에서 실행합니다.

## 맥에서 설치하기

1. Xcode Command Line Tools와 Node가 있는지 봅니다. 두 명령이 모두 버전을 출력하면 됩니다. 없으면 `xcode-select --install`로 Command Line Tools를, nodejs.org나 Homebrew로 Node를 설치합니다.

```bash
swiftc --version
```

```bash
npm --version
```

2. 주간 사용량 키에 쓰는 `zstd`를 Homebrew로 설치합니다. 플러그인은 Homebrew 경로(`/opt/homebrew/bin`, `/usr/local/bin`)의 `zstd`만 찾습니다.

```bash
brew install zstd
```

3. Ulanzi Studio를 종료합니다. 창을 닫아도 메뉴 막대에서 계속 실행되므로, 메뉴 막대 아이콘에서 종료하거나 아래 명령을 실행합니다. 이 명령은 `-128` 오류를 출력하지만 Studio는 종료됩니다.

```bash
osascript -e 'tell application id "ulanzi.UlanziStudio" to quit'
```

아래 명령이 아무것도 출력하지 않으면 종료된 것입니다.

```bash
pgrep -x UlanziDeck
```

4. 플러그인을 빌드하고 설치합니다.

```bash
bash install_dials.sh
```

5. 노브를 쓰려면 시스템 설정의 개인정보 보호 및 보안 > 손쉬운 사용에서 Ulanzi Studio를 켭니다. 목록에 없으면 `+`를 눌러 응용 프로그램 폴더의 Ulanzi Studio를 더합니다. 플러그인은 Studio가 시작할 때만 이 권한을 확인하므로, Studio를 실행하기 전에 켭니다.
6. `open` 명령으로 켜면 노브의 키 입력이 나가지 않을 수 있습니다. Finder나 Launchpad에서 Ulanzi Studio를 실행하거나, 아래 명령으로 Finder를 거쳐 실행합니다.

```bash
osascript -e 'tell application "Finder" to open application file id "ulanzi.UlanziStudio"'
```

7. 아래 "기본 프로필 불러오기"를 합니다.
8. 아래 "동작 확인"을 합니다.

## Windows에서 설치하기

1. Node가 있는지 봅니다. 버전을 출력하면 됩니다. 없으면 nodejs.org에서 설치합니다.

```powershell
npm --version
```

2. 주간 사용량 키에 쓰는 `zstd`를 설치하고, `zstd.exe`가 든 폴더를 사용자 `PATH`에 넣습니다. Studio에 들어 있는 Node 20에는 zstd가 없어서 이 프로그램으로 응답을 풉니다. 아래 명령이 경로를 출력하면 됩니다.

```powershell
where.exe zstd
```

3. Ulanzi Studio를 작업 표시줄 트레이 아이콘에서 완전히 종료합니다. 아래 명령이 아무것도 출력하지 않으면 종료된 것입니다.

```powershell
Get-Process UlanziDeck -ErrorAction SilentlyContinue
```

4. 키 입력 프로그램을 빌드하고 플러그인을 설치합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_dials.ps1
```

5. Ulanzi Studio를 실행합니다.
6. 아래 "기본 프로필 불러오기"를 합니다.
7. 아래 "동작 확인"을 합니다.

Effort Dial은 Ctrl+Shift+E를 보내고, Session Dial은 Ctrl+Shift+[와 Ctrl+Shift+]를 보냅니다. 다른 앱이 같은 키를 전역 단축키로 쓰면 그 앱이 키를 먼저 가져갑니다. 예를 들어 TickTick은 "메인 창 표시/숨기기"에 Ctrl+Shift+E를 씁니다. 다이얼을 돌렸을 때 다른 앱이 뜨면 그 앱의 단축키를 바꿉니다.

## 기본 프로필 불러오기

플러그인을 설치한 뒤에 합니다.

1. Studio 화면 위쪽 프리셋 아이콘 줄의 오른쪽 끝 `+`를 누릅니다.
2. "로컬 프리셋 가져오기"를 누르고 이 폴더의 `team/claude-default.ulanziDeckProfile`을 고릅니다.
3. "프리셋 파일 저장" 창에서 이름을 그대로 두거나 바꾸고 확인을 누릅니다. 새 "Claude 기본" 프리셋이 생기고 선택됩니다. 위 두 줄에 세션 키 여덟 개와 사용량 키 두 개가 그려지는지 봅니다.
4. 셋째 줄과 노브는 Studio 오른쪽 액션 목록에서 끌어다 놓습니다. "Claude" 분류의 Scroll Dial, Effort Dial, Session Dial을 노브에 놓을 수 있습니다.
5. 위 두 줄의 키는 Studio 화면에서 다시 만들 수 없으므로 지우지 않습니다. 지웠으면 이 절을 처음부터 다시 합니다.

## 동작 확인

플러그인 기록 파일 `dials.log`를 엽니다.

- 맥: `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.claudeeffort.ulanziPlugin/plugin/dials.log`
- Windows: `%APPDATA%\Ulanzi\UlanziDeck\Plugins\com.ulanzi.claudeeffort.ulanziPlugin\plugin\dials.log`

`connected` 줄, `slot 1:` 같은 줄, `usage all:` 같은 줄이 있으면 동작하는 것입니다. 주간 사용량 키가 `값 없음`을 보여 주거나 기록에 `no zstd decoder` 줄이 있으면 `zstd`가 설치됐는지 다시 봅니다. 맥에서 노브를 돌려도 아무 일이 없고 기록에 `not allowed to send keys` 줄이 있으면, 손쉬운 사용에서 Ulanzi Studio를 켠 뒤 Studio를 다시 실행합니다.

## 새 버전으로 바꾸기

1. 새 코드를 받습니다.

```bash
git pull
```

2. Ulanzi Studio를 종료하고, 맥에서는 `bash install_dials.sh`를, Windows에서는 `install_dials.ps1`을 다시 실행합니다.
3. Ulanzi Studio를 실행합니다. 키와 노브 배치는 프리셋에 남아 있으므로 프로필을 다시 불러오지 않아도 됩니다.

## 시험

코드를 고쳤다면 가짜 서버 시험을 돌립니다.

1. 플러그인의 의존성을 설치합니다. 맥에서 `install_dials.sh`를 한 번 돌렸다면 이미 설치돼 있습니다.

```bash
(cd dials/plugin && npm ci --omit=dev --no-audit --no-fund)
```

2. 시험을 돌립니다.

```bash
node --test dials/test/*.test.mjs
```

## 라이선스

이 저장소는 MIT 라이선스를 따릅니다. 최상위 `LICENSE`를 보세요. 예외는 `dials/plugin/plugin-common-node/` 하나입니다. 이 폴더는 Ulanzi가 공개한 Node 라이브러리의 사본이고 Apache-2.0을 따릅니다. 같은 폴더의 `LICENSE`를 보세요.
