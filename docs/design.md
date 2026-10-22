# nyorori 설계

## 목표

PR이 **추가하거나 바꾼 코드**에만 mutation을 넣고, 그 PR 시점의 Vitest 테스트를 돌린다.
살아남은 mutant가 하나라도 있으면 CI를 실패시킨다.
살아남은 mutant는 "이 PR이 바꾼 동작을 확인하는 테스트가 없다"는 증거다.

범위:

- 대상은 JS/TS 저장소이고, 테스트 러너는 Vitest만 지원한다.
- 모든 PR에 적용한다. CLI로 만들고 GitHub Action으로 감싼다.
- 지금 다루는 것은 A(PR이 바꾼 동작이 검증되지 않은 경우)다. B(기존 테스트가 약해진 경우)는 base와 head를 비교해야 하므로 나중에 다룬다.
- mutation 점수의 임계값은 두지 않는다. diff 범위 안에서 살아남은 mutant는 0개여야 한다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| AST 처리 | `oxc-parser` npm 패키지(voidzero의 Rust 파서) 위에 TS로 구현 |
| equivalent 자동 판별 | TCE: `oxc-transform` + `oxc-minify`. 버전은 `oxc-parser`와 같게 고정 |
| 문자열 `+` 판별 | TS 파일은 `tsrs`(TypeScript 7 컴파일러의 Rust 포트)의 unstable API로 타입을 본다. optionalDependency로 버전을 정확히 고정한다. 쓸 수 없거나 답하지 못하면, 문자열인 것이 확실한 피연산자만 알아보는 문법 규칙으로 돌아간다 |
| 이 PR이 새로 추가한 억제 | `warn`: 통과시키되 경고 어노테이션과 요약 맨 위에 표시 |
| NoCoverage | Survived와 똑같이 CI 실패 |
| 실행 시간 프로파일링 | 기준 실행에만 probe를 넣은 계측을 쓴다. mutant 실행은 probe 없는 계측을 쓴다 |
| 프로파일로 살아남는 것이 확실한 mutant | 실행하지 않고 이유와 함께 Survived로 보고한다. `--no-predict`면 실행해서 예측을 검증한다 |

## 전체 흐름

```
nyorori run --base <ref>
  1. 범위 계산     git diff --unified=0 <merge-base> → 파일별 "바뀐 줄" 집합
  2. 세션 시작     Vitest를 띄운 별도 프로세스(session)를 시작한다
                  세션이 Vitest 설정으로 대상 파일을 거른다
                  (테스트 파일, coverage.exclude, --exclude 제외)
  3. mutant 생성   oxc-parser로 파싱 → 바뀐 줄에 앵커가 걸린 노드에만 mutant를 만든다
                  → 정적 equivalent 필터 (L1: 휴리스틱, TCE)
                  TS 파일의 `+`는 tsrs에 타입을 묻고, 답이 없으면 문법 규칙으로 판단한다
                  tsrs 프로세스는 이 단계에서만 떠 있다
                  → 억제 주석 읽기 (L2)
  4. 계측          모든 mutant를 파일에 한꺼번에 넣는다 (mutant schemata)
                  파일마다 두 벌을 만든다: probe 없는 계측(plain)과 probe를 넣은 계측(profiled)
                  Vite 플러그인(enforce: 'pre')이 원본 대신 계측된 코드를 돌려준다
  5. 기준 실행     원본 그대로(mutant 0)로 관련 테스트를 profiled 계측으로 실행한다
                  - 실패가 하나라도 있으면 exit 2로 중단한다 (mutant를 판정할 수 없음)
                  - 테스트 파일마다 각 mutant 지점이 몇 번 실행됐는지(hit) 기록한다
                  - probe가 지점을 지나간 값의 종류를 기록한다 (실행 시간 프로파일링)
  6. 프로파일 판정  모든 실행에서 문자열을 이어 붙인 `+`의 mutant는 건너뛴다
                  모든 실행에서 원본과 같게 동작한 mutant는 살아남는 것이 확실하다고 표시한다
  7. mutant 실행   세션이 plain 계측으로 바꾸고 계측한 파일을 무효화한다
                  mutant마다 provide(id) → 그 지점을 실행한 테스트 파일만, bail: 1로 실행
                  살아남는 것이 확실한 mutant는 실행하지 않는다 (--no-predict면 실행한다)
  8. 보고          stdout, ::error 어노테이션, $GITHUB_STEP_SUMMARY, --json
                  Survived, NoCoverage, 억제 주석 문제가 있으면 exit 1
```

Vitest 인스턴스 하나로 재변환이나 재시작 없이 mutant를 바꿔 가며 실행할 수 있다.
이것은 Vitest 5.0.5로 직접 확인했다([`spikes/vitest-runtime-switch`](../spikes/vitest-runtime-switch)).

### 계측 형태

```js
// 표현식 지점: 원본 텍스트는 그대로 두고 앞뒤에만 끼워 넣는다 (소스맵이 정확함)
(__nyorori_h(3, 4) ? (age >= 18) : globalThis.__nyorori.active === 3 ? (age > 18) : (true))
// 함수 본문
function f() { if (!__nyorori_h(5, 5)) return; ... }
```

`__nyorori_h(lo, hi)`는 해당 지점의 mutant가 모두 비활성이면 true를 돌려준다.
기준 실행에서는 hit을 센다.
같은 범위의 지점은 하나로 합친다. 예를 들어 `if (a < b)`의 Condition mutant와 ComparisonBoundary mutant는 한 지점이 된다.
겹치는 지점은 안쪽을 먼저 감싼다.

`test/instrument.test.ts`는 mutant마다 두 실행 결과가 같은지 확인한다.
- 런타임에 그 mutant를 켠 결과
- 소스에 그 변경만 직접 적용한 결과

profiled 계측은 원본 분기 안에 probe를 더 넣는다("실행 시간 프로파일링" 참고).

```js
// age >= 18 (ComparisonBoundary, Condition)
(__nyorori_h(3, 5) ? (__nyorori_v(12, __nyorori_b0(20, age , 18))) : …)
// user?.name ?? 'anon' (OptionalChaining, Logical)
(__nyorori_h(1, 1) ? ((__nyorori_h(2, 2) ? (__nyorori_v(4, __nyorori_v(8, user)?.name)) : (user.name)) ?? 'anon') : …)
// o.m?.(x)
(__nyorori_h(6, 6) ? (o.m?.(...__nyorori_e(24), x)) : (o.m(x)))
```

`test/instrument.test.ts`는 profiled 계측도 원본, plain 계측과 똑같이 동작하는지 확인한다. 피연산자를 평가하는 순서와 횟수, getter와 `valueOf`가 불리는 횟수, 선택적 호출의 `this`와 인자 개수, hit 수가 같아야 한다.

### 무한 루프 처리

무한 루프에 빠진 워커가 있으면 Vitest의 `cancelCurrentRun()`도 `close()`도 끝나지 않는다. 그래서 두 겹으로 막는다.

1. **hit 상한 (Stryker와 같은 방식).** 활성 mutant의 지점이 `기준 hit × 100 + 10000`번을 넘으면 그 지점에서 throw한다. 대부분의 무한 루프(`i++`→`i--` 등)는 루프 안에서 그 지점을 계속 지나므로 여기서 멈춘다. 이 경우 Timeout으로 판정한다.
2. **세션 프로세스 강제 종료.** 계측되지 않은 코드 안에서 도는 루프는 hit 상한에 걸리지 않는다. 예를 들어 mutant가 바꾼 값을 받아 바뀌지 않은 파일의 루프가 끝나지 않는 경우다. 이때는 실행 시간이 `기준 실행 × 2 + --timeout`을 넘으면 세션의 프로세스 그룹(테스트 워커 포함)을 SIGKILL하고, 세션을 다시 띄운 뒤 다음 mutant로 넘어간다.

### mutant 판정

| 상태 | 의미 | CI |
|---|---|---|
| Killed | 테스트가 하나 이상 실패 | 통과 |
| Timeout | hit 상한 초과, 또는 세션 강제 종료 | 통과 (killed로 취급) |
| Survived | 관련 테스트가 모두 통과. 또는 기준 실행의 프로파일로 보아 살아남는 것이 확실함(실행하지 않음, 이유를 함께 보고) | **실패** |
| NoCoverage | 기준 실행에서 이 지점을 실행한 테스트가 없음 | **실패** |
| Ignored | 소스 주석으로 억제됨 (L2) | 통과, 보고서에 표시 |

