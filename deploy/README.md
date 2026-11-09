# 외부 접속용 웹 배포

이 구성은 Node.js 24와 Nginx가 같은 Linux 서버에서 실행되고, 앱은 루프백에서 프록시 요청을 받는 구성을 기준으로 합니다. 설치 경로는 `/opt/manuscript`이고 서비스 계정은 `manuscript`입니다. 예시 도메인과 인증서 경로를 운영 환경에 맞춰 변경하세요.

1. 기존 MariaDB를 백업한 뒤 관리자 권한으로 `db/schema.sql`을 적용합니다. `saved_at` 추가를 포함해 반복 실행할 수 있습니다. 앱 계정에는 `editor_state`의 조회·수정, `candidate_drafts`의 조회·추가·수정 권한을 부여합니다. 기존 해시 원고가 있다면 기존 키와 레거시 테이블 조회·삭제 권한도 준비합니다.
2. 앱 디렉터리에서 `npm ci --omit=dev`를 실행합니다. OS 관리자 계정으로 Chromium 시스템 의존성을 설치하고, 서비스 사용자가 읽을 수 있는 위치에 프로젝트 버전의 브라우저를 준비합니다.

   ```sh
   node node_modules/playwright-core/cli.js install-deps chromium
   PLAYWRIGHT_BROWSERS_PATH=/opt/manuscript/browser-runtime node node_modules/playwright-core/cli.js install chromium --only-shell
   ```

3. `deploy/manuscript.env.example`을 `/etc/manuscript/manuscript.env`로 복사하고 권한을 제한합니다. `PUBLIC_ORIGIN`은 브라우저에서 접속할 HTTPS 주소입니다. 운영 DB 인증 정보, 관리자 비밀번호 해시, 수험생 접속 코드 비밀키를 채웁니다.

   ```sh
   node tools/access-cli.mjs secret
   read -rs admin_password
   printf '%s' "$admin_password" | node tools/access-cli.mjs admin-hash
   unset admin_password
   ```

   첫 명령 결과는 `CANDIDATE_ACCESS_SECRET`, 마지막 해시는 `ADMIN_PASSWORD_HASH`에 설정합니다. 관리자 원문 비밀번호는 환경 파일에 넣을 필요가 없습니다. 수험생 정보가 담긴 파일을 표준 입력으로 전달해 개인별 접속 코드를 발급합니다. JSON에는 `number`, `name`, `birthDate`를 넣고 생년월일은 `YYYY-MM-DD` 형식을 사용합니다. 개인별 코드는 해당 수험생에게 전달합니다. 비밀키를 바꾸면 기존 발급 코드는 모두 재발급해야 합니다.

   ```sh
   node --env-file=/etc/manuscript/manuscript.env tools/access-cli.mjs candidate-code < candidate.json
   ```

4. `manuscript.service`를 systemd에 설치하고, `manuscript.nginx.conf`의 도메인 및 TLS 설정을 적용합니다. 프록시는 `Host`를 전달하고 `X-Forwarded-For`와 `X-Forwarded-Proto`를 직접 설정합니다. 앱의 포트는 루프백에 둡니다.
5. 운영 주소 `/healthz`에서 서비스 상태를 확인하고, 별도 기기에서 수험생 로그인, 관리자 인증, 저장 후 재접속, PDF/ZIP 다운로드를 확인합니다. 수험생 로그인 화면의 **관리자**에서 배포 시 지정한 관리자 비밀번호를 입력하면 원고지 설정과 답안지 다운로드 메뉴를 열 수 있습니다.

PDF 대기열은 앱 프로세스 기준 동시 2건, 대기 8건, 대기 30초, 실행 90초입니다. 이 구성은 단일 앱 프로세스를 기준으로 하며, 재시작하면 로그인 세션은 다시 발급됩니다.

공식 참고 [Playwright Chromium](https://playwright.dev/docs/browsers) · [Nginx 프록시 설정](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
