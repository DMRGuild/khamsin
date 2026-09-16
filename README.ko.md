# Khamsin

Cloudflare Workers와 일반 리눅스 서버에서 실행하는 문서 아카이브입니다.
운영 설정은 D1 또는 SQLite에 저장하며, 실행에 `data/` 파일이 필요하지 않습니다.
기존 KV 배포도 호환됩니다. 문서 조회·서명 검증은 브라우저에서 수행합니다.

## 여기서 시작하세요: 관리자 등록

**Node.js 22.13 이상**과 npm이 필요합니다.

```sh
npm ci
npm run setup
```

안내 화면에서 실행 환경을 선택하고 **관리자 Nostr 공개키**(`npub` 또는
64자리 hex)를 붙여넣으세요. 개인키인 `nsec`를 입력하면 안 됩니다.
관리자 권한과 접근 허용이 함께 등록되고, 로컬 쿠키 비밀키도 생성됩니다.
다시 실행해도 기존 관리자·데이터·비밀키는 덮어쓰지 않습니다. Workers 설정은
Worker 이름·공개 주소·사이트 이름과 설명·스킨·D1 연결도 안내합니다.
Enter를 누르면 제시된 기본값을 사용합니다.

Cloudflare 로컬 개발을 선택했다면:

```sh
npm run dev
```

일반 리눅스/Node.js를 선택했다면:

```sh
npm run build:node
npm start
```

http://localhost:8787 에서 NIP-07 확장 프로그램으로 로그인한 뒤 `/admin`을
여세요. 사용자·태그·관리자·커스텀 HTML을 관리할 수 있습니다. 마지막 Nostr
관리자는 제거할 수 없습니다. 관리자의 접근 권한을 제거하면 관리자 권한도
회수됩니다. 관리자 권한만 회수하면 일반 사용자 접근은 유지됩니다.

자동화할 때는 다음처럼 실행합니다.

```sh
npm run setup -- --target sqlite --admin npub1YOUR_PUBLIC_KEY
```

대상은 `local`(로컬 D1), `sqlite`(Node.js), `remote`(운영 D1)입니다.

## 개인 배포 설정

Git에는 `wrangler.toml.example` 템플릿만 포함합니다. 실제 `wrangler.toml`은
setup이 생성하며 Git에서 제외합니다. 보통의 재실행은 기존 설정을 유지합니다.
설정을 다시 바꾸려면:

```sh
npm run setup -- --target local --reconfigure
# 릴레이·업로드 옵션·도메인·선택적 기존 R2 버킷까지 설정
npm run setup -- --target local --reconfigure --advanced
```

변경 전 파일은 `backups/wrangler-*.toml`에 보관합니다. 별도로 추가한 Wrangler
설정 값은 유지하지만 TOML 주석과 서식은 다시 작성될 수 있습니다. 실행 진입점·
빌드·정적 자산·호환성 설정은 템플릿에서 자동으로 채웁니다. 고급 설정에서는
공개 앱 변수 전체를 조정할 수 있습니다. 새 설치에는 KV 바인딩을 넣지 않으며,
기존 KV가 있으면 이전을 위해 유지할지 묻습니다.

자동화나 CI에서는 옵션으로 값을 전달할 수 있습니다.

```sh
npm run setup -- --target local --defaults --configure-only \
  --name my-archive --set SITE_NAME="My Archive" --set SKIN=dark
```

`--configure-only`는 설정 파일만 만들며 로그인·리소스 생성·마이그레이션·비밀키·
관리자 등록을 수행하지 않습니다. 운영 설정만 생성하려면 공개 `--base-url`과
실제 `--database-id`도 필요합니다. `--account-id`, `--database-name`도 지원합니다.
`--set`에는 공개 앱 설정만 넣을 수 있으며 비밀키는 허용하지 않습니다.
`--defaults`는 질문을 생략합니다. 빈 DB를 초기화할 때는 `--admin`도 전달하세요.
리눅스/SQLite 설정은 기존처럼 `.env`를 사용하며 Wrangler를 만들지 않습니다.