다음은 개별 mutant의 판정이 아니라 실행 전체를 exit 2로 끝낸다.
- 계측한 코드가 파싱되지 않는 경우
- 다른 플러그인이 먼저 소스를 바꿔 놓아 계측할 수 없는 경우
- 계측 플러그인이 닿지 않는 Vitest project가 있는 경우 (남은 위험의 "여러 project 설정" 참고)

NoCoverage는 테스트를 돌리지 않고 판정하므로 비용이 들지 않는다.
프로파일로 살아남는 것이 확실한 mutant도 실행하지 않는다.
TCE로 버린 mutant와, 실행 시간에 문자열 연결로 확인되어 건너뛴 `+`의 mutant는 판정 대상이 아니다. 실행하지 않고, 개수만 보고한다(L1과 "실행 시간 프로파일링" 참고).

### 범위 규칙

- 앵커는 mutant가 바꾸는 토큰의 위치다.
  - 연산자 mutant라면 연산자, 리터럴이라면 리터럴, 조건 mutant라면 조건식의 시작이다.
  - 함수 본문 mutant라면 `{`다. 그래서 시그니처 줄이 바뀐(대개 새로 만든) 함수에만 생긴다.
  - 앵커가 바뀐 줄에 있을 때만 mutant를 만든다.
- 순수 삭제는 mutant를 만들 대상이 없으므로 A의 범위 밖이다. 이것은 B에서 다룬다.
- 타입 전용 코드는 런타임에서 지워지므로 대상에서 뺀다. 타입 주석, interface, type alias, `declare`, enum이 여기에 해당한다.
- 모듈 최상위 코드는 import 시점에 한 번만 실행되므로 대상에서 뺀다. 함수 안(매개변수 기본값 포함)의 코드만 대상이다.
- 파일 기준으로 다음은 제외한다.
  - 테스트 파일: Vitest의 `matchesTestGlob`
  - Vitest `coverage.include`/`coverage.exclude`에 따라 빠지는 파일: 기본값에서 설정 파일 등
  - `--exclude`에 걸리는 파일
  - `.d.ts`
  - `node_modules`

### mutation 연산자

| 이름 | 변형 |
|---|---|
| `ComparisonBoundary` | `<`↔`<=`, `>`↔`>=` |
| `Equality` | `===`↔`!==`, `==`↔`!=` |
| `Logical` | `&&`↔`\|\|`, `a ?? b`→`a` |
| `Arithmetic` | `+`↔`-`, `*`↔`/`, `%`→`*` |
| `UnaryMinus` | `-x`→`x` |
| `Update` | `++`↔`--` |
| `BooleanLiteral` | `true`↔`false` |
| `Negation` | `!x`→`x` |
| `Condition` | `if`/삼항의 조건 → `true`, `false`. 루프 조건 → `false` (`true`는 무한 루프만 만듦) |
| `FunctionBody` | 블록 본문 → 즉시 `return`. 화살표 함수의 식 본문 → `undefined` |
| `OptionalChaining` | `a?.b`→`a.b`, `a?.[i]`→`a[i]`, `f?.()`→`f()` |

문자열 리터럴→`""`과 배열/객체 리터럴 비우기는 오탐이 많아 2차로 미룬다.

## 구현 구조

Vitest는 JS 안에서 돈다. 모듈 그래프, 플러그인 transform, 워커 재사용을 쓰려면 오케스트레이터가 Vitest와 같은 런타임에 있어야 한다.
순수 Rust 바이너리로 만들면 mutant마다 Vitest를 새로 띄워야 하고(시작에만 1~2초), 어차피 JS 플러그인도 따로 배포해야 한다.
그래서 오케스트레이션은 TS로 하고, 파싱은 voidzero의 `oxc-parser`(Rust, 플랫폼별로 미리 빌드되어 배포됨)를 쓴다.
TCE에도 같은 oxc의 `oxc-transform`과 `oxc-minify`를 쓴다.
mutant 생성은 `oxc-parser`가 주는 타입 있는 AST(`@oxc-project/types`)를 TS로 순회해서 한다.
- 자식 노드는 `oxc-parser`의 `visitorKeys`(노드 종류별 자식 키 목록)를 따라 방문한다. 타입이나 데코레이터만 담는 키(`typeAnnotation`, `typeArguments`, `decorators` 등)는 들어가지 않는다.
- 이름이 어느 스코프에서 선언됐는지는 `oxc-walker`(버전 고정)의 `ScopeTracker`로 확인한다. `oxc-walker`의 `walk`는 쓰지 않는다. 그 `walk`는 모든 키와 노드에 들어가므로, 런타임에는 없는 ambient 선언까지 선언으로 센다. 그래서 nyorori의 순회가 `ScopeTracker`를 직접 진행시킨다. 이 진입/이탈 훅은 protected라서 하위 클래스로 연다.
- 문자열 `+`의 문법 규칙은 `const`의 초기화 식에 나오는 이름을, 순회가 서 있는 곳이 아니라 그 `const`가 선언된 스코프에서 찾는다. 기록된 스코프(`scopes`)도 protected라서 이 조회(`lookup`)도 하위 클래스에 둔다. 스코프 키는 `0-1`이 `0` 안에 있는 식으로 부모의 키를 이어 붙인 것이다.

계측은 `magic-string`으로 한다.
실행 시간의 거의 전부는 테스트 실행이고, diff 범위의 AST 처리는 미미하다.
프로파일링에서 AST 단계가 병목으로 나오면 그 부분만 Rust 코어(napi-rs)로 옮긴다.

```
src/
├─ cli.ts                인자 처리, 출력, exit code
├─ git.ts                merge-base, git diff → 바뀐 줄
├─ mutate/generate.ts    oxc-parser AST 순회(visitorKeys, ScopeTracker) → 지점과 mutant, L1 휴리스틱, L2 억제 주석
├─ mutate/equivalent.ts  L1 TCE: oxc-transform + oxc-minify 결과가 원본과 같은 mutant를 버림
├─ mutate/typecheck.ts   tsrs 어댑터: `+`가 문자열 연결인지 숫자 덧셈인지 타입으로 답함
├─ mutate/infer.ts       문자열 `+`의 문법 규칙: 식이 문자열인 것이 확실한지 AST와 스코프로 답함
├─ mutate/instrument.ts  schemata 삽입, probe 삽입(profiled), 소스맵, 계측 결과 파싱 확인
├─ mutate/profile.ts     probe 기록의 형식과 판정 규칙: 살아남는 것이 확실한 mutant, 문자열 `+`
├─ run.ts                오케스트레이션: 세션 관리, 기준 실행, mutant별 실행, 판정
├─ session.ts            별도 프로세스에서 Vitest Node API 실행 (플러그인, setup 파일, provide)
├─ vitest.ts             프로젝트가 쓰는 Vitest 찾기 (Vite+ 포함)
├─ protocol.ts           CLI ↔ 세션 IPC 메시지
└─ report.ts             텍스트, GitHub 어노테이션, step summary
action.yml               composite action: npm ci 후 dist/cli.js 실행
```

- 세션은 프로젝트가 쓰는 Vitest를 찾아 import한다. 그래서 프로젝트가 고정한 버전과 설정을 그대로 쓴다.
  - 프로젝트 루트나 그 위의 `package.json`이 `vite-plus`에 의존하면, vite-plus가 의존하는 Vitest를 쓴다. `vp test`도 vite-plus의 Vitest를 먼저 찾는다. 이 Vitest는 `vite` 대신 `@voidzero-dev/vite-plus-core` 위에서 돈다.
  - pnpm에서는 vite-plus에만 의존하는 프로젝트의 루트에서 `vitest`가 보이지 않는다. 그래서 디렉터리를 직접 뒤지지 않고 Node의 모듈 해석(`createRequire`)으로 찾는다.
  - 그 밖에는 루트에서 `vitest`를 해석한다. 둘 다 없으면 exit 2로 끝낸다.
