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
| 이 PR이 새로 추가한 억제 | `warn`: 통과시키되 경고 어노테이션과 요약 맨 위에 표시 |
| NoCoverage | Survived와 똑같이 CI 실패 |

## 전체 흐름

```
nyorori run --base <ref>
  1. 범위 계산     git diff --unified=0 <merge-base> → 파일별 "바뀐 줄" 집합
  2. 세션 시작     Vitest를 띄운 별도 프로세스(session)를 시작한다
                  세션이 Vitest 설정으로 대상 파일을 거른다
                  (테스트 파일, coverage.exclude, --exclude 제외)
  3. mutant 생성   oxc-parser로 파싱 → 바뀐 줄에 앵커가 걸린 노드에만 mutant를 만든다
                  → 정적 equivalent 필터 (L1: 휴리스틱, TCE)
                  → 억제 주석 읽기 (L2)
  4. 계측          모든 mutant를 파일에 한꺼번에 넣는다 (mutant schemata)
                  Vite 플러그인(enforce: 'pre')이 원본 대신 계측된 코드를 돌려준다
  5. 기준 실행     원본 그대로(mutant 0)로 관련 테스트를 실행한다
                  - 실패가 하나라도 있으면 exit 2로 중단한다 (mutant를 판정할 수 없음)
                  - 테스트 파일마다 각 mutant 지점이 몇 번 실행됐는지(hit) 기록한다
  6. mutant 실행   mutant마다 provide(id) → 그 지점을 실행한 테스트 파일만, bail: 1로 실행
  7. 보고          stdout, ::error 어노테이션, $GITHUB_STEP_SUMMARY, --json
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

### 무한 루프 처리

무한 루프에 빠진 워커가 있으면 Vitest의 `cancelCurrentRun()`도 `close()`도 끝나지 않는다. 그래서 두 겹으로 막는다.

1. **hit 상한 (Stryker와 같은 방식).** 활성 mutant의 지점이 `기준 hit × 100 + 10000`번을 넘으면 그 지점에서 throw한다. 대부분의 무한 루프(`i++`→`i--` 등)는 루프 안에서 그 지점을 계속 지나므로 여기서 멈춘다. 이 경우 Timeout으로 판정한다.
2. **세션 프로세스 강제 종료.** 계측되지 않은 코드 안에서 도는 루프는 hit 상한에 걸리지 않는다. 예를 들어 mutant가 바꾼 값을 받아 바뀌지 않은 파일의 루프가 끝나지 않는 경우다. 이때는 실행 시간이 `기준 실행 × 2 + --timeout`을 넘으면 세션의 프로세스 그룹(테스트 워커 포함)을 SIGKILL하고, 세션을 다시 띄운 뒤 다음 mutant로 넘어간다.

### mutant 판정

| 상태 | 의미 | CI |
|---|---|---|
| Killed | 테스트가 하나 이상 실패 | 통과 |
| Timeout | hit 상한 초과, 또는 세션 강제 종료 | 통과 (killed로 취급) |
| Survived | 관련 테스트가 모두 통과 | **실패** |
| NoCoverage | 기준 실행에서 이 지점을 실행한 테스트가 없음 | **실패** |
| Ignored | 소스 주석으로 억제됨 (L2) | 통과, 보고서에 표시 |

다음은 개별 mutant의 판정이 아니라 실행 전체를 exit 2로 끝낸다.
- 계측한 코드가 파싱되지 않는 경우
- 다른 플러그인이 먼저 소스를 바꿔 놓아 계측할 수 없는 경우
- 계측 플러그인이 닿지 않는 Vitest project가 있는 경우 (남은 위험의 "여러 project 설정" 참고)

NoCoverage는 테스트를 돌리지 않고 판정하므로 비용이 들지 않는다.
TCE로 버린 mutant는 판정 대상이 아니다. 실행하지 않고, 개수만 보고한다(L1 참고).

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
mutant 생성과 계측은 TS visitor와 `magic-string`으로 한다.
실행 시간의 거의 전부는 테스트 실행이고, diff 범위의 AST 처리는 미미하다.
프로파일링에서 AST 단계가 병목으로 나오면 그 부분만 Rust 코어(napi-rs)로 옮긴다.

```
src/
├─ cli.ts                인자 처리, 출력, exit code
├─ git.ts                merge-base, git diff → 바뀐 줄
├─ mutate/generate.ts    oxc-parser AST → 지점과 mutant, L1 휴리스틱, L2 억제 주석
├─ mutate/equivalent.ts  L1 TCE: oxc-transform + oxc-minify 결과가 원본과 같은 mutant를 버림
├─ mutate/instrument.ts  schemata 삽입, 소스맵, 계측 결과 파싱 확인
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

