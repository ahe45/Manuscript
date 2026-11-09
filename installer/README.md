# Windows 오프라인 설치본

Windows 10/11 x64 사용자별 설치입니다. Node.js와 MariaDB를 설치 EXE에 포함합니다. PDF를 생성하려면 PC에 Google Chrome이 설치되어 있어야 합니다. 시작 메뉴에서 Manuscript를 실행하면 전용 MariaDB와 웹 앱이 시작되고 기본 브라우저에서 원고지가 열립니다.

설치 화면에서 바탕화면 바로가기를 기본으로 선택합니다. 설치 EXE, 실행 EXE, 실행 관리 창의 작업표시줄과 바로가기에 원고지·연필 아이콘을 사용합니다.

## 빌드

개발 PC에 Node.js 24, npm, .NET Framework C# 컴파일러와 Inno Setup 6을 준비합니다. 첫 빌드에는 운영 의존성과 런타임을 받기 위한 인터넷 연결이 필요합니다.

```powershell
./installer/build.ps1
```

Inno Setup 위치가 다르면 `-CompilerPath`를 지정합니다. 이미 받은 공식 Node.js·MariaDB ZIP은 `-RuntimeCache`로 재사용할 수 있습니다. 런타임 ZIP은 `runtime-lock.json`의 SHA-256을 검사합니다. 결과는 `installer/output/Manuscript-<버전>-Setup.exe`에 생성됩니다.

압축 전 실행 폴더를 보관하려면 `-KeepStage`를 사용합니다. 폴더형 런타임만 필요하면 `-SkipInstaller`를 지정합니다.

## 저장과 업데이트

- 프로그램은 `%LOCALAPPDATA%\Programs\Manuscript`, 데이터는 `%LOCALAPPDATA%\Manuscript\data`에 저장합니다. 앱과 내장 DB는 설치 PC의 루프백 주소에서 동작합니다.
- 첫 실행에서 전용 DB와 비밀번호를 생성합니다. DB 초기화와 백업은 관리자 DB 계정으로, 평상시 답안 조회·저장은 제한된 앱 계정으로 수행합니다.
- 웹 포트는 4175를 우선 사용하고 충돌하면 빈 포트를 선택합니다. 전용 DB 포트는 첫 실행에서 선택한 뒤 유지합니다.
- 새 버전을 배포할 때 `package.json`과 lockfile 버전을 함께 올립니다. 런처를 종료한 뒤 설치하면 다음 실행에서 기존 DB를 백업하고 스키마를 갱신합니다. 데이터 폴더는 제거 프로그램 실행 후에도 보존합니다.
- 배포판의 MariaDB 엔진 버전이 기존 데이터와 다르면 실행을 중지합니다. 엔진 업그레이드는 별도 절차로 검증합니다.

## DB 백업과 복원

실행 관리 창의 **백업하기**를 누르면 설정과 답안을 `%LOCALAPPDATA%\Manuscript\data\backups`에 `.msbackup` 파일로 저장합니다. **백업 폴더**로 저장 위치를 열 수 있습니다.

**복원하기**에서 Manuscript 백업을 선택하면 파일 형식, DB 엔진 버전과 SHA-256을 검사합니다. 현재 데이터를 먼저 자동 백업한 뒤 검증용 임시 DB를 거쳐 답안과 설정을 교체합니다. 복원 후 원고지를 다시 열어 로그인합니다. 백업에는 수험생 정보와 답안이 들어 있으므로 접근이 제한된 위치에 보관하세요.

관리 창에서 접속 주소를 확인하고 서버를 시작하거나 종료할 수 있습니다. 서버가 중지된 상태에서도 백업과 복원을 요청할 수 있으며, **로그 보기**로 실행 로그를 엽니다.

## 설치 검증

기존 Manuscript 설치가 없는 Windows 계정에서 실행합니다. 테스트에는 OpenSSL이 필요하며, 기본 경로에서 찾을 수 없으면 `MANUSCRIPT_TEST_OPENSSL`에 실행 파일 경로를 지정합니다.

```powershell
node installer/smoke.mjs
```

테스트는 EXE를 사용자 임시 검증 폴더에 실제로 설치합니다. 기존 개발 DB와 분리된 내장 DB에서 문항 이동·로그아웃 저장, 실패 재시도, 칸 수 제한, PDF/ZIP, 재실행, 업데이트 전 백업을 확인합니다. 같은 테스트 환경의 HTTPS 프록시를 통해 외부용 인증을 검증한 뒤 설치본을 제거하고 데이터 보존을 확인합니다.

`MANUSCRIPT_TEST_SHORTCUT=1`을 설정하면 바탕화면 바로가기의 실행 대상·아이콘·작업표시줄 식별자와 설치 제거 시 바로가기 정리도 검사합니다. 동일한 이름의 기존 바로가기가 있으면 이 검사를 시작하기 전에 중단합니다.

이미 설치된 계정에서는 `-SkipInstaller`로 생성한 실행 폴더의 경로를 `MANUSCRIPT_TEST_STAGE`에 지정해 별도 테스트 DB로 실행·백업·복원을 확인할 수 있습니다.