- setup 파일은 CLI가 실행마다 만드는 임시 디렉터리(`os.tmpdir()` 아래 `nyorori-*`)에 둔다.
  - setup 파일은 `'vitest'`를 import한다. Vitest의 `vitest:resolve-core` 플러그인은 bare `'vitest'`를 import하는 파일의 위치와 상관없이 실행 중인 Vitest의 dist로 해석한다. 그래서 사용자의 `node_modules`에 쓰지 않아도 된다. `pool: 'threads'`, `isolate: false`, `vmThreads`에서도 확인했다.
  - CLI는 세션을 SIGKILL하므로 세션이 스스로 지울 수 없다. 그래서 디렉터리는 CLI가 만들고 실행이 끝나면 지운다. CLI가 먼저 죽으면 세션이 IPC 연결이 끊길 때 지운다.
- `createVitest` 직후에 모든 project가 계측 플러그인을 거치는지 확인한다. 플러그인이 닿지 않는 project의 코드는 테스트가 실행하지 않는 것처럼 보이므로, 판정하기 전에 project 이름과 함께 exit 2로 멈춘다.

GitHub Action에서는 `::error file=…,line=…` 워크플로 명령을 쓴다.
그래서 토큰 권한 없이도 문제가 된 mutant가 PR diff의 해당 줄에 바로 표시된다.
merge-base를 구하려면 `actions/checkout`에 `fetch-depth: 0`이 필요하다. merge-base가 없으면 이것을 안내하고 exit 2로 끝낸다.

### 타입 정보 (tsrs)

`a.name + b.title`처럼 멤버나 반환값끼리 잇는 `+`가 문자열 연결인지는 문법만으로 알 수 없다. 그래서 TS 파일의 `+`는 `tsrs`에 타입을 묻는다(L1 참고).
`tsrs`는 TypeScript 7 컴파일러와 언어 서버를 Rust로 옮긴 것이고, TypeScript 7의 IPC API를 `tsrs/unstable/sync`로 그대로 제공한다.
동기 API라서 동기로 도는 mutant 생성 안에서 바로 물을 수 있다.

- **설치.** `optionalDependencies`에 버전을 정확히 고정한다(`0.18.0-ts7.1.0-dev.20260929`).
  - JS 패키지는 모든 플랫폼에 설치되고, 네이티브 바이너리(약 29MB, lib `.d.ts` 포함 32MB)는 `@tsrs/<플랫폼>` optional 패키지에 따로 있다.
  - 바이너리가 없는 플랫폼에서도 설치는 실패하지 않는다. `npm install --os=win32`에서는 `tsrs`만 설치되고 바이너리 패키지는 빠졌다. `--omit=optional`이면 `tsrs` 자체가 없다.
  - npm 10의 lockfile에는 libc가 기록되지 않아서, `npm ci`(Action의 설치 단계)는 Linux x64에서 glibc용과 musl용 바이너리를 모두 받는다(54MB). oxc 바인딩도 같다. 실행할 때는 맞는 쪽만 쓴다.
- **지연 로딩.** 바뀐 줄에 `+`가 있는 TS 파일(`.ts`, `.tsx`, `.mts`, `.cts`)을 처음 만났을 때에만 모듈을 읽고 프로세스를 띄운다.
  - 모듈은 ESM이지만 생성이 동기이므로 `createRequire`로 require한다(Node 22.12 이상의 `require(esm)`). 읽는 데만 75~95ms가 든다.
  - 그런 `+`가 없으면 tsrs는 읽지도 않는다.
- **프로젝트 찾기.** 파일마다 snapshot을 `openFiles: [file]`로 갱신하고 `getDefaultProjectForFile`로 프로젝트를 받는다.
  - 편집기가 파일을 열 때처럼 tsrs가 위쪽 디렉터리에서 그 파일을 포함하는 `tsconfig.json`을 찾고, `references`도 따라간다. Vite 템플릿처럼 루트 `tsconfig.json`이 `files: []`와 references만 가진 경우에도 `tsconfig.app.json`을 찾는다.
  - 한 번 읽은 프로젝트는 tsrs가 다시 쓴다. 같은 프로젝트의 두 번째 파일은 3~6ms면 열린다.
  - 어느 tsconfig에도 속하지 않는 파일은 기본 옵션의 inferred 프로젝트로 간다. 이것은 타입 정보가 없는 것으로 친다.
- **질의.** oxc-parser와 tsrs의 위치는 둘 다 UTF-16 오프셋이라 그대로 쓴다. 한글이나 BMP 밖의 문자가 앞에 있어도 맞는 것을 확인했다.
  - 피연산자 첫 토큰의 위치로 타입을 물으면 틀린다. `name.length + 1`에서는 `name`(문자열)을, `n.toFixed(1) + n`에서는 `n`(숫자)을 보게 된다.
  - 그래서 tsrs의 AST에서 `getTokenAtPosition(sourceFile, left.end)`로 `+` 토큰을 찾고, 그 부모인 `BinaryExpression` 노드 자체를 묻는다. 왼쪽 피연산자가 끝나는 곳에서 `+` 토큰의 leading trivia가 시작하기 때문이다.
  - 두 피연산자의 끝 위치가 oxc의 것과 다르면 묻지 않는다. 예를 들어 BOM이 있는 파일은 tsrs가 BOM을 빼고 읽으므로 한 칸씩 어긋나고, 문법 규칙으로 돌아간다.
  - 식 전체와 두 피연산자의 타입을 `checker.getTypeAtLocation`으로 한 번에 묻는다.
- **수명.** 생성이 끝나면 `close()`로 프로세스를 끝낸다. 그래서 Vitest가 테스트를 돌리는 동안에는 떠 있지 않다.
  - 생성 중 예외가 나도 `run()`의 `finally`가 닫는다. CLI 프로세스가 끝날 때는 tsrs가 등록한 `exit` 훅이 남은 프로세스를 죽인다.
  - 프로세스는 `unref()`되어 있어서 이벤트 루프를 붙잡지 않는다.
- **실패.** 다음 경우에는 그 뒤로 tsrs를 쓰지 않고, 프로세스를 끝내고, 문법 규칙으로 돌아간다. 이유는 보고서에 남긴다.
  - 모듈이 없다(`--omit=optional`).
  - 바이너리가 없다(지원하지 않는 플랫폼, 다른 플랫폼에서 만든 `node_modules`).
  - 바이너리를 실행할 수 없다.
  - 요청이 하나라도 실패한다. unstable API가 한 번 틀리면 그 뒤의 답도 믿지 않는다.
  - 실행할 수 없는 바이너리(EACCES 등)는 다음 tick에 child process의 `'error'` 이벤트를 낸다. 리스너가 없으면 CLI가 죽고 exit 1(발견 있음)처럼 보이게 된다. 그래서 tsrs 클라이언트 내부의 child(`client.channel.child`)에 빈 리스너를 단다. 실패는 그 뒤의 요청이 EPIPE로 알린다.
- **보고.**
  - `--json`의 `types`에 `{ backend: 'tsrs', files, untyped }` 또는 `{ backend: 'none', reason, untyped }`를 남긴다. `untyped`는 바뀐 줄에 `+`가 있는데 타입 없이 판단한 TS 파일과 그 이유다.
  - 그런 파일이 있을 때만 텍스트 출력에 한 줄을 쓴다. 문법 규칙이 가리지 못한 문자열 `+`가 왜 변형됐는지 알 수 있게 하려는 것이다.
  - `--no-types`로 끄면 tsrs를 읽지 않고, 이 줄도 쓰지 않는다.
  - step summary와 어노테이션은 바꾸지 않는다.
- **비용.** 이 저장소의 `src/mutate/generate.ts`(467줄, `+` 16개, 프로그램 파일 282개)를 기준으로 쟀다.
  - 모듈 로딩 약 75ms, 프로세스 시작과 프로젝트 열기와 첫 질의 약 85ms, 그 뒤의 `+` 하나에 약 0.7ms, 같은 프로젝트의 다른 파일 하나에 4~6ms, 종료 약 10ms였다.
  - CLI `--dry-run` 전체로는 1.09초에서 1.36초로, 실행 한 번에 0.2~0.3초가 늘었다. mutant 실행 시간에 비하면 작다.

