# 외부 접속용 웹 배포

## Windows에서 Git 복제본 운영

Git for Windows, Node.js 24와 npm, MariaDB, Google Chrome을 준비합니다. 명령 프롬프트에서 다음과 같이 복제합니다.

```bat
git clone https://github.com/ahe45/Manuscript.git
cd Manuscript
start.bat
```

1. MariaDB 서비스를 시작하고 앱이 사용할 DB 계정을 준비합니다. 운영 DB가 있다면 먼저 백업합니다.
2. `start.bat`에서 DB 포트·계정·비밀번호와 Manuscript 관리자 비밀번호(4~20자)를 입력합니다. 비밀번호를 입력하면 화면에 `*`가 표시됩니다. 이미 `.env`에 유효한 값이 있으면 해당 입력을 건너뜁니다. 웹 모드로 실행하며 앱 포트는 `4174`, DB 호스트는 `127.0.0.1`, DB 이름은 `Manuscript`가 기본값입니다. 관리자 비밀번호 해시는 자동으로 생성합니다. 이전 해시 원고가 있다면 기존 `CANDIDATE_KEY_SECRET`을 `.env`에 직접 설정합니다.
3. `start.bat`은 필요한 npm 의존성을 준비하고 DB와 테이블이 없으면 자동 생성합니다. 앱 계정으로 초기 설정을 수행할 권한이 부족하면 MariaDB 관리자 계정을 그때 한 번 입력합니다. 이 관리자 계정 정보는 저장하지 않습니다. 초기 설정이 끝나면 같은 창에서 서버를 시작합니다. 이 창의 `Ctrl+C`로 종료합니다. PDF 생성에는 서버에 설치된 Google Chrome을 사용합니다.
4. 같은 서버의 Caddy에서 운영 도메인을 설정하고 `127.0.0.1:4174`로 전달합니다. Manuscript는 Caddy가 전달한 HTTPS 요청의 호스트를 사용합니다. 특정 호스트 하나로 앱에서도 제한하려면 `.env`에 `PUBLIC_ORIGIN`을 지정할 수 있습니다. 서버 포트를 바꾼 경우 프록시 대상 포트도 맞춥니다.

   ```caddyfile
   manuscript.example.org {
       reverse_proxy 127.0.0.1:4174
   }
   ```

업데이트할 때는 먼저 서버를 종료하고 `update.bat`을 실행합니다. 현재 브랜치의 추적 브랜치에서 빨리 감기 방식으로만 가져오며, 추적 파일에 로컬 변경 사항이 있거나 서버 포트가 사용 중이면 중단합니다. 결과는 `log/update-server.log`에서 확인할 수 있습니다. 스키마 변경 안내가 나오면 DB를 백업한 뒤 `start.bat`을 실행합니다. 두 배치 파일은 `--no-pause` 옵션으로 오류나 업데이트 종료 시 대기를 생략할 수 있습니다.

## Linux에서 systemd로 운영

이 구성은 Node.js 24와 Nginx가 같은 Linux 서버에서 실행되고, 앱은 루프백에서 프록시 요청을 받는 구성을 기준으로 합니다. 설치 경로는 `/opt/manuscript`이고 서비스 계정은 `manuscript`입니다. 예시 도메인과 인증서 경로를 운영 환경에 맞춰 변경하세요.

1. 기존 MariaDB를 백업한 뒤 관리자 권한으로 `db/schema.sql`을 적용합니다. `saved_at` 추가를 포함해 반복 실행할 수 있습니다. 앱 계정에는 `editor_state`의 조회·수정, `candidate_drafts`의 조회·추가·수정 권한을 부여합니다. 기존 해시 원고가 있다면 기존 키와 레거시 테이블 조회·삭제 권한도 준비합니다.
2. 앱 디렉터리에서 `npm ci --omit=dev`를 실행합니다. PDF를 생성하려면 서비스 계정에서 실행할 수 있는 Google Chrome이 서버에 설치되어 있어야 합니다.

3. `deploy/manuscript.env.example`을 `/etc/manuscript/manuscript.env`로 복사하고 권한을 제한합니다. `PUBLIC_ORIGIN`은 브라우저에서 접속할 HTTPS 주소입니다. 운영 DB 인증 정보와 관리자 비밀번호 해시를 채웁니다.

   ```sh
   read -rs admin_password
   printf '%s' "$admin_password" | node tools/access-cli.mjs admin-hash
   unset admin_password
   ```

   명령에서 생성한 해시를 `ADMIN_PASSWORD_HASH`에 설정합니다. 수험생은 수험번호, 이름, 생년월일로 로그인합니다.

4. `manuscript.service`를 systemd에 설치하고, `manuscript.nginx.conf`의 도메인 및 TLS 설정을 적용합니다. 프록시는 `Host`를 전달하고 `X-Forwarded-For`와 `X-Forwarded-Proto`를 직접 설정합니다. 앱의 포트는 루프백에 둡니다.
5. 운영 주소 `/healthz`에서 서비스 상태를 확인하고, 별도 기기에서 수험생 로그인, 관리자 인증, 저장 후 재접속, PDF/ZIP 다운로드를 확인합니다. 수험생 로그인 화면의 **관리자**에서 배포 시 지정한 관리자 비밀번호를 입력하면 원고지 설정과 답안지 다운로드 메뉴를 열 수 있습니다.

PDF 대기열은 앱 프로세스 기준 동시 2건, 대기 8건, 대기 30초, 실행 90초입니다. 이 구성은 단일 앱 프로세스를 기준으로 하며, 재시작하면 로그인 세션은 다시 발급됩니다.

공식 참고 [Playwright의 Google Chrome 지원](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge) · [Nginx 프록시 설정](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
