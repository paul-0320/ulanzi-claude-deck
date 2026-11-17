# ulanzi-claude-deck

Ulanzi D200X 덱으로 Claude 데스크톱 앱의 Code 탭을 다루는 Ulanzi Studio 플러그인과 기본 프로필입니다. Anthropic이나 Ulanzi가 만든 공식 도구가 아닙니다.

## 하는 일

- **세션 키 여덟 개**: 최근 Code 세션 여덟 개의 상태를 그립니다. 컨텍스트가 얼마나 찼는지, 작업 중인지, 확인이 필요한지, 권한을 기다리는지 보여 줍니다. 권한이나 질문을 기다리는 세션의 키는 깜빡입니다. 키를 누르면 그 세션을 앞으로 가져옵니다.
- **주간 사용량 키 두 개**: 이번 주 전체 사용량과 Fable 사용량, 초기화까지 남은 시간을 그립니다. Claude 앱이 이미 받아 둔 응답을 앱의 캐시에서 읽습니다. 네트워크 요청을 보내지 않고 로그인 정보도 쓰지 않습니다.
- **노브 세 개(맥만)**: Scroll Dial은 대화를 한 화면씩 스크롤합니다. Effort Dial은 지금 모델의 effort를 바꿉니다. Session Dial은 이전·다음 세션으로 넘깁니다.

확인한 환경은 Ulanzi Studio 3.4.8, Claude 데스크톱 앱 5.1231.0, macOS(arm64)입니다. Windows에서는 아직 실제 PC로 해 보지 않았습니다.

## 들어 있는 것

| 경로 | 내용 |
|---|---|
| `dials/` | Ulanzi Studio 플러그인 "Claude Dials" |
| `deckkeys.swift` | 노브가 Claude 앱에 키 입력을 보낼 때 쓰는 맥 프로그램. 설치 스크립트가 빌드합니다 |
| `install_dials.sh` | 맥 설치 스크립트 |
| `team/claude-default.ulanziDeckProfile` | 위 두 줄(세션 키 여덟 개, 사용량 키 두 개)이 든 기본 프로필 |

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

2. 주간 사용량 키에 쓰는 `zstd`를 설치합니다.

```bash
brew install zstd
```

3. Ulanzi Studio를 메뉴 막대 아이콘에서 종료합니다. 창을 닫아도 메뉴 막대에서 계속 실행됩니다. 아래 명령이 아무것도 출력하지 않으면 종료된 것입니다.

```bash
pgrep -x UlanziDeck
```

4. 플러그인을 빌드하고 설치합니다.

```bash
bash install_dials.sh
```

5. Finder나 Launchpad에서 Ulanzi Studio를 실행합니다. `open` 명령으로 켜면 노브의 키 입력이 나가지 않을 수 있습니다.
6. 노브를 쓰려면 시스템 설정의 개인정보 보호 및 보안 > 손쉬운 사용에서 Ulanzi Studio를 켭니다.
7. 아래 "기본 프로필 불러오기"를 합니다.

## Windows에서 설치하기

이 순서는 아직 실제 PC에서 해 보지 않았습니다. 폴더 위치는 짐작한 값입니다. 해 본 결과를 `dials.log`와 함께 Issue로 남겨 주세요.

1. Node를 설치하고(nodejs.org), PowerShell에서 플러그인의 의존성을 설치합니다.

```powershell
cd dials\plugin; npm install --omit=dev --no-audit --no-fund; cd ..\..
```

2. 주간 사용량 키에 쓰는 `zstd`를 설치하고, `zstd.exe`가 든 폴더를 `PATH`에 넣습니다. 아래 명령이 경로를 출력하면 됩니다. Windows에서는 필요 없을 수도 있습니다.

```powershell
where.exe zstd
```

3. Ulanzi Studio를 작업 표시줄 트레이 아이콘에서 완전히 종료합니다.
4. 플러그인 폴더를 Studio 플러그인 폴더에 복사합니다.

```powershell
$dest = "$env:APPDATA\Ulanzi\UlanziDeck\Plugins\com.ulanzi.claudeeffort.ulanziPlugin"; New-Item -ItemType Directory -Force $dest | Out-Null; Copy-Item -Recurse -Force dials\* $dest
```

5. Ulanzi Studio를 실행합니다.
6. 아래 "기본 프로필 불러오기"를 합니다.
7. 아래 "동작 확인"을 합니다. Windows에서는 노브가 아무것도 보내지 않으므로 `deckkeys unavailable, the knobs send nothing: none for this OS` 줄은 정상입니다.

## 기본 프로필 불러오기

플러그인을 설치한 뒤에 합니다.

1. Studio 화면 위쪽 프리셋 아이콘 줄의 오른쪽 끝 `+`를 누릅니다.
2. "로컬 프리셋 가져오기"를 누르고 이 폴더의 `team/claude-default.ulanziDeckProfile`을 고릅니다.
3. "프리셋 파일 저장" 창에서 이름을 그대로 두거나 바꾸고 확인을 누릅니다. 새 "Claude 기본" 프리셋이 생기고 선택됩니다. 위 두 줄에 세션 키 여덟 개와 사용량 키 두 개가 그려지는지 봅니다.
4. 셋째 줄과 노브는 Studio 오른쪽 액션 목록에서 끌어다 놓습니다. 맥에서는 "Claude" 분류의 Scroll Dial, Effort Dial, Session Dial을 노브에 놓을 수 있습니다.
5. 위 두 줄의 키는 Studio 화면에서 다시 만들 수 없으므로 지우지 않습니다. 지웠으면 이 절을 처음부터 다시 합니다.

## 동작 확인

플러그인 기록 파일 `dials.log`를 엽니다.

- 맥: `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.ulanzi.claudeeffort.ulanziPlugin/plugin/dials.log`
- Windows: `%APPDATA%\Ulanzi\UlanziDeck\Plugins\com.ulanzi.claudeeffort.ulanziPlugin\plugin\dials.log`

`connected` 줄, `slot 1:` 같은 줄, `usage all:` 같은 줄이 있으면 동작하는 것입니다. 주간 사용량 키가 `값 없음`을 보여 주거나 기록에 `no zstd decoder` 줄이 있으면 `zstd`가 설치됐는지 다시 봅니다.

## 새 버전으로 바꾸기

1. 새 코드를 받습니다.

```bash
git pull
```

2. Ulanzi Studio를 종료하고, 맥에서는 `bash install_dials.sh`를, Windows에서는 위 4단계의 복사를 다시 합니다.
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

`dials/plugin/plugin-common-node/`는 Ulanzi가 공개한 Node 라이브러리의 사본이고 Apache-2.0을 따릅니다. 같은 폴더의 `LICENSE`를 보세요.