## 실행 시간 프로파일링

기준 실행에서는 모든 지점이 원본 분기를 지난다. 그래서 원본 분기에 probe를 넣으면 테스트에서 어떤 값이 그 지점을 지나갔는지 알 수 있다.
기록된 모든 평가에서 원본과 같게 동작하는 mutant는, 켜도 테스트가 원본과 똑같이 실행된다. 그래서 실행하지 않아도 살아남는다는 것을 안다.
이런 mutant는 실행하지 않고 이유와 함께 Survived로 보고한다(`src/mutate/profile.ts`).

### 관찰되지 않음 ≠ 불가능

- 프로파일은 테스트가 한 일만 알려 준다. "어떤 테스트도 `user`를 null로 만들지 않는다"는 "`user`는 null이 될 수 없다"와 다르다.
- 그래서 프로파일로 mutant를 버리지 않는다. 살아남는다고 판정하고 CI를 실패시킨다. 테스트를 돌렸어도 결과는 같았을 것이고, 프로파일은 실행을 건너뛰고 이유를 알려 줄 뿐이다.
- 코드가 그 값을 정말 받을 수 없어서 equivalent인지는 사람이 판단한다. 그렇다면 억제 주석을 쓴다.
- 예외는 문자열 `+`다. 문자열 변형은 2차로 미뤘다(L1). 그래서 기록된 모든 평가에서 문자열을 이은 `+`는 문법으로 알아본 문자열 `+`처럼 변형하지 않는다. 이것은 판정이 아니라 범위에서 빼는 것이다. 테스트가 숫자를 넣지 않았을 뿐인 숫자 `+`라면 mutant를 놓치는 쪽으로 틀린다.

### 결정적 테스트 가정

예측은 테스트가 결정적이라고 가정한다.

- mutant를 켠 실행은 그 지점에 처음 닿을 때까지 기준 실행과 같다. 그 지점에서 mutant가 원본과 같은 값을 내고 부수 효과도 같으면, 다음에 닿을 때까지도 같다. 그러므로 테스트 전체가 같게 실행된다.
- 테스트가 시간, 난수, 실행 순서, 동시성에 따라 달라지면 mutant 실행이 기준 실행과 다른 값을 볼 수 있다. 이때 예측이 틀릴 수 있다.
- 기준 실행은 관련 테스트 파일을 모두 돌리고, mutant 실행은 그 지점을 실행한 파일만 돌린다. `isolate: false`로 파일끼리 상태를 나누면 이것도 실행을 바꿀 수 있다. hit으로 테스트를 고르는 방식이 원래 갖고 있던 가정과 같다.

### probe

probe는 원본 텍스트에만 넣는다. mutant의 대체 텍스트는 소스 문자열 그대로라서 probe가 없다. 기준 실행에서는 모든 지점이 원본 분기를 지나므로 이것으로 충분하다.

| probe | 형태 | 기록 |
|---|---|---|
| 값 | `E` → `__nyorori_v(k, E)` | E 값의 종류 |
| 이항 | `L op R` → `__nyorori_bN(k, L, R)` | 두 피연산자의 종류, 문자열 피연산자가 있었는지, 바꾼 연산자가 다른 값을 냈는지 |
| 호출 | `f?.(a)` → `f?.(...__nyorori_e(k), a)` | 호출이 일어난 횟수 |

- 값의 종류는 비트로 기록한다: undefined, null, false, true, 0, NaN, 그 밖의 수, 빈 문자열, 그 밖의 문자열, 0n, 그 밖의 BigInt, symbol, 함수, 객체. `typeof`와 원시값 비교만 쓰므로 사용자 코드가 돌지 않는다.
- 모든 probe는 평가 횟수도 센다.
- 원본과 똑같이 평가한다.
  - 값 probe는 받은 값을 그대로 돌려주는 함수 호출이다. 감싼 식은 같은 자리에서 한 번 평가된다.
  - 이항 probe는 L과 R을 인자로 받으므로 원래 순서대로 한 번씩 평가하고, 원래 연산자를 한 번 적용한다.
  - 바꾼 연산자는 두 피연산자가 원시값일 때만 계산한다. 객체면 `valueOf`/`toString`이 한 번 더 불리므로 계산하지 않고 "모름"으로 기록한다.
  - 원래 연산자가 throw하면 "다름"으로 기록하고 같은 오류를 다시 던진다. `1n / 0n`은 throw하지만 `1n * 0n`은 throw하지 않기 때문이다.
  - 연산 중에 `valueOf`가 같은 probe를 다시 부를 수 있으므로, 플래그는 마지막에 OR로 합친다.
  - 선택적 호출의 callee는 감싸지 않는다. `o.m?.()`의 callee를 함수 호출로 감싸면 `this`를 잃는다. 대신 인자 맨 앞에 빈 배열의 spread를 넣는다. 이것은 callee가 nullish가 아닐 때만 평가되고, 인자 수를 바꾸지 않는다.
  - `a?.b?.c`의 두 번째 링크는 그 객체 `a?.b`를 값 probe로 감싼다. 체인을 `?.` 앞에서 자르는 것은 안전하다. 앞부분이 멈추면 undefined가 되고, 뒤의 `?.`도 거기서 멈추기 때문이다.
- probe 함수는 파일 끝에 붙인 함수 선언이라서, 모듈 본문이 끝나기 전에 불려도 된다. 이항 probe는 파일에서 쓰는 연산자 쌍마다 따로 만들어서 연산자로 분기하지 않는다.
- 기록은 테스트 파일마다 `Float64Array` 하나에 쓴다. probe 하나가 4칸(종류, 오른쪽 피연산자의 종류, 플래그, 횟수)을 쓴다. 키는 그 probe를 읽는 첫 mutant의 id다.
- setup 파일이 `afterAll`에서 실행된 probe의 기록만 `suite.meta`로 보낸다. hit과 같은 경로다. CLI는 테스트 파일들의 기록을 합친다.

### 판정 규칙

N은 그 mutant 지점의 hit 수를 모든 테스트 파일에 대해 더한 것이다.

| mutant | 살아남는 것이 확실한 조건 | 이유 예 |
|---|---|---|
| OptionalChaining, 멤버 접근 `a?.b`, `a?.[k]` | 객체가 nullish였던 적이 없음 | ``no test makes `user` null or undefined here`` |
| OptionalChaining, 호출 `f?.()` | 호출 횟수가 N | ``no test makes `handlers.onMessage` null or undefined here`` |
| Logical `a ?? b` → `a` | `a`가 nullish였던 적이 없음 | ``no test makes `a` null or undefined here`` |
| ComparisonBoundary | 바꾼 연산자가 늘 같은 결과를 냄. 두 피연산자가 비교상 같았던 적이 없음 | ``no test has `x === lo` `` |
| Arithmetic | 바꾼 연산자가 늘 같은 값을 냄(`Object.is`). 객체 피연산자가 없음 | `` `item.fee` was always 0`` |
| Condition → `true`/`false` | 조건에 부수 효과가 없고, 평가 횟수가 N이고, 늘 그 값의 truthiness였음 | `the condition was always true in tests` |

