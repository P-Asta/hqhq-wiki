# HQHQ Wiki

리썰 컴퍼니(Lethal Company) 하이 쿼터 커뮤니티를 위한 다국어 위키.
Next.js 16(App Router) + React 19 + TypeScript strict로 처음부터 새로 작성했습니다.

## 특징

- **SQLite 단일 파일 저장소** — better-sqlite3 + drizzle. 마이그레이션 없이 연결 시점에
  스키마가 자동 적용되고(`src/lib/db/ddl.ts`), FTS5 전문 검색(한국어 조사 접미사 매칭 포함),
  키셋 페이지네이션, 렌더 캐시까지 전부 한 파일 안에서 동작합니다.
- **자체 위키텍스트 엔진** (`src/lib/wikitext/**`) — 외부 파서 의존성 없이 직접 구현한
  미디어위키 계열 문법: 템플릿 전개, 파서 함수(`{{#if:}}`, `{{#switch:}}`, `{{#expr:}}` …),
  매직 워드, 인포박스/표/각주/목차, 리다이렉트, 카테고리, 새니타이즈. 엔진만 855개 테스트로
  검증하고, 앱 레이어까지 합치면 1,441개입니다.
- **버전 스코핑** — 게임 패치(v45 → v70 …)마다 달라지는 사실을 한 문서 안에서
  `<v50+v61>` 윈도우 태그, `{{#vswitch:}}`, `{{#ifversion:}}`으로 구간별로 기술하고, 독자는
  `?v=` 셀렉터로 원하는 버전의 문서를 읽습니다. 버전별 렌더 캐시와
  `/special/version-coverage` 리포트 포함.
- **다국어 + 접두사 없는 영어 URL** — 영어는 `/wiki/titan`, 한국어는 `/ko/wiki/titan`
  (아래 “URL 규칙”). EN 폴백 배너, 번역 최신성 추적(`/special/outdated-translations`),
  검색의 EN 유니온 폴백을 갖췄습니다.
- **URL만 열면 문서가 만들어지는 편집 흐름** — 없는 문서 주소로 들어가면 그 자리에서
  편집기가 열립니다(아래 “문서 만들기”).
- **Vercel 디자인 언어** — 라이트 기본 + 완전한 다크 모드, 디자인 토큰(CSS 변수)만 사용,
  헤어라인 보더, Geist Sans/Mono, 히어로 한정 그라디언트. 컴포넌트에 hex 하드코딩 없음.
- **무상태 인증 + 역할 권한** — Firebase Auth Bearer 토큰을 요청마다 검증합니다. 읽기는 전부
  익명 허용, 편집·관리는 언제나 로그인 필요. 역할은 High Quota HQ 본진 사이트와 같은 Firestore
  값을 공유합니다 (아래 “인증과 권한”).

## 실행법

```bash
yarn install
yarn seed                    # ./wiki-data/wiki.db 에 시드 문서 48건 생성 (재실행 안전)
yarn dev                     # http://localhost:3000
```

`.env.local` 없이도 로그인과 편집까지 그대로 동작합니다 — Firebase Admin 자격 증명은
선택이고, 넣으면 무엇이 강해지는지는 아래 “인증과 권한”에 있습니다.

시드에는 달·엔티티·장비·스크랩·메커니즘·전략 문서 36건(타이탄은 한국어 번역 포함),
인포박스 템플릿 9종, 넘겨주기 8건, 버전 스코핑 안내 문서(`Project:Version scoping`, en·ko)가
들어 있습니다. 확인되지 않은 수치에는 `{{Verify}}`가 붙어 있으니 검증 후 편집기로 지워주세요.
`yarn seed --reset`으로 처음부터 다시 만들 수 있습니다. 시드는 끝나면 렌더 캐시를 비우므로,
엔진이나 링크 규칙을 고친 뒤 다시 돌리면 모든 문서가 새 HTML로 다시 렌더됩니다.

문서의 버전 경계(`page_locales.version_boundaries`)는 **저장 시점의 파스 결과**입니다. 문서
상단 버전 선택기가 이 값을 읽으므로, 엔진의 경계 수집 규칙이 바뀌면 기존 문서는 다시 저장될
때까지 예전 목록을 계속 보여줍니다. `yarn refresh:version-boundaries`가 전체를 다시 계산하고
(기본은 dry run, `--apply`로 기록) 바뀐 문서의 렌더 캐시만 비웁니다.