새 체크아웃에서 `npm run build`는 필요하면 예제를 복사해 빌드만 검증합니다.
개발 서버·배포 전에는 setup을 실행하세요. Wrangler를 직접 실행할 때도 개인
`wrangler.toml`이 필요합니다. 기존 `.dev.vars`의 공개 설정은 TOML보다 우선하며
그대로 보존되므로, 재설정할 때 이 파일에 같은 변수가 있는지도 확인하세요.

## Cloudflare 배포

```sh
npm run setup -- --target remote
npm run check
npm test
npm run build
npm run deploy
```

운영 setup은 공개 HTTPS 주소(workers.dev 주소 또는 사용자 도메인)를 입력받고,
필요하면 브라우저 로그인을 실행합니다. 계정을 선택한 뒤 D1을 ID/이름으로
조회하거나 새로 생성하고, ID를 설정 파일에 자동 반영합니다. 마이그레이션과
관리자 등록도 처리합니다. 기존 `COOKIE_SECRET`이 없을 때만 무작위 비밀키를
표준 입력으로 안전하게 등록합니다. 기존 비밀키는 유지하며 권한·네트워크 오류를
비밀키가 없는 것으로 간주하지 않습니다.

이 과정에서 D1과 비밀키 보관용 초안 Worker가 생성될 수 있습니다. 앱 배포와
사용자 도메인 연결은 `npm run deploy`에서 수행합니다. 중간에 실패하면 setup을
다시 실행하세요. 이미 생성된 D1과 초기화된 관리자를 재사용합니다.
자동화 환경에서는 미리 인증하거나 Cloudflare API 토큰을 환경 변수로 제공하고,
`--defaults`, `--base-url`, `--admin`, 필요하면 `--account-id`를 전달합니다.

로컬과 운영 DB는 별개이며 `.dev.vars`는 배포되지 않습니다. 로컬 D1을 운영
설정으로 전환할 때 기존 로컬 ID를 `preview_database_id`로 유지합니다.
이후 스키마 변경 시에는 배포 전에 `npx wrangler d1 migrations apply DB --remote`를
실행하세요. setup은 최상위 배포 설정을 관리합니다. `[env.*]`로 나눈 배포는
Wrangler에서 직접 관리합니다.

도메인·workers.dev 사용 여부·선택적 기존 R2 버킷은 고급 설정에서 연결합니다.
R2 버킷 생성과 선택적 WASM 업로드는 별도입니다. Pinata를 켰다면 운영 setup이
Wrangler의 숨김 입력으로 토큰을 받습니다. 자동화에서는 `PINATA_JWT` 환경 변수로
전달할 수 있으며 기존 토큰은 유지합니다. 로컬 개발 토큰은 제외된 `.dev.vars`에
넣으세요.

## 리눅스 운영

`npm start`는 `.env`를 읽고, 이미 주어진 환경 변수를 우선합니다.
프로젝트 루트에서 실행하며 `dist/`, `public/`, 운영 의존성이 필요합니다.

- `DATABASE_PATH`: 기본 `.state/khamsin.sqlite`. 운영에서는
  `/var/lib/khamsin/khamsin.sqlite` 같은 영속 경로를 권장합니다.
  설정·가져오기·서버 실행에 같은 경로를 지정하세요.
- `BASE_URL`: 운영 HTTPS 주소.
- `COOKIE_SECRET`: 32자 이상의 무작위 비밀키.
- `HOST`, `PORT`: 기본 `127.0.0.1`, `8787`.
- `PUBLIC_DIR`: 기본 `./public`.

systemd 등으로 프로세스를 관리하고 TLS는 리버스 프록시에서 처리하면 됩니다.
Node에서는 소켓의 상대 주소만 신뢰합니다. 프록시 뒤에서는 프록시에 사용자별
요청 제한을 설정하세요. 앱의 메모리 요청 제한은 프로세스 단위입니다.
SQLite는 영속 디스크가 있는 단일 호스트용이며 네트워크 공유 디스크에 두지 않습니다.

## 선택적 파일 가져오기

```sh
# 미리보기: DB는 변경하지 않습니다.
npm run config:import -- --target sqlite --from ./data

# 실제 반영
npm run config:import -- --target sqlite --from ./data --apply
```