- 기록이 없는 probe는 아무것도 정하지 않는다. 지점이 실행되지 않았으면 NoCoverage가 그대로 남는다.
- 호출 probe는 호출 횟수를 N과 비교한다. callee가 nullish였거나, 체인이 앞에서 멈췄거나, 그 전에 throw했으면 호출 횟수가 N보다 작으므로 예측하지 않는다.
- 값 probe는 체인의 앞 링크가 멈춘 평가에서도 undefined를 기록한다. 그 평가에서는 mutant도 멈추므로 사실은 같지만, 예측하지 않는 쪽으로만 틀린다.
- Arithmetic은 `-0`도 구분한다. `-0 + 0`은 `0`이고 `-0 - 0`은 `-0`이다. 이유는 오른쪽(`+`, `-`)이나 왼쪽(`*`, `/`, `%`) 피연산자가 늘 0이었으면 그렇게 쓰고, 아니면 `` `+` and `-` gave the same value in every test``라고 쓴다.
- ComparisonBoundary의 이유는 피연산자에 undefined가 있었으면 `` `<` and `<=` gave the same result in every test``로 쓴다. `undefined <= undefined`도 false라서, `===`가 참이어도 결과가 같기 때문이다.
- Condition을 기록된 값으로 바꿔 놓을 수 있으려면 조건을 평가하지 않아도 아무 일이 없어야 한다. 그래서 문법으로 보수적으로 정한다.
  - 허용: 이름, 리터럴, `this`, 키가 정해진 멤버 접근(`a.b`, `a["b"]`, `this.#x`), 단항·이항·논리·삼항 연산자, 치환식이 모두 허용되는 템플릿 리터럴, 괄호와 TS 타입 단언
  - 불허: 호출, `new`, 대입, `++`/`--`, `await`, `yield`, tagged template, `delete`, 계산된 키(`a[i]`)
  - getter, Proxy, `valueOf`/`toString`, `Symbol.hasInstance`는 여전히 코드를 실행할 수 있다. 이들이 테스트가 보는 상태를 바꾸지 않는다고 가정한다.
  - 조건이 throw한 평가(`o.a.b`에서 `o.a`가 undefined인 경우 등)는 기록되지 않는다. 고정된 값은 throw하지 않으므로, 평가 횟수가 N과 다르면 예측하지 않는다.
  - 조건 값이 `true`/`false`가 아닌 값이었으면 이유를 `always truthy`/`always falsy`로 쓴다.
- 문자열 `+`: 기록된 모든 평가에 문자열 피연산자(빈 문자열 포함)가 있었으면 `+`→`-` mutant를 실행하지 않는다. 문자열 피연산자가 없는 평가가 하나라도 있으면 그대로 실행한다. 실행되지 않은 `+`는 NoCoverage다. 생성 단계의 규칙(리터럴, tsrs, 문법 규칙)이 먼저 적용된다.

### 계측 전환

- CLI는 파일마다 plain과 profiled 계측을 함께 세션에 넘긴다.
- `run` 요청의 `profile`이 0보다 크면 세션은 profiled 계측을 내주고, 테스트 파일마다 그 크기의 probe 버퍼를 만들게 한다(`provide`). 기준 실행만 이렇게 한다.
- 계측 종류가 바뀌면 세션은 계획한 파일마다 `vitest.invalidateFile()`을 부르고 `vitest.watcher.invalidates`에 넣는다. Vite가 변환 결과를 갖고 있으므로, 다음 실행에서 플러그인이 다시 변환하게 하려는 것이다.
- Vitest 5.0.5에서 `fsModuleCache: false`로 확인했다. 기본값(forks), `pool: 'threads'`, `vmThreads`, `isolate: false`에서 모두 기준 실행은 probe가 있는 코드를, 모든 mutant 실행은 probe가 없는 코드를 받았다.
  - `test/e2e.test.ts`가 기본 설정에서 이것을 확인한다. 픽스처의 테스트가 실행마다 활성 mutant와, 모듈 함수의 소스(`String(fn)`)에 probe가 있는지를 기록한다.
  - Vitest 5.0.5는 `isolate: false`여도 실행마다 워커를 새로 띄운다. 그래서 워커 쪽 모듈 캐시는 실행 사이에 남지 않는다. `watcher.invalidates`는 워커를 다시 쓰는 경우를 위해 넣었다.
- 세션을 강제 종료하고 다시 띄우면 새 세션은 plain 계측으로 시작한다.
- 전환이 되지 않더라도 판정은 그대로다. probe는 버퍼가 없으면 기록하지 않고 원래 값을 돌려준다. 실행이 느려질 뿐이다.

### 보고

- 예측한 Survived에는 `reason`과 `predicted: true`가 붙는다. 텍스트 출력, 어노테이션, step summary(`Why` 열)는 `every test still passes with this change` 대신 이 이유를 보여 준다.
- 문자열 `+`로 건너뛴 mutant는 `--json`의 `skipped`에 이유와 함께 남는다. 텍스트와 step summary에는 `N mutants skipped: string concatenation in every observed evaluation` 한 줄만 쓴다. 어노테이션은 만들지 않고 exit code에도 영향이 없다.
- 억제 주석
  - 예측한 mutant를 억제하면 실행하지 않고 Ignored가 된다. 살아남는 것이 확실하므로 "불필요한 억제"가 아니다.
  - 이 PR이 추가한 억제가 건너뛴 `+`만 가리키면, TCE와 마찬가지로 해당 mutant가 없다는 문제로 보고된다.
- `--no-predict`는 예측한 mutant도 실행한다. 이유(`reason`)는 그대로 남는다.
  - 살아남지 않은 mutant에는 실제 판정을 `mispredicted`로 남기고, 텍스트에 `MISPREDICT` 줄을, step summary에 "Wrong predictions"를 쓴다. exit code는 바꾸지 않는다.
  - 결정적 테스트에서는 생기지 않는다. nyorori의 테스트도 이 모드로 예측을 검증한다.

### 비용

기준 실행의 wall time을 Vitest 인스턴스 하나에서 계측 종류를 번갈아 바꾸며 재고 중앙값을 냈다(측정 스크립트는 커밋하지 않았다).

| 대상 | mutant / probe | 원본 | plain | profiled |
|---|---|---|---|---|
| 이 저장소의 `src/mutate/*.ts`와 `src/report.ts` 전체, 단위 테스트 5개 | 596 / 165 | 5898ms | 5931ms | 5961ms (+0.5%) |
| 위 중 mutant 생성 위주의 테스트 3개 | 506 / 135 | 422ms | 452ms | 474ms (+4.9%) |
| 함수 7개를 30만 번 부르는 hot loop (JS) | 36 / 18 | 250ms | 390ms | 530ms (+36%) |

- hot loop에서 워커 시작 같은 고정 비용(같은 설정의 작은 테스트 파일이 약 190ms)을 빼면, probe는 계측한 코드의 실행 시간을 약 1.7배로 만든다. 보통의 테스트에서는 차이가 작다.
- mutant 실행은 plain 계측을 쓰므로 probe 비용이 없다. 예측한 mutant는 실행하지 않으므로 그만큼 빨라진다.
- 계측을 두 벌 만들고 파싱 확인도 두 번 한다. 계측을 바꿀 때 계획한 파일을 한 번 더 변환한다.

## Equivalent mutant

### 전제

1. **살아남았다고 equivalent인 것은 아니다.** `age >= 18 → age > 18`은 살아남지만, equivalent가 아니라 경계값 테스트가 빠진 것이다. 실제로 살아남는 mutant 대부분은 이런 경우일 것이다.
2. **억제 수단은 PR을 만든 에이전트도 쓴다.** CI를 통과시키려는 에이전트에게 쉬운 억제 수단은 우회로가 된다. 그러므로 억제는 **눈에 띄고, 이유가 있어야 하고, 범위가 좁아야** 한다.
3. 그 대신 리뷰어가 할 일은 크게 줄어든다. "이 테스트가 바뀐 동작을 정말 확인하는가?"를 판단하던 일이 "이 한 줄짜리 억제 주석의 이유가 맞는가?"를 판단하는 일로 바뀐다.

### L1. 생성 단계에서 거르기 (자동)

보수적으로, 확실한 것만 거른다. 두 단계로 거른다.

**휴리스틱.** mutant를 만들 때 적용한다.

- 전역 `console`의 `console.*` 호출이면 인자 안쪽은 건너뛴다.
  - 둘러싼 스코프 어디에서든 `console`을 선언했으면 그것은 코드 자신의 객체이므로 건너뛰지 않는다. 매개변수, 지역 변수, `catch` 매개변수, `import console from './logger'` 등이 그렇다.
  - `ScopeTracker`는 순회가 선언에 닿을 때 이름을 기록한다. 그래서 AST를 한 번 돌며 선언을 먼저 모으고, 두 번째 순회에서 mutant를 만든다. 이렇게 해야 쓰는 곳보다 아래에 있는 선언도 보인다. 호이스팅되는 `var`와 함수, 파일 아래쪽에서 정의한 모듈 상수가 그런 예다.
  - `declare const console: …` 같은 ambient 선언은 런타임에 아무것도 만들지 않으므로 선언으로 치지 않는다. 그 `console`은 여전히 전역이다. `import type`도 마찬가지다.
  - 이름으로만 판단하므로, sloppy mode 스크립트에서 블록 안의 함수 선언이 바깥으로 호이스팅되는 경우(Annex B)는 보지 못한다. 이때는 전역으로 보고 건너뛰므로 mutant를 놓치는 쪽으로만 틀린다.