## URL 규칙

**영어에는 접두사가 없고, 나머지 언어만 접두사를 붙입니다.** 한 문서에 주소는 하나뿐입니다.

| 화면 | 영어 | 한국어 |
|---|---|---|
| 홈 | `/` | `/ko` |
| 문서 | `/wiki/titan` | `/ko/wiki/titan` |
| 편집 | `/edit/titan` | `/ko/edit/titan` |
| 역사 / 비교 | `/history/titan`, `/diff/titan` | `/ko/history/titan`, … |
| 검색 | `/search?q=` | `/ko/search?q=` |
| 특수 문서 | `/special/recent-changes` | `/ko/special/recent-changes` |
| 언어 / 관리 | `/languages`, `/admin` | `/ko/languages`, `/ko/admin` |

- `/en/wiki/titan`처럼 `en` 접두사를 붙여 들어오면 **308**로 `/wiki/titan`에 보냅니다.
- 접두사가 인정되는 언어는 **UI 사전이 있는 언어뿐**입니다(현재 `en`, `ko`). 언어 등록만 하고
  `src/lib/i18n/dictionaries/`에 사전을 추가하지 않으면 `/xx/…` 주소는 열리지 않습니다.
- 브라우저 언어(`Accept-Language`)나 쿠키가 주소의 언어를 바꾸는 일은 없습니다. 접두사 없는
  주소는 언제나 영어입니다.
- 주소를 만드는 코드는 `src/lib/locale-path.ts` 한 곳뿐입니다. 문자열을 이어 붙여 언어 접두사를
  만들지 마세요. 위키텍스트 링크도 같은 규칙으로 렌더됩니다.

## 문서 만들기

**없는 문서의 주소를 여는 것이 곧 문서 만들기입니다.** `/wiki/gold-bar`처럼 아직 아무도 쓰지
않은 주소로 들어가면 “만들기” 안내 화면이 아니라 **그 제목의 편집기가 문서 자리에 바로**
열립니다. 제목은 주소에서 오고, 본문은 비어 있으며, 저장하면 문서가 생성되고 그 문서로
이동합니다. `/edit/gold-bar`도 똑같은 편집기를 엽니다.

- 빨간 링크는 `?redlink=1` 같은 것 없이 그냥 문서 주소를 가리킵니다.
- 검색 결과에 제목이 정확히 일치하는 문서가 없으면 **“Create 〈검색어〉”** 버튼이 나옵니다.
- 분류 선택기도, 템플릿 마법사도 없습니다. 새 문서는 제목과 본문뿐입니다.
- 로그인하지 않은 방문자에게는 “이 문서에는 내용이 없습니다” 안내와 로그인 링크가 대신
  보입니다.

## 분류(카테고리)

**문서의 분류는 본문에 적힌 `[[Category:X]]` 태그가 전부입니다.** 등록 절차도, 문서당 하나만
고를 수 있는 고정 분류도 없습니다.

- 한 문서가 분류 0개에 속해도, 여러 개에 속해도 됩니다. 편집기 오른쪽 레일의 분류 칩 입력이
  하는 일도 결국 본문에 `[[Category:X]]`를 넣는 것입니다.
- 홈의 분류 카드와 문서 수는 실제 분류 소속에서 바로 계산합니다.
- `/special/categories`에 모든 분류와 문서 수, 그리고 분류가 하나도 없는 문서 목록이 있습니다.
- `Category:` 문서 자체를 쓰면 그 내용이 자동 목록 위에 설명으로 보입니다. 설명 문서가 없어도
  분류는 그대로 동작합니다.

## 인증과 권한

읽기는 전부 공개지만, **편집·업로드·관리 작업은 언제나 로그인이 필요합니다.**
(미리보기 `POST /api/preview`만 로그인 없이 동작합니다.)

**서비스 계정 없이도 동작합니다.** Firebase ID 토큰은 Google이 공개한 서명 키로 검증할 수
있고 프로젝트 ID도 공개 값이라, 서버는 비밀 값 없이 요청자를 인증합니다. Firestore는 요청자
본인의 토큰으로 REST 호출하며, 이때는 보안 규칙이 그대로 적용됩니다.