## Equivalent mutant

### 전제

1. **살아남았다고 equivalent인 것은 아니다.** `age >= 18 → age > 18`은 살아남지만, equivalent가 아니라 경계값 테스트가 빠진 것이다. 실제로 살아남는 mutant 대부분은 이런 경우일 것이다.
2. **억제 수단은 PR을 만든 에이전트도 쓴다.** CI를 통과시키려는 에이전트에게 쉬운 억제 수단은 우회로가 된다. 그러므로 억제는 **눈에 띄고, 이유가 있어야 하고, 범위가 좁아야** 한다.
3. 그 대신 리뷰어가 할 일은 크게 줄어든다. "이 테스트가 바뀐 동작을 정말 확인하는가?"를 판단하던 일이 "이 한 줄짜리 억제 주석의 이유가 맞는가?"를 판단하는 일로 바뀐다.

### L1. 생성 단계에서 거르기 (자동)

보수적으로, 확실한 것만 거른다. 두 단계로 거른다.

**휴리스틱.** mutant를 만들 때 적용한다.

- `console.*` 호출 인자 안쪽은 건너뛴다.
- `!!x`에서는 바깥 `!`만 변형한다. 안쪽을 빼도 결과가 같은 `!x`이기 때문이다.
- `x.length >= 0` 같은 항상 참인 조건은 `true`로 바꾸지 않는다.
- 조건이 이미 `true`/`false` 리터럴이면 Condition mutant를 만들지 않는다. BooleanLiteral mutant와 겹치기 때문이다.
- `x * 1`, `x / 1`은 `*`↔`/` 변형을 만들지 않는다.
- 문자열 연결 `"a" + x`의 `+`는 변형하지 않는다. 문자열 변형은 2차로 미뤘다.

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
  - 쓰는 API: `related` + `getRelevantTestSpecifications()`, `project.provide()`, `project.createSpecification()`, `TestModule.meta()`, 리포터의 `onTestRunEnd`
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
- **Vitest의 임시 디렉터리.** 세션은 SIGKILL로 끝나므로, Vitest가 `os.tmpdir()`에 만드는 임시 디렉터리(변환 결과)를 지우지 못한다. 실행이 끝날 때와 세션을 다시 띄울 때마다 남는다. 세션의 `TMPDIR`을 CLI의 임시 디렉터리로 돌리거나, 정상 종료 때 `vitest.close()`를 기다리면 없앨 수 있다.
- **스냅샷 테스트.** `update: false`로 실행하므로, mutant가 스냅샷을 바꾸면 killed가 된다.
- **flaky 테스트.** mutant가 우연히 killed로 판정되는 방향이라서 판정이 느슨해질 뿐, 거짓 실패는 만들지 않는다. 기준 실행이 실패하면 전체를 중단한다.
- **브라우저 모드.** 지원하지 않는다.
- **실행 시간.**
  - mutant 수 × 관련 테스트 시간만큼 걸린다.
  - hit 기반 테스트 선택과 `bail: 1`로 줄이고, `--max-mutants`로 상한을 둔다.
  - mutant는 아직 하나씩 순서대로 실행한다.

## 다음 단계

1. 실제 저장소 몇 곳에서 돌려 보고 오탐과 실행 시간을 측정한다.
2. Vite 서버를 따로 쓰는 project와 `experimental.viteModuleRunner: false`를 지원한다.
3. mutant를 병렬로 실행한다. Vitest 세션 여러 개를 쓰는 방식이다.
4. B: base와 head를 비교해서 기존 테스트가 약해졌는지 확인한다.