- `!!x`에서는 바깥 `!`만 변형한다. 안쪽을 빼도 결과가 같은 `!x`이기 때문이다.
- `x.length >= 0` 같은 항상 참인 조건은 `true`로 바꾸지 않는다.
- 조건이 이미 `true`/`false` 리터럴이면 Condition mutant를 만들지 않는다. BooleanLiteral mutant와 겹치기 때문이다.
- `x * 1`, `x / 1`은 `*`↔`/` 변형을 만들지 않는다.
- 문자열 연결 `+`는 변형하지 않는다. 문자열 변형은 2차로 미뤘다. 바뀐 줄의 `+`는 다음 순서로 판단한다.
  1. 피연산자 하나가 문자열 리터럴이나 템플릿 리터럴이면 문자열 연결이다(`"a" + x`). 타입 검사기도 달리 답할 수 없으므로 tsrs를 띄우지 않는다.
  2. TS 파일이면 tsrs에 타입을 묻는다("타입 정보 (tsrs)" 참고). 답이 있으면 그것을 따른다.
     - 식 전체의 타입이 문자열 계열이면 변형하지 않는다. 체커가 정한 결과라서 문자열 변수, 템플릿 리터럴 타입, 문자열 enum, `string`으로 제한된 타입 매개변수, branded string이 모두 들어간다.
     - 식 전체의 타입이 `number`나 `bigint`이면 변형한다. 숫자 리터럴 타입과 숫자 enum이 여기에 든다.
     - 타입 오류 때문에 식 전체가 `any`인데 피연산자 하나가 문자열을 포함하는 union이면(`string | undefined` + 숫자) 문자열 연결로 본다.
  3. tsrs가 답하지 못하면 문법 규칙(아래)으로 판단한다. `any`, 타입 오류, tsconfig에 속하지 않는 파일, tsrs를 쓸 수 없는 경우, `--no-types`, JS 파일이 그렇다. 피연산자 하나가 문자열인 것이 확실할 때만 문자열 연결로 보고, 그 밖의 `+`는 변형한다.
  - 생성 단계에서 남은 `+`는 기준 실행에서 한 번 더 거른다. 실행된 모든 평가에서 피연산자 하나가 문자열이었으면 그 mutant는 실행하지 않는다("실행 시간 프로파일링" 참고). JS와 TS 모두 해당한다.
  - tsrs가 틀리면 다음 둘 중 하나가 된다.
    - 숫자 `+`를 문자열로 보면 mutant를 놓친다.
    - 문자열 `+`를 숫자로 보면 변형된다. 리터럴이 붙지 않은 `+`에서는 tsrs의 답이 문법 규칙보다 먼저다.

**문자열 `+`의 문법 규칙.** `src/mutate/infer.ts`가 파일 하나의 AST와 스코프만 보고, 식이 늘 문자열로 평가되는지(아니면 throw하는지) 정한다. 문자열이라고 잘못 답하면 숫자 `+`의 mutant를 놓치므로, 확실한 경우에만 문자열이라고 답한다.

- 문자열로 보는 식
  - 문자열 리터럴, 템플릿 리터럴, `typeof x`
  - 피연산자 하나가 문자열인 `+`. 그래서 `"a" + b + c`의 바깥 `+`도 문자열 연결이다. 리터럴만 보던 규칙은 이것을 변형했다.
  - 두 갈래가 모두 문자열인 `c ? a : b`, `a || b`, `a && b`, `a ?? b`. 값은 둘 중 하나다.
  - 괄호, `x!`, `satisfies`, 타입 단언으로 감싼 문자열. 값은 그대로다.
  - 전역 `String(x)`, `encodeURIComponent`, `encodeURI`, `decodeURIComponent`, `decodeURI`, `escape`, `unescape`, 그리고 `String.fromCharCode`, `String.fromCodePoint`, `String.raw`
    - 둘러싼 스코프에서 같은 이름을 선언했으면 전역이 아니므로 제외한다. 매개변수, import, 아래쪽의 함수 선언이 그런 예다. console 필터와 같은 `ScopeTracker`로 본다.
  - 문자열에 부른 문자열 메서드: `trim`, `slice`, `toUpperCase`, `padStart`, `replace` 등. `at`(범위 밖이면 undefined)과 `match`(null)는 뺀다.
  - 배열에 부른 `join()`과 `toString()`. 배열로 보는 것은 다음과 같다.
    - 배열 리터럴, `Object.keys`/`values`/`entries`, `Array.from`/`of`, 문자열의 `split()`
    - 배열의 `map`, `filter`, `slice`, `concat`, `flat`, `flatMap`, `sort`, `reverse`, `toSorted`, `toReversed`
  - 위의 식으로 초기화한 `const`
    - 초기화 식 안의 이름은 `const`가 쓰인 곳이 아니라 선언된 곳의 스코프에서 찾는다. 모듈 최상위의 `const s = name`은 함수 매개변수 `name`이 아니라 전역 `name`이다.
    - 서로를 가리키는 `const`는 문자열로 보지 않는다.
  - 타입 주석이 문자열 타입인 매개변수와 변수
    - `string`, 문자열 리터럴 타입, 템플릿 리터럴 타입, 이들의 union, `string & Brand`. 배열 타입과 튜플 타입의 주석은 배열로 본다.
    - TypeScript가 호출과 대입마다 주석을 검사하므로, 다시 대입되는 `let`이어도 된다.
- 문자열로 보지 않는 것
  - `x?: string`, `string | undefined`, `any`, 구조 분해한 매개변수
  - `let`/`var`의 초기화 식. 다시 대입될 수 있다.
  - 받는 쪽을 모르는 메서드: `o.toString()`, `o.join()`, `n.toFixed()`. 어떤 객체든 같은 이름의 메서드를 가질 수 있다.
  - 함수 반환값, 객체 멤버(`url.pathname`), optional chain, `JSON.stringify(x)`(undefined를 돌려줄 수 있음)
  - `x as string` 자체. 주석과 달리 검사되지 않고, `string | number`를 그대로 좁힌다.
  - JSDoc. 검사되지 않는 주석이다.
- 가정
  - 내장 객체를 덮어쓰지 않는다(TCE의 "minifier의 가정"과 같다). 사용자 객체의 `Symbol.replace`/`Symbol.split`은 TypeScript lib 타입대로 문자열/배열을 돌려준다고 본다.
  - 타입 주석을 믿는다. `any`로 바꾼 값이나 `strictNullChecks: false`에서의 null처럼 주석과 다른 값이 들어올 수 있다. 그래도 주석이 문자열이라고 밝힌 `+`이고, tsrs도 같게 답한다.
  - console 필터처럼, sloppy mode에서 블록 안 함수 선언이 바깥으로 호이스팅되는 경우(Annex B)는 보지 못한다.
  - 어느 경우든 틀리는 방향은 mutant를 놓치는 쪽이다.

**측정.** 공개 저장소 5곳의 모든 `+`를 TypeScript 7.1이 정한 타입과 비교했다. JS 저장소에서는 TypeScript가 JSDoc과 초기화 식으로 추론한 타입이다. 문법 규칙이 문자열이라고 답한 `+` 중 TypeScript가 숫자나 "모름"이라고 답한 것은 없었다. `strictNullChecks`를 켠 TypeScript 6의 답과 비교해도 같았다.

| 저장소 | TypeScript가 문자열이라고 답한 `+` | 리터럴 규칙이 찾은 것 | 문법 규칙이 찾은 것 |
|---|---|---|---|
| hono (TS) | 47 | 33 (70%) | 41 (87%) |
| express | 34 | 26 (76%) | 34 (100%) |
| axios | 160 | 111 (69%) | 156 (98%) |
| undici | 25 | 15 (60%) | 19 (76%) |
| fastify | 77 | 59 (77%) | 77 (100%) |