`admins.txt`, `allowlist.txt`, `tags.txt`, `custom/*.html`을 읽습니다.
공개키를 정규화하고 관리자에게 접근 권한도 부여합니다. 없는 파일과 빈 목록은
변경을 일으키지 않습니다. 목록은 병합하며 기존 항목을 삭제하지 않습니다.
HTML은 기본적으로 보존하며, `--overwrite-html`을 명시하면 해당 슬롯을
덮어씁니다. 이 옵션을 사용한 빈 HTML은 슬롯 내용을 비웁니다.

현재 가져오기는 병합만 지원합니다. 삭제는 관리자 화면에서 처리하세요.
동시 변경은 버전으로 검사하고, 전체 가져오기는 하나의 SQL 문으로 반영합니다.

## 기존 KV에서 이전

운영 중이라면 오래된 `data/`보다 **현재 KV 데이터**를 가져오세요.
`DB` 바인딩이 없으면 기존 KV로 동작합니다. `DB`가 있으면 D1만 사용하므로
전환 전에 데이터를 준비해야 합니다.

1. KV를 백업하고 관리자 수정·업로드를 잠시 중단합니다. 이전 수정이 전파될
   시간도 확보합니다. KV 읽기는 최종 일관성을 따릅니다.
2. 기존 `VON_KV` 바인딩이 있는 개인 `wrangler.toml`을 유지합니다.
3. `npm run setup -- --target remote`를 실행하고 KV 유지 질문에 동의합니다.
   setup이 D1을 생성하거나 연결하며 의도한 초기 관리자를 등록합니다.
4. 다음 명령으로 미리 보고 적용합니다.

   ```sh
   npm run config:import -- --target remote --from-kv
   npm run config:import -- --target remote --from-kv --apply
   ```

5. 데이터 확인 후 배포하고 로그인·관리자 화면을 확인합니다.
6. 롤백용 기존 KV를 보관하고, 검증이 끝나면 KV 바인딩을 제거합니다.

태그·사용자·관리자·HTML뿐 아니라 `pin:*` 소유권도 옮깁니다.
로컬 KV는 `--target local`로, SQLite로 옮길 때는 `--target sqlite --from-kv`로
읽습니다. 로컬 setup도 D1을 활성화하므로 기존 로컬 KV가 있다면 이전하세요.
기존 `seed:*`는 KV를 덮어쓰는 호환 명령이며 새 설치에는 필요하지 않습니다.

```sh
mkdir -p backups
npm run config:export -- --target sqlite --output backups/configuration.json
npm run config:import -- --target local --from backups/configuration.json --apply
```

`backups/`는 Git에서 제외됩니다. 내보내기 파일은 이 폴더에 보관하세요. 다른
경로에 임의로 지정한 파일명까지 자동으로 제외되지는 않으며, 이미 추적 중인
파일은 `.gitignore`를 추가해도 추적이 해제되지 않습니다.

JSON에는 운영 설정과 Pin 소유권이 포함되지만 환경 변수와 비밀키는 포함되지
않습니다. 가져오기는 병합이므로 정확한 원상 복구에는 DB 백업을 사용하세요.

## 개발 및 선택 기능

`npm run check`는 타입을, `npm test`는 SQLite·권한 라우트·로컬 D1 동작을
검증합니다. D1 테스트는 localhost 포트를 사용합니다. 두 빌드 경로 모두 Eta
템플릿과 CSS를 빌드 시 처리합니다.

압축 Pandoc이 포함되어 R2는 선택 사항입니다. Pinata를 켜려면
`ENABLE_PINATA=1`과 `PINATA_JWT`를 설정합니다. Arweave 업로드는 브라우저
지갑을 사용합니다. AT Protocol OAuth 로그인은 아직 지원하지 않습니다.
커스텀 HTML은 직접 렌더링하므로 운영자가 신뢰하는 내용만 저장하세요.

외부 CDN·릴레이·PDS·게이트웨이 통신은 유지됩니다. 원본 저장소에 최상위
라이선스가 없어 새 라이선스를 임의로 부여하지 않았습니다. 상세 설명은
[README.md](README.md)를 참고하세요.
