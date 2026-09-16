# Khamsin

von의 경량 serverless 버전을 분리한 독립 Cloudflare Workers 프로젝트입니다.
상위 저장소, Deno, Docker, 로컬 IPFS 서버 없이 실행합니다. 스킨 5개와
브라우저 코드, 아이콘, Gentou, 압축 Pandoc WASM이 모두 포함되어 있습니다.

## 로컬 실행

Node.js 22 이상과 npm이 필요합니다.

```sh
git clone <저장소-URL> khamsin
cd khamsin
npm ci
npm run setup
# data/admins.txt와 data/allowlist.txt 양쪽에 자신의 npub를 입력합니다.
npm run seed:local
npm run dev
```

http://localhost:8787 에 접속합니다. 로그인에는 NIP-07 지원 Nostr 서명
확장 프로그램이 필요합니다. allowlist가 비어 있으면 로그인이 비활성화됩니다.
`setup`은 기존 파일을 덮어쓰지 않으며 무작위 로컬 쿠키 비밀키를 생성합니다.
실제 운영 목록과 `.dev.vars`는 Git에서 제외됩니다. 따라서 다른 사용자가
클론하면 빈 예제로 시작하며 원래 관리자의 권한을 상속하지 않습니다.

## Cloudflare 배포

1. 위 초기 설정을 완료합니다.
2. `npx wrangler login` 후 `npx wrangler kv namespace create VON_KV`를 실행합니다.
3. 반환된 ID를 `wrangler.toml`의 KV `id`에 넣고 주석을 해제합니다.
   `name`을 정하고 `BASE_URL`을 실제 HTTPS 공개 주소로 변경합니다.
   기본 주소 형식은 `https://<Worker이름>.<계정서브도메인>.workers.dev`입니다.
   계정 서브도메인은 Cloudflare 대시보드에서 확인합니다.
4. 아래 명령으로 무작위 문자열을 생성한 후 secret 입력 창에 붙여넣습니다.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   npx wrangler secret put COOKIE_SECRET
   ```

   최초 실행 시 Worker 생성 안내가 나오면 생성합니다.
5. `npm run seed:remote`, `npm run check`, `npm run build`, `npm run deploy`를 실행합니다.

`seed:remote`는 파일이 있는 KV 키를 **덮어씁니다**. 관리자 화면에서 수정한
내용을 보존하려면 재배포 때마다 실행하지 마세요. 로컬 `.dev.vars`는 배포되지
않으며 로컬 주소를 유지합니다. 운영 도메인과 KV는 각자 설정해야 합니다.

## 운영 설정

- `data/admins.txt`: 관리자 공개키. 반드시 allowlist에도 추가합니다.
- `data/allowlist.txt`: 로그인 가능한 Nostr 공개키 및 표시할 AT Protocol 작성자.
- `data/tags.txt`: 허용 태그. 비어 있으면 제한하지 않습니다.
- `data/custom/*.html`: index, about, main-header, main-footer, sidebar-header,
  sidebar-footer HTML 슬롯. 운영자가 신뢰할 수 있는 HTML만 넣습니다.
- `wrangler.toml`: 사이트 이름·설명·스킨·릴레이 등 공개 설정.
- `/admin`: allowlist·태그 관리. KV 변경은 즉시 전 세계에 반영되지는 않습니다.

Pandoc 압축 파일이 포함되어 기본 배포에 R2는 필요 없습니다. Pinata는 기본
비활성화이며 활성화하려면 `ENABLE_PINATA="1"`과 `PINATA_JWT` secret을
설정합니다. Arweave 업로드는 브라우저 지갑을 사용합니다.

이 프로젝트는 Cloudflare Workers용입니다. 다른 serverless 환경에는 KV 및
정적 파일 등의 어댑터가 필요합니다. 외부 CDN·릴레이·PDS·게이트웨이 통신은
유지됩니다. 원본 저장소에 최상위 라이선스가 없어 새 라이선스를 임의로
부여하지 않았습니다. 상세 배포·선택적 R2·구조 설명은 [README.md](README.md)를
참고하세요.