### 역할

역할은 Firestore `users/{uid}.roles`에 저장되며, 같은 Firebase 프로젝트를 쓰는
[High Quota HQ](https://github.com/lengeddev/highquotahq) 사이트와 값을 공유합니다. 정의는
`src/lib/roles.ts` 한 곳에 있습니다.

| 저장값 | 표시 이름 |
|---|---|
| `admin` | Manager |
| `site-developer` | Site Developer |
| `moderator` | Community Moderator |
| `verifier` | Verifier |
| `modded-verifier` | Modded Verifier |

> 저장되는 값은 `admin`이고 화면에만 "Manager"로 보입니다. Firestore에 `Manager`라고 쓰면
> 참고 사이트의 기존 관리자들이 전부 권한을 잃으니 주의하세요.

**관리자 콘솔(`/admin`)** 은 `admin` 역할을 가졌거나 사용자 이름이 `MANAGER_USERNAMES`
(현재 `asta`)인 계정만 열 수 있습니다. 이 규칙은 화면과 `/api/admin/*` 라우트 양쪽에서
`canAccessAdminPanel`로 똑같이 적용됩니다 — 화면만 가리는 것이 아닙니다.

### Firebase Admin 자격 증명 (선택)

없어도 로그인·편집이 되지만, 넣으면 두 가지가 강해집니다:

- **세션 무효화 확인** — 없으면 로그아웃·비밀번호 변경·계정 비활성화가 토큰 만료(최대 1시간)
  전까지 서버에 반영되지 않습니다. 위키 자체의 차단(`banned` 플래그)은 매 요청 확인하므로
  영향받지 않습니다.
- **보안 규칙 우회** — 없으면 관리자 콘솔의 사용자 검색과 차단 쓰기가 Firestore 보안 규칙의
  허용 범위 안에서만 동작합니다.

```bash
cp .env.example .env.local
# .env.local 에서 아래 두 개를 채우면 위 두 가지가 켜집니다 (또는 GOOGLE_APPLICATION_CREDENTIALS 지정)
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# 관리자 부트스트랩 역할 (Firestore users/{uid}.roles 와 대조)
WIKI_ADMIN_ROLES=admin,site-developer,wiki-admin
```

`NEXT_PUBLIC_FIREBASE_*`는 브라우저용 공개 설정이고 기본값이 이미 들어 있습니다.
`FIREBASE_*`(접두사 없는 쪽)는 **절대 클라이언트에 노출하지 마세요.**

## 품질 게이트

```bash
yarn typecheck   # tsc --noEmit
yarn test        # vitest — 46 파일 / 1,441 테스트
yarn lint        # eslint --max-warnings 0
yarn build       # next build (프로덕션)
```

## 구조

```
src/lib/wikitext/   위키텍스트 엔진 (동결 — engine-status.md 참고)
src/lib/db/         스키마·저장소·쿼리 (SQLite)
src/lib/wiki/       렌더 서비스 + 읽기/편집 뷰 로더 + 엔진 설정(config.ts)
src/lib/locale-path.ts  URL 규칙의 유일한 주인 (언어 접두사)
src/lib/{auth,i18n,media,diff}.ts …  앱 레이어 라이브러리
src/middleware.ts   접두사 없는 영어 URL → /en 트리 매핑, /en → 308
src/app/[locale]/   페이지 (서버 컴포넌트, 요청마다 SQLite 조회)
src/app/api/        JSON API (통일된 오류 바디, Bearer 인증)
docs/engine/        규범 문서: decisions-v2.md · routes.md · theme.md · versioning.md · app-status.md
scripts/seed.ts     시드 스크립트
scripts/*.ts        유지보수: 버전 태그 문법 마이그레이션, 버전 경계 재계산
```

자세한 검증 결과(스모크 테스트, 알려진 공백)는 `docs/engine/app-status.md`에 있습니다.
URL·편집·분류의 규범 정의는 `docs/engine/decisions-v2.md`(O12–O14)이고, 라우트별 권한은
`docs/engine/routes.md`입니다.
