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
다시 실행해도 기존 관리자·데이터·비밀키는 덮어쓰지 않습니다.

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

## Cloudflare 배포

1. `npx wrangler login`, `npx wrangler d1 create khamsin`을 실행합니다.
2. `wrangler.toml`의 D1 예제를 활성화하고 `DB` 바인딩의 `database_id`를
   반환된 ID로 설정합니다. 로컬 설정이 넣은 0으로 된 임시 ID는 교체해야 합니다.
   새 설치에서는 기존 `[[kv_namespaces]]` 블록을 제거합니다.
3. Worker 이름과 `BASE_URL`을 실제 HTTPS 공개 주소로 설정합니다.
4. `npm run setup -- --target remote`로 운영 관리자를 등록합니다.
5. 충분히 긴 무작위 비밀키를 생성해 `npx wrangler secret put COOKIE_SECRET`에
   입력합니다. 예: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
6. `npm run check`, `npm test`, `npm run build`, `npm run deploy`를 실행합니다.

로컬과 운영 DB는 별개이며 `.dev.vars`는 배포되지 않습니다. 초기 설정은 DB
마이그레이션도 실행합니다. 이후 스키마 변경 시에는 배포 전에
`npx wrangler d1 migrations apply DB --remote`를 실행하세요.

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
2. `VON_KV` 바인딩을 유지하면서 D1을 만들고 설정합니다.
3. `npm run setup -- --target remote`로 의도한 초기 관리자를 등록합니다.
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
npm run config:export -- --target sqlite --output configuration.json
npm run config:import -- --target local --from configuration.json --apply
```

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