- 늘어난 것은 대부분 `"a" + b + c`의 바깥 `+`이고, 그다음이 `const`와 타입 주석이다.
- 놓친 것은 멤버(`url.pathname + url.search`), 함수 반환값, 구조 분해한 값, JSDoc에서 타입이 오는 `+`다.
- 추론은 생성 단계의 두 번째 순회 안에서, 바뀐 줄의 `+`에만 한다. 위 저장소의 644개 파일에 있는 `+`를 모두 물었을 때 합쳐서 15ms 미만이 들었다. 파싱과 순회(1.3초)는 원래 하던 일이다.

TCE가 잡지 못하는 경우가 있어서 휴리스틱도 그대로 둔다. 예를 들어 `x * 1`은 압축해도 `x*1`로 남는다.

**TCE(Trivial Compiler Equivalence).** id를 매기기 전에 원본과 각 mutant를 같은 방식으로 압축한다. 결과가 글자 그대로 같으면 그 mutant를 버린다(`src/mutate/equivalent.ts`).

1. mutant 하나를 적용한 파일 전체를 만든다.
   - 표현식 지점에는 대체 텍스트를 괄호로 감싸 넣는다. 계측 코드와 같은 연산자 우선순위가 되게 하려는 것이다.
   - 줄 맨 앞의 지점에는 괄호 없이 넣는다. 앞줄에 세미콜론이 없으면 `(`가 앞줄과 이어져 호출이 되기 때문이다.
   - 함수 본문 지점은 `{` 바로 뒤에 ` return;`을 넣는다.
2. TS/TSX/MTS/CTS/JSX 파일은 먼저 `oxc-transform`(`transformSync`)으로 타입과 JSX를 걷어낸다.
3. `oxc-minify`(`minifySync`)로 압축한다. 옵션은 `module: true`(`.cjs`/`.cts`는 `false`), `mangle: false`, `compress: { target: 'esnext' }`이다.
4. 원본의 압축 결과는 파일마다 한 번만 만든다.

이렇게 걸러지는 것의 예는 다음과 같다.

- 죽은 분기 안의 mutant: `if (false) { i++ }`의 `++`→`--`
- 모듈 최상위 상수 플래그 뒤의 mutant: `const DEBUG = false`일 때 `if (DEBUG)`의 `→ false`와 그 안의 mutant
- `return` 뒤의 mutant
- 항상 참인 조건의 일부 mutant: `1 > 0`의 `→ true`와 `>`→`>=`

**오류가 나면 버리지 않는다.**

- `minifySync`는 TypeScript를 받으면 throw하지 않고 빈 `code`와 `errors`를 돌려준다. 두 결과를 그대로 비교하면 모든 TS mutant가 같다고 나와서 도구가 조용히 꺼진다.
- 그래서 원본이나 mutant 쪽에서 다음 중 하나라도 일어나면 그 mutant는 남긴다.
  - transform이나 minify가 오류를 보고한다.
  - 빈 결과를 낸다.
  - 예외를 던진다.
- 원본의 압축 결과가 비면 그 파일에서는 TCE를 하지 않는다. export하지 않은 함수만 있는 파일이 그런 경우다.

**보고.**

- 버린 mutant는 id를 받지 않고 계측되지도 않는다. mutant가 모두 버려진 지점은 사라지고, 남은 지점의 id는 여전히 연속이다.
- 텍스트 출력과 step summary에는 "N mutants dropped as equivalent (TCE)" 한 줄만 표시한다.
- `--json`에는 `equivalent` 배열로 위치, 연산자, 변경 내용을 남긴다.
- 어노테이션은 만들지 않고, exit code에도 영향이 없다.
- 이 PR이 추가한 억제 주석이 TCE로 버려진 mutant만 가리키면, 해당 mutant가 없다는 문제로 보고된다.

**minifier의 가정.** oxc minifier는 [`crates/oxc_minifier/docs/ASSUMPTIONS.md`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_minifier/docs/ASSUMPTIONS.md)에 적힌 가정을 전제로 코드를 바꾼다.
코드가 이 가정을 깨면, 테스트가 잡을 수 있는 mutant를 TCE가 버릴 수 있다. 주요 가정은 다음과 같다.

- `Function.prototype.toString()`의 결과에 기대지 않는다. 죽은 코드 안의 mutant도 함수의 소스 텍스트는 바꾸므로, `fn.toString()`을 스냅샷하는 테스트는 그 mutant를 잡을 수 있다.
- 내장 객체를 덮어쓰지 않는다(monkey-patching 없음).
- `toString`/`valueOf`/`Symbol.toPrimitive`에 부수 효과가 없다.
- `Math.*`, `parseInt` 같은 순수 전역 함수는 Symbol 인자로 throw하지 않는다. 그래서 결과를 쓰지 않는 `Math.abs(x - 1)`은 통째로 지워지고, 그 안의 mutant도 버려진다.
- TDZ 위반이 없다.
- `with`와 `document.all`을 쓰지 않는다.
- direct `eval`에서 선언한 변수를 밖에서 읽지 않는다.
- 알려진 전역(`Math`, `console` 등)은 접근해도 부수 효과가 없다.
- 쓰이지 않는 지역 객체의 속성에 값을 쓰는 것에는 부수 효과가 없다.
- 함수와 클래스의 `name`에 기대지 않는다.
- `/* @__PURE__ */`가 붙은 호출에는 부수 효과가 없다. 이 주석은 기본값대로 존중한다.

어느 경우든 틀리는 방향은 **mutant를 놓치는 쪽**이다. 즉, 테스트할 수 있는 변경을 검사하지 않을 뿐이다.
버린 mutant는 실행하지 않으므로, CI를 거짓으로 실패시키는 일은 없다.
minifier 자체의 버그(아직 alpha)가 있어도 같은 방향으로만 틀린다.

**비용.** mutant마다 파일 전체를 변환하고 압축하므로, 파일이 클수록 mutant 하나당 비용도 커진다.
250~400줄 파일에서 mutant 76~88개에 45~125ms가 더 들었다. mutant 하나에 0.5~1.5ms로, 테스트를 한 번 실행하는 비용에 비하면 작다.

### L2. 소스 주석 억제

```ts
// nyorori-ignore-next-line ComparisonBoundary -- 18세 경계는 상위 validator가 이미 막음
return age >= 18
```

- **연산자를 반드시 지정한다.** 줄 전체를 억제하는 방식은 없다.
- **이유를 반드시 쓴다.** 형식이 틀리거나 이유가 없거나, 알 수 없는 연산자를 쓰면 문제로 보고하고 exit 1로 끝낸다.
- 억제된 mutant도 실행한다. 테스트가 이미 잡는 mutant를 억제한 주석은 "불필요한 억제"로 보고하고 실패시킨다.
- 이 PR이 추가한 억제 주석이 아무 mutant에도 해당하지 않으면 실패시킨다. 그래야 낡은 주석이 쌓이지 않는다.

### L3. 이 PR이 새로 추가한 억제 → `warn`

| 정책 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **`warn` (채택)** | 통과. 경고 어노테이션과 요약 맨 위에 "이 PR이 억제 N개 추가"를 표시 | 마찰이 없음 | 리뷰어가 놓치면 그대로 통과 |
| `fail` | 새 억제가 있으면 실패. 사람이 `nyorori/ack` 라벨을 달면 통과 | 사람의 확인을 강제 | 에이전트에게 라벨 권한이 있으면 무력화됨. 라벨 이벤트로 워크플로를 다시 돌려야 함 |
| `review` | 새 억제마다 PR 리뷰 코멘트를 달고, 체크는 통과 | 판단할 지점이 코드 줄에 붙음 | `pull-requests: write` 권한이 필요 |

1차의 목표는 "살아남은 mutant가 조용히 지나가지 않게" 하는 것이다.
억제는 diff와 요약에 모두 드러나므로, 조용히 지나가지는 않는다.

### 하지 않을 것

- **저장소의 별도 허용 목록 파일(`.nyorori/equivalent.json` 등)은 두지 않는다.** 코드가 바뀌면 키가 어긋나고, 억제가 코드에서 멀어져 리뷰에 드러나지 않는다.
- **mutation 점수 임계값은 두지 않는다.** 80% 같은 기준이 있으면 그 아래에서 살아남은 mutant가 묻힌다.

## 남은 위험

- **Vitest API 의존.**
  - 쓰는 API: `related` + `getRelevantTestSpecifications()`, `project.provide()`, `project.createSpecification()`, `TestModule.meta()`, 리포터의 `onTestRunEnd`, 계측 전환의 `invalidateFile()`과 `watcher.invalidates`
  - `runTestSpecifications()`의 반환값에는 이 인스턴스가 지금까지 실행한 모든 모듈이 들어 있다. 앞선 mutant에서 실패한 파일이 뒤 mutant의 결과에 섞이므로, 결과는 `onTestRunEnd`로 받는다.
  - Vitest 5의 디스크 transform 캐시(`fsModuleCache`)는 소스 내용만으로 키를 만든다. 다른 실행이 다른 mutant id로 계측한 코드를 재사용하게 되므로 끈다. 실행마다 1초 정도 느려진다. 계획 해시를 캐시 키에 넣으면(`defineCacheKeyGenerator`) 되살릴 수 있다.
  - setup 파일의 `afterAll(({}, suite) => …)` 형태는 Vitest 5에서 바뀐 것이다.
  - setup 파일을 `node_modules` 밖에 두는 것은 `vitest:resolve-core`가 bare `'vitest'`를 실행 중인 Vitest로 해석하는 동작에 기댄다.
  - 지원하지 않는 설정은 `project.vite.config.plugins`와 `project.config.experimental.viteModuleRunner`로 알아낸다.
  - 지원 범위를 Vitest 5.x로 고정한다.
- **여러 project 설정.**
  - 계측 플러그인은 `createVitest`로 루트 Vite 서버에만 넘긴다. setup 파일은 모든 project에 추가한다.
  - Vitest 5에서 `test` 옵션만 바꾸는 inline project는 루트 Vite 서버를 같이 쓴다. 그래서 계측되고, 지원한다.
  - 다음 project는 Vitest가 Vite 서버를 따로 만든다.
    - Vite 옵션(`plugins`, `resolve` 등)을 직접 정한 inline project
    - Vite 설정에 영향을 주는 `test` 옵션(`alias`, `css`, `mode`, `root` 등)을 정한 inline project
    - `extends: false`이거나 `extends`로 선언한 설정이 아닌 다른 설정 파일을 가리키는 inline project
    - 설정 파일이나 디렉터리로 정한 project
  - Vitest는 이런 서버에 루트의 `plugins`를 넘기지 않는다(`inheritRootViteOverrides`). 그래서 계측되지 않고, 이 project의 테스트만 실행하는 코드는 모두 NoCoverage가 되어 CI를 거짓으로 실패시킨다. 이런 project가 있으면 시작할 때 project 이름과 함께 exit 2로 멈춘다.
  - 이런 project에 플러그인을 넣는 공식 방법은 Vitest 5.0.5에 없다.
    - Node API로 넘긴 `plugins`는 루트 서버에만 들어간다.
    - `configureVitest` 훅은 이미 그 project 설정에 있는 플러그인에서만 불린다.
    - 사용자 설정을 감싸 project마다 플러그인을 넣는 방법은 설정 형태가 다양해서 깨지기 쉽다.
  - project마다 설정 파일이 있는 monorepo는 `--root`로 그 디렉터리를 가리키면 그 설정이 루트 설정이 되므로 돌릴 수 있다.
- **`experimental.viteModuleRunner: false`.** Vite transform을 거치지 않고 Node가 직접 import하므로 계측되지 않는다. 같은 이유로 시작할 때 exit 2로 멈춘다.
- **Vitest의 임시 디렉터리.** 실행이 정상적으로 끝나면 CLI가 세션에 `vitest.close()`를 요청하므로, Vitest가 `os.tmpdir()`에 만드는 임시 디렉터리도 지워진다(5초 안에 답이 없으면 SIGKILL). 무한 루프 때문에 강제 종료한 세션의 임시 디렉터리는 남는다.
- **스냅샷 테스트.** `update: false`로 실행하므로, mutant가 스냅샷을 바꾸면 killed가 된다.
- **flaky 테스트.** 실행한 mutant는 우연히 killed로 판정되는 방향이라서 판정이 느슨해질 뿐, 거짓 실패는 만들지 않는다. 기준 실행이 실패하면 전체를 중단한다. 프로파일 예측은 다르다(아래 "프로파일 예측" 참고).
- **tsrs 의존.**
  - API가 unstable이다. 같은 TypeScript 7 API라도 typescript@7.0.2와 메서드 이름이 다르다. tsrs는 `createSnapshot`/`getConfiguredProject`, 7.0.2는 `updateSnapshot`/`getProject`다.
  - 그래서 버전을 정확히 고정하고, 올릴 때는 `test/typecheck.test.ts`로 확인한다. 쓰는 것은 다음과 같다.
    - `tsrs/unstable/sync`: `API`, `createSnapshot`, `Snapshot.update({ openFiles })`, `getDefaultProjectForFile`, `Project.configFileName`, `program.getSourceFile`, `checker.getTypeAtLocation`, `Type.flags`/`isUnionType`/`getTypes`, `TypeFlags`
    - `tsrs/unstable/ast`: `getTokenAtPosition`, `isBinaryExpression`, `SyntaxKind`
    - 공개되지 않은 클라이언트 내부 필드 `client.channel.child`. 구조가 바뀌면 이 보호만 조용히 빠진다.
  - 버전 이름(`0.18.0-ts7.1.0-dev.20260929`)대로 TypeScript 7.1 개발판을 따라가는 0.x 버전이다.
  - 바이너리는 macOS arm64와 Linux x64/arm64(glibc, musl)용만 있다. Windows와 Intel macOS에서는 설치는 되지만 타입 정보 없이 돈다.
  - 통신이 동기라서, tsrs가 답하지 않고 멈추면 CLI도 멈춘다. 시간 제한을 걸 수 없다.
  - 프로젝트를 여는 비용은 프로그램 크기에 비례한다. 큰 monorepo에서는 references를 따라 여러 프로젝트를 읽을 수 있다.
- **프로파일 예측.**
  - 결정적이지 않은 테스트에서는 예측이 틀릴 수 있다. 이때는 테스트가 잡을 mutant를 Survived로 보고하므로 CI를 거짓으로 실패시킨다. 원래의 flaky 테스트 위험과 방향이 반대다. `--no-predict`로 돌리면 확인할 수 있다.
  - Condition 예측의 부수 효과 판정은 문법만 본다. getter나 Proxy가 상태를 바꾸면 틀릴 수 있다.
  - 실행 시간의 문자열 `+` 규칙은 테스트가 문자열만 넣은 숫자 `+`의 mutant를 놓친다.
  - probe 함수 이름(`__nyorori_v`, `__nyorori_b0` 등)이 사용자 코드와 겹치지 않는다고 가정한다. `__nyorori_h`와 같다.
  - 호출 probe의 spread는 `Array.prototype[Symbol.iterator]`를 부른다. 이것을 바꾸는 코드는 기준 실행에서 그 호출을 더 보게 된다.
- **문자열 `+`의 문법 규칙.** 타입 주석과 내장 객체를 믿는다(L1 참고). 주석과 다른 값이 들어오거나 내장 객체를 덮어쓴 코드에서는 숫자 `+`의 mutant를 놓친다.
- **브라우저 모드.** 지원하지 않는다.
- **실행 시간.**
  - mutant 수 × 관련 테스트 시간만큼 걸린다.
  - hit 기반 테스트 선택과 `bail: 1`, 프로파일로 살아남는 것이 확실한 mutant를 실행하지 않는 것으로 줄이고, `--max-mutants`로 상한을 둔다.
  - mutant는 아직 하나씩 순서대로 실행한다.

## 다음 단계

1. 실제 저장소 몇 곳에서 돌려 보고 오탐과 실행 시간을 측정한다.
2. Vite 서버를 따로 쓰는 project와 `experimental.viteModuleRunner: false`를 지원한다.
3. mutant를 병렬로 실행한다. Vitest 세션 여러 개를 쓰는 방식이다.
4. B: base와 head를 비교해서 기존 테스트가 약해졌는지 확인한다.
