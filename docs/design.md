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
| 문자열 `+` 판별 | 문자열인 것이 확실한 피연산자만 알아보는 문법 규칙이 먼저 본다. 문법이 모르는 `+`는 TypeScript 7.1 API(`typescript@7.1.0-beta`, 정확히 고정)로 타입을 본다. JavaScript는 TypeScript만큼 엄격하게 검사하는 프로젝트(`checkJs`와 `noImplicitAny`)에서만 본다. 답하지 못하거나 시간을 넘기면 문법 규칙의 판단을 따른다 |
| 이 PR이 새로 추가한 억제 | `warn`: 통과시키되 경고 어노테이션과 요약 맨 위에 표시 |
| NoCoverage | Survived와 똑같이 CI 실패 |
| 실행 시간 프로파일링 | 기준 실행에만 probe를 넣은 계측을 쓴다. mutant 실행은 probe 없는 계측을 쓴다 |
| 프로파일로 살아남는 것이 확실한 mutant | 실행하지 않고 이유와 함께 Survived로 보고한다. `--no-predict`면 실행해서 예측을 검증한다 |
| 타입도 프로파일도 null이 아니라고 하는 `?.`, `??` | 실행하지 않고 unnecessary by types로 따로 보고한다. CI를 실패시키지 않는다. TS 파일에서, config가 `strictNullChecks`를 켠 프로젝트만 본다 |

## 전체 흐름

```
nyorori run --base <ref>
  1. 범위 계산     git diff --unified=0 <merge-base> → 파일별 바뀐 줄과 hunk, 옛 blob
                  대상 파일마다 hunk 안의 옛 토큰과 새 토큰을 diff → "바뀐 범위"
                  (TS 파일은 두 버전을 파싱해, 타입만인 토큰을 넣거나 지운 것은 빼고)
  2. 세션 시작     Vitest를 띄운 별도 프로세스(session)를 시작한다
                  세션이 Vitest 설정으로 대상 파일을 거른다
                  (테스트 파일, coverage.exclude, --exclude 제외)
  3. mutant 생성   먼저 문법 규칙이 모르는 범위 안의 `+`와, TS 파일에서 `?.`·`??`가 지키는 값을 모아
                  TypeScript에 한꺼번에 묻는다. TypeScript 프로세스는 이때만 떠 있다
                  oxc-parser로 파싱 → 바뀐 범위를 담은 지점에만 mutant를 만든다
                  → 정적 equivalent 필터 (L1: 휴리스틱, TCE). `+`는 문법 규칙, 그다음 TypeScript의 답으로 판단한다
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
                  그중 타입으로도 null이 될 수 없는 값을 지키는 `?.`·`??`는 unnecessary로 따로 둔다
  7. mutant 실행   세션이 plain 계측으로 바꾸고 계측한 파일을 무효화한다
                  mutant마다 provide(id) → 그 지점을 실행한 테스트 파일만 끝까지 실행 (bail 없음)
                  살아남는 것이 확실한 mutant와 unnecessary는 실행하지 않는다 (--no-predict면 실행한다)
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
타입도 프로파일도 null이 아니라고 하는 `?.`·`??`의 mutant(unnecessary by types)도 판정 대상이 아니다. 실행하지 않고, 목록으로 보고하고, CI를 실패시키지 않는다("타입으로 불필요한 방어 코드" 참고).

### 범위 규칙

바뀐 줄이 아니라 바뀐 토큰으로 정한다(`src/diff.ts`).

**바뀐 범위.** git이 바뀐 줄(hunk)을 찾고, hunk마다 옛 토큰과 새 토큰을 다시 diff한다.

- 옛 내용은 diff의 `index` 줄에 있는 blob을 `git cat-file`로 읽는다. 이름이 바뀐 파일(`--find-renames`)도 옛 파일의 blob이 온다. 읽지 못하면 그 hunk의 토큰을 모두 새것으로 본다. 새 파일도 그렇다.
- 토큰은 이름, 숫자, 문자열, 템플릿 조각(`` `a${ ``, `` }b` ``), 정규식 리터럴, 구두점이다. 공백과 주석은 토큰이 아니다. 그래서 줄바꿈과 들여쓰기만 바꾼 줄, 주석만 바꾼 줄에는 바뀐 범위가 없다.
  - 토큰은 파일 전체를 훑어서 나눈다. hunk가 여러 줄짜리 템플릿 리터럴 가운데에서 시작해도 그 안의 공백을 코드의 공백으로 읽지 않는다.
  - 주석을 빼는 이유: 런타임에 실행되지 않는다. `/* @__PURE__ */`는 TCE의 압축에만, JSDoc 타입은 타입으로 답하는 것에만 영향을 준다. 억제 주석은 줄 기준으로 따로 읽는다(L2 참고).
- 동작을 바꾸지 않는 차이는 비교에서 뺀다.
  - 따옴표만 다른 문자열: `'a'`와 `"a"`. 안에 따옴표나 `\`가 있으면 텍스트 그대로 비교한다. 이스케이프까지 읽을 만큼 흔하지 않다.
  - 끝의 쉼표: `f(a,)`는 `f(a)`다. `[a,,]`의 마지막 빈칸은 길이를 바꾸므로 센다.
- 동작을 바꾸는 줄바꿈은 센다. ASI가 `return\nx`를 `return; x`로 읽으므로 `return`, `throw`, `break`, `continue`, `yield`, `async` 뒤의 줄바꿈과, `++`, `--` 앞의 줄바꿈(`a++\nb`와 `a\n++b`)이다.
- 문자열, 템플릿 조각, 정규식은 통째로 비교하므로 그 안의 공백도 센다.
- 비교는 Myers diff다. 앞뒤의 같은 토큰을 먼저 떼어 내므로 보통은 몇 토큰만 비교한다. 편집이 1000개를 넘는 hunk는 더 찾지 않고 모두 새것으로 본다. 6500줄짜리 hunk 하나(파일 전체를 다시 들여쓰거나 모든 이름을 바꾼 경우)도 75ms 안이었다.
- 넣거나 바꾼 토큰이 바뀐 범위다. 아무것도 넣지 않고 지운 곳은 그 앞뒤 토큰 사이의 빈 범위로 남긴다. 그 자리를 감싸는 식은 바뀌었고(`a && b && c` → `a && c`), 옆의 식은 바뀌지 않았다.
- 줄을 옮기면 git은 지우고 넣은 것으로 본다. 옮긴 코드는 실행 순서가 바뀌므로 바뀐 것으로 둔다.

**타입만 고친 것.** TypeScript 파일(`.ts`, `.tsx`, `.mts`, `.cts`)에서는 컴파일하면 지워지는 토큰을 넣거나 지워도 바뀐 것으로 치지 않는다. 타입만 고친 PR에 mutant가 생기면 안 된다. es-toolkit 사례 PR(`nyorori/case-types-comments-only`)은 `any`→`unknown`, `as number`, interface의 `readonly`, JSDoc, 반환 타입만 바꿨는데 mutant가 10개 생겼다. 매개변수와 반환 타입이 함수 머리를 바꿔 FunctionBody가 생겼고, `a < b`를 `(a as number) < (b as number)`로 바꾸자 손대지 않은 `a < b`의 mutant가 생겼다.

- 지워지는 것: 타입 주석과 반환 타입, 타입 매개변수와 타입 인자, `as T`·`satisfies T`·non-null `!`·`<T>x`, interface, type alias, `declare`한 것, abstract 멤버, overload와 index signature, `implements …`, `this` 매개변수와 그 쉼표, 선언한 이름 뒤의 `?`·`!`, 클래스 멤버의 `private`·`protected`·`public`·`readonly`·`override`, 그리고 cast 때문에만 있는 괄호. `(a as number) < (b as number)`는 `a < b`로 실행된다.
  - cast를 감싼 괄호는 cast를 지운 안쪽이 이름, 멤버 접근, 호출, 배열 리터럴, 템플릿, 수가 아닌 리터럴일 때만 지워지는 것으로 본다. 연산자(`(a + b as number) * c`), optional chain(`(a?.b as B).c`는 `a?.b.c`와 달리 `a`가 null이면 throw한다), 수(`(1 as number).toFixed()`), `new`가 부르는 호출(`new (f() as F)()`는 `new f()()`가 아니다)을 감싼 괄호는 실행에 영향을 준다.
- 실행에 영향을 주는 TypeScript는 센다. parameter property(`constructor(private x)`)는 필드에 대입하고, enum과 namespace는 객체를 만들고, decorator는 실행된다. 필드를 `declare`나 `abstract`로 바꾸면 그 필드를 정의하지 않게 되므로, 옛 필드 이름을 지운 것으로 본다.
- 두 버전을 각각 oxc-parser로 파싱해 지워지는 토큰을 표시한다. 토큰을 맞출 때는 표시한 토큰도 그대로 쓰고, 넣거나 지운 토큰 중 표시한 것만 바뀐 것에서 뺀다. 표시한 토큰은 실행되는 같은 텍스트의 토큰과 다른 토큰으로 본다(`x: T` → `declare x: T`에서 `x`).
  - 처음에는 표시한 토큰을 빼고 diff했다(타입을 지운 코드끼리 비교). 그러면 토큰 맞춤이 달라져, es-toolkit PR 2146에서 새 `const mappedValue = mapper(value)`의 `mapper(value)`가 옛 `mappedSecondSet.has(mapper(value))` 안의 같은 호출에 맞춰졌고 CallUnwrap이 빠졌다. 그래서 맞춤은 이전과 같게 두었다.
  - 파싱되지 않는 버전에는 표시하지 않는다. 모든 토큰을 센다.
- 사례 PR은 10개에서 0개가 됐다. es-toolkit의 최근 커밋 300개에서 `src`의 바뀐 파일마다 이 규칙이 빼는 mutant는 23개였다. 타입만 바꾼 함수 머리의 FunctionBody 20개와, `doesMatch(value, key as number, collection)`에서 `as number`만 지운 호출의 Condition 2개와 CallUnwrap 1개다. 늘어난 mutant는 없다. i18next(JavaScript)는 0개다. upstream PR 13개와 다른 사례 PR 27개의 계획은 그대로다.
- 표시한 토큰을 `oxc-transform`이 타입을 지운 결과와 비교했다. 함수마다 표시하지 않은 토큰과 변환 결과의 같은 함수 토큰을 비교하면(`;`, 괄호, 쉼표는 빼고, 리터럴은 값으로), es-toolkit `src`의 함수 1187개 중 다른 것은 parameter property가 있는 생성자 하나였다(일부러 센다). nyorori의 함수 732개는 모두 같았다.

**표현식 지점.** 지점의 텍스트가 바뀐 범위를 담으면(지운 곳은 지점 안쪽에 있어야 한다) 그 지점의 mutant를 만든다. 앵커가 어느 줄에 있는지는 보지 않는다. 앵커는 mutant가 바꾸는 토큰의 위치이고(연산자, 리터럴, 조건식의 시작, 함수 본문의 `{`), 보고하는 줄과 열은 이전처럼 앵커의 위치다.

- es-toolkit PR 2047은 `Math.min(fromIndex, arr.length - 1)`을 `Math.min(index, arr.length - 1)`로 바꿨다. 줄 기준일 때는 손대지 않은 `arr.length - 1`의 `-`→`+`까지 만들었고, 이 mutant는 equivalent라서 CI를 실패시켰다. 이제는 `index`를 담은 `Math.min(…)`의 CallUnwrap만 만든다.
- 바뀐 피연산자는 그것을 감싸는 비교, 논리식, 조건의 mutant를 만든다. 여러 줄에 걸친 조건에서 둘째 줄만 바뀌어도, 첫 줄에 앵커가 있는 Condition과 `||`가 생긴다(i18next PR 2395). 줄 기준일 때는 생기지 않았다.
- 지점 안에 있는 함수의 블록 본문에서 바뀐 것은 세지 않는다. 그 문장들은 그 함수의 것이고, 그 함수 안의 지점이 확인한다. 세면 콜백 안을 고칠 때마다 `xs.forEach((x) => { … })` 호출을 지우는 mutant가 생긴다. i18next PR 2450과 2455를 다시 돌렸을 때 실제로 생겼다. 식 본문(`(x) => x.ok`)은 식의 일부이므로 센다.
- 문자열 `+`인지 TypeScript에 묻는 것도 이렇게 범위 안에 있는 `+`만이다.

**함수 본문 지점.** 블록 본문의 mutant는 본문 전체를 건너뛴다. 본문을 기준으로 하면 함수 안을 고칠 때마다 생기므로, 함수의 머리가 바뀐 범위를 담을 때만 만든다.

- 머리는 함수의 시작부터 본문의 `{`까지다. 메서드는 이름부터다(`get size() {`). 그래서 새 함수와, 매개변수나 이름을 바꾼 함수에 생긴다.
- 식 본문의 `=> undefined`는 그 식을 바꾸는 표현식 지점이다. 그래서 머리나 본문 식이 바뀐 범위를 담으면 만든다.

**이름 바꾸기.** `fromIndex`→`index`처럼 이름 하나가 다른 이름으로 바뀐 것도 바뀐 토큰이다. 옛 이름이 새 함수에 없고 새 이름이 옛 함수에 없는 "순수한 이름 바꾸기"를 바뀌지 않은 것으로 보는 방법도 생각했지만 하지 않았다.

- 토큰만으로는 건전하게 정할 수 없다. 그 조건을 만족해도 동작이 바뀌는 경우가 있다. 바깥 스코프의 다른 변수를 가리키게 된 이름(`return limitA` → `return limitB`), 속성 이름(`o.fromIndex`), 단축 속성(`{ fromIndex }`는 키가 바뀐다), export한 이름이 그렇다. 건전하게 하려면 옛 파일도 파싱해서 두 버전의 바인딩을 맞춰 봐야 한다.
- 실제로 드물었다. 다시 돌린 PR 13개에서 이름 하나가 다른 이름 하나로 바뀐 곳 9개는 모두 동작이 바뀐 것이었다. 옛 이름이 다른 뜻으로 그대로 남아 있거나(`fromIndex`→`index`, `str`→`parts`, `fc`→`formattedFc`), 이름이 아닌 값이었다(`undefined`→`null`). 파일 단위로 위 조건을 만족한 하나(`dedented`→`Array`)는 다시 쓴 코드에서 diff가 우연히 맞춘 것이지 이름 바꾸기가 아니었다.

**남은 한계.**

- 토큰이 같으면 같은 코드로 본다. 그러나 이름이 가리키는 변수는 바뀌었을 수 있다. es-toolkit PR 2146은 콜백을 다시 썼고, diff는 옛 `emit(value);`를 새 `return emit(value);`의 `emit(value)`에 맞췄다. 새 코드에서 `emit`은 다른 함수의 매개변수이고, 그 결과를 이제 돌려준다. 이 호출의 CallUnwrap은 범위 밖이 됐다. 새로 만든 두 함수의 FunctionBody는 범위 안이다. 선언이 바뀐 이름을 쓰는 곳까지 바뀐 것으로 치면 잡을 수 있지만, 선언을 옮기기만 해도 그 이름을 쓰는 곳이 모두 범위 안으로 들어온다. 그래서 아직 하지 않았다.
- 괄호를 더해 묶음을 바꾸면(`a - b * c` → `(a - b) * c`) 안쪽 `a - b`는 토큰이 같으므로 범위 밖이다. 괄호를 담은 바깥 식(`*`)이 범위 안이다.
- 괄호는 동작을 바꿀 수 있으므로 늘 센다. Prettier가 괄호를 더하거나 빼면 그 괄호를 담은 식이 범위에 들어온다. 화살표 함수 매개변수의 괄호(`x => x` → `(x) => x`)는 머리를 바꾼 것이 된다. 세미콜론도 토큰이지만 문장 끝에 오므로 담는 지점이 거의 없다.
- 문장을 통째로 지운 것은 감싸는 식이 없으므로 여전히 A의 범위 밖이다(B에서 다룬다). 식의 일부를 지운 것은 위처럼 그 식을 바꾼 것이다. 그래서 줄을 지우기만 한 파일도 대상 후보로 남는다.

**그 밖의 범위.**

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
| `CallUnwrap` | 함수 호출 → 첫 인자. `toInteger(x)`→`x`, `this.getValue(x)`→`x`, `Math.min(i, n)`→`i`. 문자열·배열을 바꾸는 메서드 → receiver. `s.trim()`→`s`, `xs.map(f)`→`xs`. 그 밖의 메서드 호출에는 만들지 않음 |
| `CallStatement` | 값을 버리는 호출 문 → 호출 제거. `unmatched.delete(key)`→`undefined`, `await save(x)`→`await undefined` |
| `Regex` | 정규식 리터럴: flag 하나 제거, 최상위 `^`·`$` 제거, 문자 클래스 부정(`[abc]`↔`[^abc]`), `\d`↔`\D`, `\w`↔`\W`, `\s`↔`\S` |

문자열 리터럴→`""`과 배열/객체 리터럴 비우기는 오탐이 많아 2차로 미룬다.

#### 호출과 정규식

es-toolkit과 i18next의 upstream PR 13개를 다시 돌려 보니, 고친 코드에 mutant가 하나도 생기지 않는 경우가 많았다. 그러면 녹색 결과는 그 수정에 대해 아무것도 말하지 않는다.
- 값을 감싸는 호출을 더한 수정: `normalizeZero(x)`, `toInteger(fromIndex)`, `getValue(element)`
- 호출 문을 더한 수정: `unmatched.delete(key)`
- 정규식 리터럴을 바꾼 수정: `/s`나 `/g` flag를 더함

그래서 세 연산자를 더했다. 셋 다 다른 연산자처럼 함수 안의 코드에만 만들고, 타입 위치는 들어가지 않는다.

**`CallUnwrap`.** 호출을, 그 호출이 하던 일을 하지 않은 코드로 바꾼다. 호출 하나에 많아야 하나를 만든다. 무엇으로 바꿀지는 callee의 모양으로 정한다.
- 함수 호출은 첫 인자로 바꾼다. 감싸는 함수를 지운 코드다. 다음을 함수 호출로 본다.
  - callee가 멤버 접근이 아닌 호출: `toInteger(x)`, `normalizeZero(v)`, `make()(x)`
  - `this`나 `super`의 메서드: `this.getValue(x)`, `this.#parse(x)`, `super.m(x)`. 클래스 기반 코드에서 헬퍼 함수 노릇을 하는 클래스 자신의 메서드다.
  - 가려지지 않은 전역 `Array`, `BigInt`, `Date`, `JSON`, `Math`, `Number`, `Object`, `Promise`, `Reflect`, `String`, `Symbol`의 정적 메서드: `Math.min(i, n)`→`i`, `Object.assign(parts, { raw: parts })`→`parts`. 이 내장 객체들의 정적 메서드는 다루는 값을 첫 인자로 받는다. 그 밖의 전역(`Buffer`, `process`, `document`, 전역 `$`·`_`)은 호스트나 라이브러리의 객체라서 메서드가 첫 인자의 함수라고 할 수 없고, `Buffer.concat(list)`, `_.map(xs, f)`처럼 아래의 변환과 이름이 같은 것도 있다. 그래서 만들지 않는다.
  - `import * as ns`로 가져온 namespace의 함수: `ns.parse(x)`
  - 첫 인자가 없거나, spread이거나, 함수 리터럴(콜백)이면 만들지 않는다. 결과가 그 함수인 API는 거의 없고, 있으면 같은 함수처럼 동작한다(`useCallback(fn, deps)`). 결과를 쓰는지만 확인하는 mutant가 된다.
- 받는 값과 같은 종류의 값을 돌려주는 메서드는 receiver로 바꾼다. 변환을 적용하지 않은 코드다. `xs.map(normalizeZero)`→`xs`, `code?.replace(/_/g, '-')`→`code`.
  - 문자열: `trim`, `trimStart`, `trimEnd`, `trimLeft`, `trimRight`, `toLowerCase`, `toUpperCase`, `toLocaleLowerCase`, `toLocaleUpperCase`, `normalize`, `padStart`, `padEnd`, `repeat`, `replace`, `replaceAll`, `substring`, `substr`, `toWellFormed`
  - 배열: `map`, `filter`, `flat`, `flatMap`, `sort`, `reverse`, `toSorted`, `toReversed`. `sort`와 `reverse`는 receiver 자신을 돌려준다.
  - 둘 다: `slice`, `concat`
  - 바뀌는 것은 receiver이므로, 인자가 없거나(`s.trim()`) 콜백이나 spread를 받아도(`xs.filter((x) => x.ok)`, `[a].concat(...xs)`) 만든다.
  - 사본(`xs.slice()`, `xs.slice(0)`, `xs.concat()`)을 바로 읽기만 하고 버리면 만들지 않는다: `xs.slice().map(f)`. 사본을 읽는 메서드는 receiver를 바꾸지 않고 새 배열이나 값을 돌려주는 `map`, `filter`, `flat`, `flatMap`, `slice`, `concat`, `toSorted`, `toReversed`, `toSpliced`, `with`, `at`, `includes`, `indexOf`, `lastIndexOf`, `join`이다. 이 경우 사본은 바로 버려지므로 receiver를 써도 같은 값을 읽는다.
  - `forEach`, `some`, `every`, `find`, `reduce`로 도는 사본에는 만든다. 이런 사본은 대개 몸체가 원본을 바꾸기 때문에 있다(`listeners.slice().forEach((l) => l())`에서 listener가 구독을 끊는다). iterator(`values()`)는 receiver를 나중에 읽는다.
  - 그 밖의 사본, 즉 변수에 담거나, 돌려주거나, 넘기거나, 제자리에서 바꾸는 사본에는 만든다. mutant는 입력 자체를 쓰는 코드다. 함수가 입력을 바꾸거나 그대로 돌려주고, clone이 버퍼를 공유하고, 캐시가 내부 배열을 내준다.
  - 처음에는 반대로, 사본을 바로 제자리에서 바꿀 때(`xs.slice().sort()`)만 만들려고 했다. 그 전에 es-toolkit과 i18next의 `src` 전체에서 그 규칙이 빼는 사본 15개에 mutant를 하나씩 넣고 관련 테스트(`vitest related`)를 돌렸다. 바로 제자리에서 바꾸는 사본은 하나도 없어서 15개가 모두 빠질 참이었다.
    - 5개는 잡혔다: `shuffle`, `remove`, `clone`의 ArrayBuffer, `cloneDeepWith`, i18next의 `codes.slice()`.
    - 8개는 살아남았고 실제 테스트 공백이다. `toFilled`가 입력을 바꾸고, `dropRight`와 `takeRightWhile`이 입력을 그대로 돌려주고, typed array와 DataView clone이 버퍼를 공유하고, compat `mergeWith`가 입력 배열의 빈칸을 채우고, i18next가 캐시 배열을 그대로 내준다. fp `windowed`의 `emit(buffer.slice())`는 확인하지 않았다.
    - equivalent는 2개였다. `partial`과 `partialRight`의 `partialArgs.slice().map(…)`이다. 지금 규칙은 정확히 이 둘만 뺀다.
  - `Array.from(x)`와 `structuredClone(x)`는 사본으로 보지 않는다. 바로 읽고 버리는 `Array.from(x)`도, 지역 `const`에 담아 읽기만 하는 사본도 빼 보았지만 받아들이지 않았다. 같은 방법으로 es-toolkit과 i18next의 `src`에서 빠질 mutant를 하나씩 넣고 `vitest related`를 돌렸다.
    - 바로 읽고 버리는 `Array.from(x)`는 es-toolkit에서 5개를 뺐다. 대개 변환이었다. compat의 `findIndex`, `indexOf`, `join`은 array-like 테스트만 잡았고, `pullAllBy`는 array-like `values`를 테스트하지 않아 살아남았다(실제 공백). `createPadding`은 문자열에 `.join`을 불러 타입으로만 잡혔다.
    - 지역 `const` 사본 규칙은 두 저장소에서 아무것도 빼지 않았다. 그런 사본은 모두 제자리에서 바뀌거나, 돌려주거나, 넘기거나, 스냅샷이었다(`remove`, `shuffle`, `difference`, `cloneDeepWith`, `omit`).
    - 둘을 합치면 es-toolkit 2099의 `const parts = Array.from(strings)`(equivalent)도 빠지지만, 위의 4개도 같이 빠진다. 인자의 타입이 `ArrayLike<string>`으로 `join`·`findIndex`·`indexOf`와 같아서, 문법이나 타입으로는 구별할 수 없다. 이 mutant는 억제 주석으로 다룬다.
    - `structuredClone`은 깊은 사본이라 `includes`·`indexOf`의 동일성 비교와 `map`이 넘기는 원소가 원본과 다르다. 읽고 버려도 equivalent가 아니다.
  - 결과가 문자열이나 배열이어도 receiver의 일부를 꺼내는 조회(`charAt`, `at`)와 다른 종류로 바꾸는 것(`split`, `join`)은 넣지 않았다.
- 그 밖의 메서드 호출에는 만들지 않는다. 조건과 조회(`set.has(v)`, `xs.includes(x)`, `s.indexOf('(')`, `map.get(k)`, `xs.join('')`, `re.test(s)`), 그리고 사용자 메서드다. 첫 인자도 receiver도 결과와 다른 종류의 값이어서, 테스트가 타입만 보고 잡는다. 그 호출이 조건이면 Condition과 Negation이, 값을 버리는 문이면 CallStatement가 변형한다.
- receiver가 다음 이름이면 메서드 이름과 상관없이 만들지 않는다. 모듈이나 클래스는 문자열이나 배열이 아니다. `path.normalize(p)`가 `path`가 되지 않는다.
  - `import * as` 말고 import한 이름. 기본 import는 모듈(`import path from 'node:path'`)일 수도, 인스턴스(`i18next.t(key)`→`key`는 없는 키에 대한 i18next의 fallback과 같은 값이다)일 수도 있어서 첫 인자로도 바꾸지 않는다.
  - `require(…)`나 `await import(…)`로 받은 이름과, 거기서 구조 분해한 이름
  - 클래스, enum, TS namespace
  - 위 목록에 없는 전역
- 메서드 이름으로 정하므로 receiver가 정말 문자열이나 배열인지는 모른다. `map`이라는 메서드가 있는 사용자 객체도 receiver로 바뀐다. 받아들인 이유는 이렇다.
  - 이 이름들은 대개 같은 뜻으로 쓰인다. iterator helper, typed array, RxJS, Immutable.js, lodash wrapper, Option/Result 타입의 `map`, `filter`, `concat`, `slice`도 같은 종류의 값을 돌려준다. 그러면 mutant는 내장 메서드에서와 같은 뜻이다.
  - 뜻이 다른 메서드(`router.replace(path)`)라도 mutant는 그 호출을 하지 않은 코드다. 테스트는 CallStatement의 mutant처럼 그 효과로 잡거나, 이전의 첫 인자 mutant처럼 다른 종류의 값으로 잡는다. 이전보다 나빠지지 않는다.
  - 조회나 조건인 메서드 이름(`get`, `has`, `test`)은 목록에 없으므로, 이름이 같아도 잘못된 종류의 receiver를 만들지 않는다.
- 앵커(보고하는 위치)는 callee의 이름이다(`a.b(x)`의 `b`, `f(x)`의 `f`). 체인의 다음 줄에 더한 `.b(x)`는 그 줄로 보고된다.
- optional chain의 끝인 호출(`a?.b(x)`)은 체인 전체를 지점으로 삼는다. 둘은 범위가 같다. receiver로 바꿀 때 그 receiver(`a`, `a?.list`)도 그대로 온전한 식이다. 체인 안에서 `?.` 뒤에 오는 호출(`a?.b(x).c`의 `a?.b(x)`)은 만들지 않는다. 괄호로 감싸면 체인이 거기서 끊겨, `a`가 null일 때 원본 분기도 `.c`에서 throw하게 된다. `?.` 앞의 호출(`f(x)?.y`의 `f(x)`)은 감싸도 같다.
- 지점은 호출 전체이고 바꾸는 텍스트는 그 안의 receiver이므로, 바깥 호출의 `this`는 그대로다. `xs.map(f).join(',')`에서 `join`의 `this`는 감싼 식의 값(원본이면 `xs.map(f)`의 결과, mutant면 `xs`)이다. `test/instrument.test.ts`가 `map` 메서드가 있는 사용자 클래스와 세미콜론 없는 문으로 확인한다.
- 만들지 않는 것
  - `super(x)`: `this`가 초기화되지 않는다. `import(x)`는 호출 노드가 아니다. `require('x')`→`'x'`는 아무것도 확인하지 않는다.
  - 로그 호출과 그 인자: 전역 `console` 호출과 로거의 로그 레벨 메서드(`logger.warn(…)`). L1의 로그 필터와 같다.
  - 다른 호출, `new`, tagged template의 callee이거나 `delete`의 대상인 호출: `f(x)(y)`→`x(y)`는 `x`가 함수가 아니라는 것만 확인한다. `delete (x)`는 strict mode에서 문법 오류다.
  - `f.call(that, x)`, `.apply`, `.bind`: 첫 인자는 넘기는 값이 아니라 `this`다.
  - 식 문이 값을 버리는 호출: `CallStatement`가 맡는다. 첫 인자를 평가한다는 것 말고는 같은 mutant다.
  - 둘레의 코드가 같은 변환을 어차피 하는 값의 변환 호출. 셋 다 가려지지 않은 전역이고 인자가 하나일 때만이다. 인자가 더 있으면 mutant는 나머지를 평가하지 않는다.
    - truthiness만 쓰는 값의 `Boolean(x)`: `if`, `while`, `do…while`, `for`, `?:`의 조건, `!`의 피연산자, 그리고 그 값을 truthiness로만 쓰는 `&&`·`||`의 피연산자다. 괄호는 벗긴다. `if (a && Boolean(x))`→`if (a && x)`는 같은 분기로 간다.
      - `??`의 피연산자는 아니다. `Boolean(x)`는 nullish가 아니어서 `Boolean(x) ?? y`는 `y`가 되지 않지만, `x ?? y`는 `x`가 null이면 `y`다. 돌려주거나 담거나 넘기는 `Boolean(x)`에도 만든다.
      - `test/generate.test.ts`의 자리에서는 이 mutant를 이전에도 TCE가 버렸다. minifier가 조건 안의 `Boolean(x)`를 `x`로 줄인다. 이제는 만들지 않으므로 압축할 일도 없다.
    - tagged가 아닌 템플릿의 식인 `String(x)`: `` `${String(x)}` ``. 템플릿도 `String()`처럼 ToString으로 바꾼다.
      - tagged template에는 만든다. tag는 값을 그대로 받는다.
      - 문자열 `+`(`'' + String(x)`)에도 만든다. `+`의 ToPrimitive는 `valueOf`를 먼저 부르므로 `'' + obj`는 `String(obj)`와 다를 수 있다.
    - `await`의 피연산자, async 함수의 `return` 값, async 화살표 함수의 식 본문인 `Promise.resolve(x)`. 괄호만 벗긴다.
      - `await`는 PromiseResolve를 스스로 하므로 `await Promise.resolve(x)`와 `await x`는 같다. async 함수도 돌려주는 값으로 자기 promise를 resolve한다.
      - 그 밖의 `Promise.resolve(x)`에는 만든다. async가 아닌 함수가 돌려주면 호출자는 promise 자체를 받는다.
    - Symbol을 넣은 템플릿과 microtask 시점은 받아들인 차이다("남은 위험" 참고).
    - es-toolkit과 i18next의 `src`에는 이 자리의 변환 호출이 없어서, 모든 줄을 바뀐 것으로 쳐도 mutant는 그대로였다. upstream PR 13개의 계획도 같다.
- 같은 지점의 다른 mutant와 대체 텍스트가 같으면 만들지 않는다. `if (check(true))`의 `→ true`는 Condition이 이미 만든다.
- 이전에는 인자가 있는 모든 호출을 첫 인자로 바꿨다. upstream PR 13개를 다시 돌렸을 때 그 `CallUnwrap` 29개를 보고 지금 규칙으로 바꿨다.
  - 함수 호출과 정적 호출은 잘 들었다. `toInteger(fromIndex)`→`fromIndex`, `normalizeZero(value)`→`value`, `getValue(element)`→`element`, `Number.isNaN(value)`→`value`, `this.formatLanguageCode(fc)`→`fc`가 모두 잡혔고, `Object.assign(parts, { raw: parts })`→`parts`는 실제로 빠진 테스트를 드러냈다.
  - 13개는 메서드 호출을 첫 인자로 바꾼 것이었다(`.has(v)`→`v`, `.includes(x)`→`x`, `.indexOf('(')`→`'('`, `.join('')`→`''`, `.replace(re, s)`→`re`, `.map(fn)`→`fn` 등). 값의 종류가 달라 모두 바로 잡혔고, 코드가 하는 일은 확인하지 않았다. 둘은 무한 루프로 Timeout이 됐다. i18next 2399의 `code?.replace(/_/g, '-')`→`/_/g`(20초)와 es-toolkit 2099의 `while (joinedParts.includes(placeholder))` 안의 `→ placeholder`다. es-toolkit 2049의 `differenceToolkit(…).map(normalizeZero)`→`normalizeZero`는 그 PR이 더한 `-0` 처리를 테스트가 확인하는지 말하지 않았다.
  - 지금 규칙으로 13개를 로컬에서 다시 돌렸다(실제 실행, 이전 규칙도 같은 기계에서). `CallUnwrap`은 29개에서 19개, 전체 mutant는 108개에서 98개, Timeout은 7개에서 5개가 됐다. Survived 10개는 그대로다. wall time 합은 165초에서 137초가 됐다.

| PR | 이전 | 지금 | 바뀐 것 |
|---|---|---|---|
| es-toolkit 2049 | 9K 1T | 8K 1T | `….map(normalizeZero)`→`…`를 PR의 `-0` 테스트(`differenceWith([-0, 1], [1])`)가 잡음. `valuesSet.has(value)`→`value` 없음 |
| es-toolkit 2099 | 11K 1T 3S | 8K 3S | `joinedParts.includes(placeholder)`의 Timeout과 `join`·`split`의 3개 없음. 9.1초 → 7.5초 |
| es-toolkit 2146 | 9K | 8K | `unmatched.has(…)` 없음 |
| i18next 2399 | 3K 1T | 4K | `code?.replace(/_/g, '-')`→`code`가 잡힘. 32초 → 14초 |
| i18next 2437 | 10K 2T 3S | 8K 2T 3S | `indexOf`·`includes`의 2개 없음 |
| i18next 2440 | 4K | 3K | `/{.*}/s.test(…)` 없음 |
| i18next 2450 | 6K | 5K | `codes.includes(…)` 없음 |
| 나머지 6개 | | 같음 | es-toolkit 2122의 `Object.hasOwn(result, key)`→`result`는 정적 호출이라 남음 |

**설명.** 호출 mutant의 설명은 호출을 callee 중심으로 짧게 보인다. `` `toInteger(fromIndex)` → `fromIndex` ``, `` `code?.replace(/_/g, '-')` → `code` ``. 40자를 넘으면 20자보다 긴 receiver는 `…`로 줄이고, 인자는 뒤를 자른다. `` `….map(normalizeZero)` → `…` ``.
- 이전에는 지점의 앞에서부터 40자를 잘랐다. 그래서 `` `differenceToolkit(Array.from(array), ...` → `normalizeZero` ``처럼 바뀌는 메서드가 보이지 않았다.
- CallStatement(`` `unescapedValues.push([match.index, mat…)` removed ``)와 `a ?? b`→`a`(`` `… ?? options.escapeValue` → `…` ``)도 같은 방식이다. `??`는 연산자가 가운데에 있어서, 왼쪽이 길면 바꾸는 부분이 잘렸다.
- 바꾸는 부분이 맨 앞에 있는 Condition, Negation, UnaryMinus, FunctionBody의 식 본문은 이전처럼 앞에서부터 40자로 자른다. 자른 곳은 `...` 대신 `…`로 표시한다.

**`CallStatement`.** 식 문의 식이 호출이면(괄호와 TS 단언은 벗긴다) 그 호출을 `undefined`로 바꾼다. 부수 효과가 일어나지 않는다.
- `await f(x)`는 호출만 바꿔 `await undefined`가 된다. 문이 한 틱 기다리는 것은 그대로다.
- `a?.b(x)`처럼 optional chain의 끝인 호출은 체인 전체를 바꾼다. 같은 범위의 OptionalChaining과 한 지점이 된다.
- `super(x)`(파생 클래스의 생성자가 `this`에서 throw함), 로그 호출(전역 `console` 호출, `logger.warn(…)`), 메트릭 호출 문(`metrics.increment(…)`)은 만들지 않는다. L1의 로그 필터와 같다.
- 지점이 문 맨 앞이므로 계측은 문을 블록으로 감싼다(`Site.statement`). 앞 줄에 세미콜론이 없어도 `(`가 앞 줄과 이어지지 않는다.
- 결과를 쓰지 않는 순수한 호출(`Math.abs(x)`)은 minifier가 원본에서도 지우므로 TCE가 버린다.

**`Regex`.** 정규식 리터럴 하나에 다음을 하나씩 만든다. 설명은 `` `/…/gi` → `/…/i` ``, `` `^` removed ``, `` `[abc]` → `[^abc]` ``, `` `\d` → `\D` ``처럼 짧게 쓴다.
- flag 하나 제거. `m`은 `^`·`$`만, `s`는 `.`만 읽으므로, 클래스 밖에 그것이 없으면 빼도 같아서 만들지 않는다.
- 그룹 밖의 `^`나 `$` 제거
- 문자 클래스 부정: `[abc]`↔`[^abc]`, `[]`↔`[^]`. `v` flag에서는 중첩된 클래스 중 바깥 것만
- `\d`↔`\D`, `\w`↔`\W`, `\s`↔`\S`. 클래스 안의 것도 바꾼다.
- 패턴은 한 번 훑어서 읽는다. 이스케이프는 두 글자로 건너뛴다. `\u{41}`, `\p{L}`, `\k<name>`처럼 더 긴 이스케이프의 나머지에는 괄호, 대괄호, 앵커, `.`가 없다. 클래스 안의 `[`는 `v` flag에서만 중첩 클래스를 연다.
- **모든 mutant를 CLI 프로세스에서 `new RegExp(pattern, flags)`로 컴파일해 보고, 실패하면 버린다.** oxc-parser는 정규식 리터럴의 패턴을 검사하지 않는다. `/a**/`, `/[z-a]/`, `/a{2,1}/`도 파싱된다(확인함). 그래서 잘못된 리터럴은 계측 결과의 파싱 확인을 통과하고, Vitest가 파일을 읽을 때 SyntaxError가 되어 기준 실행이 실패한다(exit 2). 예를 들어 `/[\p{L}--[a-z]]/v`에서 `v`를 빼면 범위 순서가 틀린 클래스가 되고, `[\q{ab}c]`는 `v`에서도 부정할 수 없다.
- 원본이 이 Node에서 컴파일되지 않으면 그 리터럴은 변형하지 않는다. 엔진이 읽지 못하는 패턴을 추측으로 훑지 않으려는 것이다.
- 패턴이 비면 `(?:)`로 쓴다. `//`는 주석이다. `*`로 시작하는 패턴은 `/*`가 되지만 늘 컴파일되지 않으므로 이미 버려진다.
- 리터럴은 계측에서 늘 `(` 뒤에 온다(`(__nyorori_h(…) ? (/a/g) : … ? (/a/) : …)`). 그래서 대체 텍스트의 `/`가 나눗셈으로 읽히지 않는다. 문 맨 앞의 리터럴(블록 뒤의 `/x/.test(s) && …`)은 문 전체를 블록으로 감싼다. `n / /ab/.source.length`처럼 나눗셈 바로 뒤의 리터럴도 `test/instrument.test.ts`가 확인한다.
- 모듈 최상위의 `const RE = /…/`는 다른 연산자처럼 대상이 아니다.

**프로파일로 예측하지 않는다.** 셋 다 probe를 넣지 않고, 실행해서 판정한다.
- 호출은 인자를 그대로 돌려주어도 부수 효과가 있을 수 있다. 기록하거나, 캐시에 넣거나, 상태를 바꾼다. 그래서 "모든 평가에서 결과가 첫 인자와 같았다"는 그 mutant가 살아남는다는 근거가 되지 못한다.
- `CallStatement`는 값을 쓰지 않으니 기록할 값이 없다. 무엇이 달라지는지는 부수 효과에 있다.
- 정규식은 값으로 비교할 수 없다. 리터럴이 만드는 것은 객체이고, 결과는 그 객체를 쓰는 곳(`test`, `replace`, `split`)에서 달라진다.

**비용.** 이 저장소의 HEAD `src`(14개 파일, 2987줄)의 모든 줄을 바뀐 것으로 치고 `generate()`를 돌렸다(측정 스크립트는 커밋하지 않았다).
- mutant가 1404개에서 2096개로 692개(49%) 늘었다. `CallUnwrap` 477개, `CallStatement` 196개, `Regex` 19개다.
- `generate()` 전체는 중앙값 1.7~1.8초에서 2.4~2.5초가 됐다. 늘어난 mutant 하나에 약 1ms로, 대부분 TCE가 mutant마다 파일을 압축하는 비용이다.
- 실제 PR에서는 바뀐 범위를 담은 호출 수에 비례한다. 늘어나는 비용의 대부분은 mutant 실행이다.
- 메서드 규칙을 바꾼 뒤 지금의 `src`(16개 파일, 3876줄)로 같은 측정을 하면 `CallUnwrap`은 664개에서 510개가 된다. 첫 인자가 395개, receiver가 115개다. 빠진 것은 대부분 조회와 조건(`get`, `has`, `charCodeAt`, `startsWith`, `test`, `join`)이고, 기본 import한 `path`의 함수(`path.dirname(f)` 등 14개)도 빠졌다.

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
├─ git.ts                merge-base, git diff → 바뀐 줄, hunk, 옛 blob
├─ diff.ts               hunk 안의 토큰 diff → 바뀐 범위, 지점이 담은 바뀐 범위
├─ mutate/generate.ts    oxc-parser AST 순회(visitorKeys, ScopeTracker) → 지점과 mutant, L1 휴리스틱, L2 억제 주석, 타입에 물을 것(typeQuestions)
├─ mutate/equivalent.ts  L1 TCE: oxc-transform + oxc-minify 결과가 원본과 같은 mutant를 버림
├─ mutate/typecheck.ts   TypeScript 7 API 어댑터: 생성 전에 `+`가 문자열 연결인지, `?.`·`??`가 지키는 값이 null이 될 수 없는지 타입으로 미리 답함
├─ mutate/infer.ts       문자열 `+`의 문법 규칙: 식이 문자열인 것이 확실한지 AST와 스코프로 답함
├─ mutate/regex.ts       정규식 리터럴의 mutant: 패턴 훑기, `new RegExp`로 컴파일 확인
├─ mutate/instrument.ts  schemata 삽입, probe 삽입(profiled), 소스맵, 계측 결과 파싱 확인
├─ mutate/profile.ts     probe 기록의 형식과 판정 규칙: 살아남는 것이 확실한 mutant, 문자열 `+`, 타입으로 불필요한 `?.`·`??`
├─ run.ts                오케스트레이션: 세션 관리, 타입 미리 묻기, 기준 실행, mutant별 실행, 판정
├─ session.ts            별도 프로세스에서 Vitest Node API 실행 (플러그인, setup 파일, provide)
├─ vitest.ts             프로젝트가 쓰는 Vitest 찾기 (Vite+ 포함)
├─ protocol.ts           CLI ↔ 세션 IPC 메시지
└─ report.ts             텍스트, GitHub 어노테이션, step summary
action.yml               composite action: 런타임 의존성만 설치하고 커밋된 dist/cli.js 실행
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

### Action 패키징

Action은 저장소를 받은 그대로 실행된다. 그래서 `dist/`를 커밋하고, Action은 `npm ci --omit=dev --ignore-scripts`로 런타임 의존성만 설치한다.

- 전에는 devDependencies(Vitest, happy-dom 등)까지 받고 `prepare`로 `tsc` 빌드를 했다. 실제 실행에서 4~15초인 nyorori 단계 중 2.4~6.6초가 이 설치와 빌드였다. 빈 npm 캐시로 재면 설치가 4.7초에서 1.8초로 줄었다(각각 8번의 중앙값).
- 런타임 의존성에는 설치 스크립트가 없다. oxc와 TypeScript의 네이티브 바이너리는 플랫폼별 optional 패키지로 미리 빌드되어 있다.
- 번들하지 않는다. rolldown으로 묶어 봐도 CLI 시작이 10ms쯤 빨라질 뿐이었고, 설치 시간 차이는 네트워크 편차 안이었다. 설치 시간의 대부분은 어차피 외부에 두어야 하는 네이티브 패키지다(TypeScript 바이너리만 28MB). `tsc` 출력은 `src/`의 구조를 따르므로, CLI가 경로로 fork하는 `session.js`도 `cli.js` 옆에 있다.
- `node_modules`를 `actions/cache`로 캐시하지 않는다. npm 캐시가 차 있어도 설치는 1.4초로 0.5초쯤 빨라질 뿐인데, 캐시를 받아 푸는 시간(gzip으로 23MB)과 캐시가 없을 때 올리는 시간이 든다. `hashFiles()`가 workspace 밖에 있는 Action의 lockfile을 읽지 못하므로 키도 따로 만들어야 한다.
- `prepare`는 없앴다. clone에도 `dist/`가 있고 테스트는 `src/`를 직접 실행한다. 남겨 두면 `npm ci`가 커밋된 파일을 다시 쓴다.
- CI는 `dist/`를 다시 빌드해서 커밋된 것과 다르면 실패한다. `npm run build`는 `dist/`를 지우고 다시 만든다. `tsc` 출력에는 시각이나 절대 경로가 없어서 몇 번을 빌드해도 같다.

### 타입 정보 (TypeScript 7 API)

`a.name + b.title`처럼 멤버나 반환값끼리 잇는 `+`가 문자열 연결인지는 문법만으로 알 수 없다. 그래서 문법 규칙이 모르는 `+`는 TypeScript에 타입을 묻는다(L1 참고).
TS 파일에서는 `?.`와 `??`가 지키는 값이 null이나 undefined가 될 수 없는지도 같이 묻는다("타입으로 불필요한 방어 코드" 참고).
TypeScript 7은 Go로 다시 쓴 컴파일러이고, 별도 프로세스와 IPC로 통신하는 API를 `typescript/async`와 `typescript/sync`로 제공한다. 7.1에서 `unstable/` 접두어가 빠졌다.
nyorori는 비동기 API를 쓴다. 동기 API는 응답을 기다리는 동안 이벤트 루프를 막으므로 시간 제한을 걸 수 없다.

- **설치.** `typescript@7.1.0-beta`를 `dependencies`에 정확히 고정한다.
  - nyorori 자신을 빌드하는 `tsc`도 이 패키지라서 버전은 하나다.
  - JS 패키지는 모든 플랫폼에 설치되고, 네이티브 바이너리는 `@typescript/typescript-<플랫폼>-<아키텍처>` optional 패키지에 따로 있다. 21개 플랫폼(win32 x64/arm64, darwin x64/arm64, linux x64/arm64/arm 등)용이 있고, `npm ci`는 맞는 것 하나만 받는다.
  - 바이너리 패키지가 없으면(지원하지 않는 플랫폼, 다른 플랫폼에서 만든 `node_modules`) 첫 요청이 `Unable to resolve @typescript/typescript-linux-x64. …`로 실패하고 문법 규칙으로 돌아간다. 바이너리 패키지를 지운 `npm ci` 결과로 확인했다.
  - `npm ci --omit=optional`로는 nyorori를 쓸 수 없다. oxc의 바인딩이 optional이고, 빌드에 쓰는 `tsc`도 바로 그 네이티브 바이너리다. typescript@7.0.2를 쓰던 이전에도 같았다.
- **미리 묻기.** mutant 생성(`generate()`)은 동기이고 API는 비동기다. 그래서 `run.ts`가 생성 전에 물을 것을 모아 한 번에 묻고, `generate()`는 답을 맵에서 찾기만 한다.
  - 물을 것은 `typeQuestions()`가 모은다. `generate()`의 계획 단계(파싱, 스코프 순회, 지점 수집)를 그대로 돌리면서 타입을 기록만 하는 오라클을 넘긴다. 그래서 묻는 `+`는 생성이 실제로 묻게 될 것과 정확히 같다. 범위 안에 있고, 변형하는 코드(함수 안, 로그 호출의 인자 밖)에 있고, 문법 규칙이 문자열로 정하지 못한 `+`다.
  - 파싱과 순회를 한 번 더 하는 비용은 626줄 파일 전체를 바뀐 것으로 쳤을 때 25~40ms였다. TCE는 하지 않는다.
  - `?.`와 `??`는 `FileQuestions.guarded`로 같은 배치에 묻는다. 생성이 프로파일 규칙을 붙이는 mutant가 지키는 값이다. 멤버 `a?.b`의 `a`, 호출 probe를 넣을 수 있는 `f?.()`의 `f`, `a ?? b`의 `a`다. 이것도 mutant가 생기는 곳, 곧 바뀐 범위를 담은 지점에서만 묻는다.
  - JavaScript 파일의 `guarded`는 버린다. TypeScript가 JavaScript에서 추론한 타입은 null에 대해 믿을 수 없기 때문이다.
- **지연 시작.** 물을 것(`+`, TS 파일의 `?.`·`??`)이 있는 파일이 있을 때만 모듈을 읽고 프로세스를 띄운다. 그래서 `+`가 없어도 `?.`가 바뀐 TS 파일이 있으면 TypeScript가 뜬다.
  - 파일 위쪽 디렉터리 어디에도 `tsconfig.json`이나 `jsconfig.json`이 없으면 TypeScript를 띄우지 않는다. 그런 파일은 inferred 프로젝트로 갈 수밖에 없어서 어차피 타입을 쓰지 않는다. express, undici, fastify에서는 그래서 TypeScript가 뜨지 않는다.
- **프로젝트 찾기.** 파일마다 snapshot을 `openFiles: [file]`로 갱신하고 `getDefaultProjectForFile`로 프로젝트를 받는다.
  - 편집기가 파일을 열 때처럼 TypeScript가 위쪽 디렉터리에서 그 파일을 포함하는 `tsconfig.json`(없으면 `jsconfig.json`)을 찾고, `references`도 따라간다. Vite 템플릿처럼 루트 `tsconfig.json`이 `files: []`와 references만 가진 경우에도 `tsconfig.app.json`을 찾는다.
  - 한 번 읽은 프로젝트는 다시 쓴다. 같은 프로젝트의 두 번째 파일은 몇 ms면 열린다.
  - 어느 config에도 속하지 않는 파일은 기본 옵션의 inferred 프로젝트(`configFileName`이 없음)로 간다. 이것은 타입 정보가 없는 것으로 친다. 아무 프로젝트도 이 파일을 검사하지 않으므로 타입 주석도 검사된 적이 없다.
- **JavaScript.** 프로젝트가 JavaScript를 TypeScript만큼 엄격하게 검사할 때만 답을 쓴다. `checkJs: true`이고, `noImplicitAny`가 켜져 있거나(`strict: true` 포함) 하는 경우다(아래 "JavaScript에서의 타입" 참고).
  - `getCompilerOptions()`는 config에 쓰인 그대로의 옵션을 준다. TypeScript 7은 `strict`의 기본값이 켜짐이지만, 프로젝트가 CI에서 쓰는 것은 더 오래된 TypeScript일 수 있으므로 기본값으로는 치지 않는다.
  - JavaScript 파일이 타입 없이 판단되는 것은 보통이므로 `untyped`에 넣지 않는다. 아무 파일도 타입을 쓰지 못했을 때만 `reason`에 그 이유가 남는다.
- **질의.** oxc-parser와 TypeScript의 위치는 둘 다 UTF-16 오프셋이라 그대로 쓴다. 한글이나 BMP 밖의 문자가 앞에 있어도 맞는 것을 확인했다.
  - 피연산자 첫 토큰의 위치로 타입을 물으면 틀린다. `name.length + 1`에서는 `name`(문자열)을, `n.toFixed(1) + n`에서는 `n`(숫자)을 보게 된다.
  - 그래서 `program.getSourceFile`로 받은 AST에서 `getTokenAtPosition(sourceFile, left.end)`로 `+` 토큰을 찾고, 그 부모인 `BinaryExpression` 노드 자체를 묻는다. 왼쪽 피연산자가 끝나는 곳에서 `+` 토큰의 leading trivia가 시작하기 때문이다.
  - 두 피연산자의 끝 위치가 oxc의 것과 다르면 묻지 않는다. 예를 들어 BOM이 있는 파일은 TypeScript가 BOM을 빼고 읽으므로 한 칸씩 어긋나고, 문법 규칙으로 돌아간다.
  - 파일 하나의 모든 `+`에 대해 식 전체와 두 피연산자의 타입을 `checker.getTypeAtLocation`으로 한 번에 묻는다. 결과가 `any`일 때만 union의 구성원을 한 번 더 묻는다. 이것도 클라이언트가 한 요청으로 묶는다.
  - `?.`·`??`가 지키는 값도 `+`와 같은 방법으로 찾는다. 값이 끝나는 곳의 토큰이 `?.`(부모는 속성 접근, 원소 접근, 호출)나 `??`(부모는 `BinaryExpression`)이고, 부모의 `expression`이나 `left`가 그 값이다. 끝 위치가 oxc의 것과 다르면 묻지 않는다.
  - 그 노드들을 `+`의 노드 뒤에 이어 붙여 같은 `getTypeAtLocation` 한 번으로 묻는다. 값이 속성 접근(`a.b`)이면 이름의 `getSymbolAtLocation`도 같은 틱에 보낸다. 클라이언트는 한 틱 안의 요청을 `batchRequests` 하나로 묶으므로 왕복은 한 번이다.
  - 두 번째 왕복에서 union과 intersection의 구성원(`getTypes`)과 보고에 쓸 타입 이름(`typeToString`)을 같이 묻는다. `+`의 결과가 `any`일 때 묻는 피연산자의 구성원도 이때 묻는다. 그래서 파일 하나에 왕복은 많아야 두 번이다. 왼쪽 피연산자에 문자열이 없으면 오른쪽 피연산자를 한 번 더 묻는 것은 이전과 같다.
  - `strictNullChecks`는 config에 쓰인 대로만 친다(`strictNullChecks ?? strict ?? false`). 꺼져 있으면 `?.`·`??`는 묻지 않는다.
    - TypeScript 7.1은 둘 다 쓰지 않은 config를 `strictNullChecks`가 켜진 것으로 검사한다. `tsc`가 `string | undefined`인 값에 TS18048을 내고, API도 그 값의 타입을 `string | undefined`로 답했다. 그러나 `getCompilerOptions()`는 `{}`를 준다. `extends`로 받은 `strict: true`는 준다.
    - `strict: false`나 `strictNullChecks: false`에서는 `string | undefined`라고 쓴 매개변수의 타입도 `string`이다. 타입이 null을 담지 않으므로 아무것도 배제하지 못한다.
    - 프로젝트가 CI에서 쓰는 TypeScript는 더 오래되어 기본값이 꺼짐일 수 있다. 그런 프로젝트에서는 호출하는 쪽이 null을 넘겨도 아무 오류가 없다. 그래서 JavaScript의 `strict`처럼 기본값은 치지 않는다.
- **시간 제한.** 모든 요청을 타이머와 경주시킨다. 플래그가 아니라 상수다.
  - 모듈 읽기, 프로세스 시작과 첫 snapshot: 30초. 파일 열기(프로젝트 읽기): 30초. 그 밖의 요청 하나(프로젝트 조회, AST, 타입 배치): 5초. 정상 종료: 2초.
  - 프로세스가 스스로 끝나도 진행 중인 요청을 바로 실패시킨다. JSON-RPC 계층은 연결이 끊겨도 대기 중인 요청을 거절하지 않기 때문이다.
  - 시간을 넘기거나, 오류가 나거나, 프로세스가 끝나면 그 뒤로 TypeScript에 묻지 않고, 프로세스를 죽이고, 남은 파일은 모두 문법 규칙으로 판단한다. 이유는 보고서에 남긴다. 한 번 틀린 beta API의 그 뒤 답은 믿지 않는다.
  - 답하지 않는 가짜 API를 넣은 테스트로, CLI가 5초 제한 뒤에 문법 규칙으로 끝까지 실행되는 것을 확인한다(`test/e2e.test.ts`). 단위 테스트는 시작과 파일 열기에서 멈추는 가짜 API, 입력을 읽기만 하고 답하지 않는 프로세스를 쓴다(`test/typecheck.test.ts`).
- **프로세스 수명.** 생성 전에 묻기가 끝나면 프로세스를 끝낸다. 그래서 Vitest가 테스트를 돌리는 동안에는 떠 있지 않다.
  - 클라이언트는 첫 요청 때 프로세스를 띄우고 그 `ChildProcess`를 내놓지 않는다. 그런데 `close()`는 snapshot을 놓아 주는 요청을 먼저 보내고 나서야 표준 입력을 닫는다. 멈춘 프로세스에서는 이 요청이 끝나지 않으므로 `close()`로는 끝낼 수 없다.
  - 그래서 Node가 만드는 모든 자식 프로세스를 알리는 diagnostics channel `child_process`를 시작하는 동안만 구독해서 그 프로세스를 잡는다. 인자에 `--api`가 있는 것이다.
  - 정상일 때는 `close()`를 2초 안에 기다린 뒤 SIGKILL한다. 실패했을 때는 `close()`를 부르지 않고 바로 SIGKILL한다. 멈췄거나 끝난 프로세스에 요청을 더 보내지 않으려는 것이다.
  - 채널로 프로세스를 잡지 못하면 죽일 수 없다. 그래도 CLI는 끝난다. CLI가 끝나며 파이프가 닫히면 멈추지 않은 프로세스는 스스로 끝난다.
  - 바이너리가 없거나(ENOENT) 실행할 수 없는(EACCES) 경우는 클라이언트가 첫 요청의 실패로 알린다. tsrs 때처럼 내부 필드에 리스너를 달 필요가 없다.
- **처리되지 않은 rejection.** 클라이언트가 쓰는 JSON-RPC 계층(`vscode-jsonrpc`)은 쓰기에 실패한 요청을 거절하고 나서, async Promise executor 안에서 같은 오류를 다시 던진다. 그래서 끝난 프로세스에 보낸 요청마다 처리되지 않은 rejection이 하나씩 남고, Node의 기본 동작으로는 CLI가 exit 1(발견 있음)로 죽는다.
  - 시작 직후 끝나는 바이너리로 재현했다. 10번 모두 exit 1로 죽었다. 아래 리스너를 단 뒤로는 10번 모두 끝까지 돌았다.
  - 그래서 TypeScript에 보낸 요청이 모두 끝날 때까지 `unhandledRejection` 리스너를 단다. 쓰기 실패(`EPIPE`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`)만 무시한다. 요청 자체도 거절되므로 그것으로 문법 규칙으로 돌아간다.
  - 다른 rejection은 그대로 다시 던진다. 다른 리스너가 없을 때 Node가 하는 일과 같다.
  - Vitest는 자기 리스너를 달기 때문에 이것을 볼 수 없다. 그래서 테스트는 별도의 Node 프로세스에서 확인한다.
- **보고.**
  - `--json`의 `types`에 `{ backend: 'typescript', files, untyped }` 또는 `{ backend: 'none', reason, untyped }`를 남긴다. `files`는 타입으로 답한 파일 수(`?.`·`??`만 물은 파일 포함)이고, `untyped`는 범위 안에 물을 `+`가 있는데 타입 없이 판단한 TS 파일과 그 이유다.
  - `?.`·`??`만 물은 파일은 타입 없이 판단해도 `untyped`에 넣지 않는다. 그 판정은 이 기능 전과 같기 때문이다. 아무 파일도 타입을 쓰지 못했을 때의 `reason`에는 들어간다.
  - 그런 TS 파일이 있을 때만 텍스트 출력에 한 줄을 쓴다. 문법 규칙이 가리지 못한 문자열 `+`가 왜 변형됐는지 알 수 있게 하려는 것이다.
  - `--no-types`로 끄면 TypeScript를 읽지 않고, 이 줄도 쓰지 않는다.
  - step summary와 어노테이션은 바꾸지 않는다.
- **비용.** 이 저장소의 `src/mutate/generate.ts`(626줄, 바뀐 줄로 친 파일 전체, 물을 `+` 14개, 프로그램 파일 약 290개)를 기준으로 쟀다.
  - 물을 것 모으기 25~40ms, 모듈 읽기 약 90ms, 프로세스 시작과 첫 snapshot 약 30ms, 프로젝트 읽기 250~280ms, AST 받기 약 10ms, 타입 배치 한 번 17~29ms, 종료 4~10ms였다.
  - CLI `--dry-run` 전체로는 중앙값 1.62초에서 2.20초로, 실행 한 번에 약 0.55초가 늘었다. tsrs는 같은 측정(그때 467줄)에서 1.09초에서 1.36초로 0.2~0.3초가 늘었다. 차이는 대부분 프로젝트 읽기다. tsrs는 같은 프로젝트를 약 70ms에 읽었다. 그래도 mutant 실행 시간에 비하면 작다.
  - `tsconfig.json`이 있지만 JavaScript를 포함하지 않는 JavaScript 저장소(axios)에서는 TypeScript를 띄우고 나서야 inferred 프로젝트임을 안다. `lib/`의 72개 파일을 모두 바뀐 것으로 치면 0.5초가 들고 답은 하나도 쓰지 않는다.
  - `?.`·`??`를 더 묻는 비용은 작다. 이 저장소의 `src/mutate/generate.ts`, `src/run.ts`, `src/report.ts`, `src/mutate/typecheck.ts`를 모두 바뀐 것으로 치면(`+` 22개, 지키는 값 29개) 묻기 전체가 중앙값 342ms에서 351ms가 됐다. 늘어나는 것은 `+`가 없는 TS 파일에서 TypeScript를 띄우는 비용(이 저장소에서 약 0.5초)이다.

#### JavaScript에서의 타입

inferred 프로젝트(config가 없는 JavaScript)에서도 TypeScript 7은 `allowJs`로 JavaScript를 읽고 초기값과 JSDoc으로 타입을 추론한다. 이 답을 문자열 `+`에 써도 되는지 세 가지로 확인했다. 측정 스크립트는 커밋하지 않았다.

1. **실제 JavaScript 저장소.** express, axios, undici, fastify의 `lib/`에서, 문법 규칙이 모르는 `+`(생성이 묻는 것) 중 TypeScript가 문자열이라고 답한 것을 손으로 확인했다.

   | 저장소 | `+` | 문법이 모르는 것 | 그중 TypeScript가 문자열 | JSDoc을 지우면 |
   |---|---|---|---|---|
   | express | 40 | 6 | 0 | 0 |
   | axios | 209 | 53 | 4 | 4 |
   | undici | 285 | 265 | 6 | 5 |
   | fastify | 87 | 10 | 0 | 0 |

   - 코드를 읽어 보니 10개 모두 늘 문자열이다. `URL`의 `pathname + search`(lib 타입) 5개, 정규식 `exec` 결과로 초기화한 `const` 2개, 문자열 배열 리터럴의 `forEach` 매개변수, 다른 모듈의 문자열 상수, JSDoc 매개변수였다.
   - 얻는 것은 전체 `+` 621개 중 10개(1.6%), 문법이 모르는 334개 중 3%다. 그중 테스트가 실행하는 것은 기준 실행의 프로파일로도 건너뛴다.
2. **TypeScript 주석이 있는 정답.** hono와 nyorori의 TS 소스에서 `node:module`의 `stripTypeScriptTypes`로 타입만 지워(위치는 그대로) JavaScript를 만들었다. 이것을 inferred 프로젝트로 읽은 답을, 원래 TS를 tsconfig로 읽은 답과 비교했다.
   - hono: 문법이 모르는 `+` 74개 중 TypeScript가 JavaScript에서 문자열이라고 한 것은 2개이고, 둘 다 TS 정답도 문자열이었다. 숫자 36개도 모두 맞았다. 나머지 36개는 "모름"이었다. nyorori: 문자열이라는 답은 없었고, 숫자 10개가 모두 맞았다.
3. **틀리는 경우를 찾는 예제.** 실행하면 숫자가 되는데 TypeScript가 문자열이라고 답하는 JavaScript를 만들었다. 다음 8가지 모두 inferred 프로젝트에서 문자열이라는 답이 나왔다.
   - 모듈의 `let s = ''`를 다른 함수가 숫자로 바꾼 뒤의 `s + n`
   - 기본값이 문자열인 매개변수(`f(s = '')`, 구조 분해 기본값 포함)에 숫자를 넘긴 호출
   - 생성자에서 `this.text = ''`로 초기화하고 다른 메서드에서 숫자를 넣은 필드
   - `{ prefix: '' }` 객체의 속성, `['a']` 배열에 나중에 넣은 숫자
   - JSDoc `@param {string}`인 매개변수에 숫자를 넘긴 호출
   - `var v = ''` 뒤에 `any`인 값을 대입한 `v`
   - `checkJs`만 켜고 `noImplicitAny`를 끈 프로젝트에서도 같았고, `tsc`는 아무 오류도 내지 않았다. 매개변수가 `any`라서 어떤 대입도 허용되기 때문이다.
   - `checkJs`와 `strict`를 켜면 타입 없는 매개변수가 오류가 되므로 JSDoc 타입을 달게 된다. 그러면 7가지가 타입 오류(TS2322, TS2345)가 된다. 남은 하나는 `any`라고 밝힌 값을 대입하는 경우로, TS 파일에도 같은 구멍이 있다(아래 문법 규칙의 "가정"). 그래서 이때는 TS 파일과 같은 정도로 답을 믿을 수 있다.

그래서 JavaScript는 `checkJs`와 `noImplicitAny`(또는 `strict`)를 켠 프로젝트에서만 타입을 쓴다. 위 네 저장소는 이 조건에 맞지 않아 얻는 것이 없다. 실제 코드에서 틀린 답은 찾지 못했지만, 틀리는 방식이 흔한 JavaScript 패턴이고, 얻는 것(1.6%)이 작기 때문이다.
어느 tsconfig에도 속하지 않는 TS 파일도 같은 이유로 타입을 쓰지 않는다. 그 주석을 검사하는 프로젝트가 없다.

## 실행 시간 프로파일링

기준 실행에서는 모든 지점이 원본 분기를 지난다. 그래서 원본 분기에 probe를 넣으면 테스트에서 어떤 값이 그 지점을 지나갔는지 알 수 있다.
기록된 모든 평가에서 원본과 같게 동작하는 mutant는, 켜도 테스트가 원본과 똑같이 실행된다. 그래서 실행하지 않아도 살아남는다는 것을 안다.
이런 mutant는 실행하지 않고 이유와 함께 Survived로 보고한다(`src/mutate/profile.ts`).

### 관찰되지 않음 ≠ 불가능

- 프로파일은 테스트가 한 일만 알려 준다. "어떤 테스트도 `user`를 null로 만들지 않는다"는 "`user`는 null이 될 수 없다"와 다르다.
- 그래서 프로파일로 mutant를 버리지 않는다. 살아남는다고 판정하고 CI를 실패시킨다. 테스트를 돌렸어도 결과는 같았을 것이고, 프로파일은 실행을 건너뛰고 이유를 알려 줄 뿐이다.
- 코드가 그 값을 정말 받을 수 없어서 equivalent인지는 사람이 판단한다. 그렇다면 억제 주석을 쓴다.
- 예외는 TypeScript 타입도 null이 될 수 없다고 하는 `?.`·`??`다. 그런 mutant는 실패시키지 않고 목록으로 보여 준다("타입으로 불필요한 방어 코드" 참고). 타입과 테스트가 같은 말을 하는 곳이라서, 사람이 볼 것은 "테스트가 빠졌는가"가 아니라 "이 방어 코드가 필요한가"다.
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
- `CallUnwrap`, `CallStatement`, `Regex`에는 규칙이 없다. 호출은 인자를 그대로 돌려주어도 부수 효과가 있을 수 있다("호출과 정규식" 참고).
- OptionalChaining과 `??`의 규칙에는 TypeScript가 답한 값의 타입(`type`)이 붙을 수 있다. 그 값이 null이나 undefined가 될 수 없을 때다. 그러면 같은 조건에서 Survived 대신 unnecessary로 판정하고, 이유를 `` `user` is `User` by its type, which can't be null or undefined, and no test passed null or undefined``로 쓴다. 테스트가 null을 넣었으면 타입과 상관없이 실행한다(`predict()`의 `neverNullish`).
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
- 문자열 `+`: 기록된 모든 평가에 문자열 피연산자(빈 문자열 포함)가 있었으면 `+`→`-` mutant를 실행하지 않는다. 문자열 피연산자가 없는 평가가 하나라도 있으면 그대로 실행한다. 실행되지 않은 `+`는 NoCoverage다. 생성 단계의 규칙(리터럴과 문법 규칙, TypeScript)이 먼저 적용된다.

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
- 예측하지 않은 Survived와 NoCoverage에도 `--json`에서 `reason`이 붙는다. 텍스트 출력과 같은 말, `every test still passes with this change`와 `no test runs this code`다. 그래서 `--json`만 읽어도 실패한 mutant마다 이유가 있다. 실행한 결과가 Survived라도 프로파일의 이유가 있으면(`--no-predict`) 그 이유를 둔다. 어노테이션은 전과 같다. dry run은 판정하지 않으므로 붙이지 않는다.
- 문자열 `+`로 건너뛴 mutant는 `--json`의 `skipped`에 이유와 함께 남는다. 텍스트와 step summary에는 `N mutants skipped: string concatenation in every observed evaluation` 한 줄만 쓴다. 어노테이션은 만들지 않고 exit code에도 영향이 없다.
- unnecessary는 `--json`의 `unnecessary`에 남는다. 보고 방식은 "타입으로 불필요한 방어 코드"의 "보고"를 본다.
- 억제 주석
  - 예측한 mutant를 억제하면 실행하지 않고 Ignored가 된다. 살아남는 것이 확실하므로 "불필요한 억제"가 아니다.
  - 이 PR이 추가한 억제가 건너뛴 `+`만 가리키면, TCE와 마찬가지로 해당 mutant가 없다는 문제로 보고된다.
- `--no-predict`는 예측한 mutant도 실행한다. 이유(`reason`)는 그대로 남는다. unnecessary도 실행한다.
  - 살아남지 않은 mutant에는 실제 판정을 `mispredicted`로 남기고, 텍스트에 `MISPREDICT` 줄을, step summary에 "Wrong predictions"를 쓴다. exit code는 바꾸지 않는다. unnecessary는 `unnecessary` 목록에 그대로 두고 `(unnecessary by types: …; Killed when run)`처럼 쓴다.
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

- 로그 호출이면 인자 안쪽은 건너뛴다. 그 호출 자체에도 `CallUnwrap`과 `CallStatement`를 만들지 않는다(로그 필터). 로그는 코드가 하는 일이 아니라 그 기록이어서, 살아남아도 테스트를 더할 일이 드물다. 근거는 아래 "로그 필터의 측정"에 있다.
  - 전역 `console`의 `console.*` 호출
    - 둘러싼 스코프 어디에서든 `console`을 선언했으면 그것은 코드 자신의 객체이므로 건너뛰지 않는다. 매개변수, 지역 변수, `catch` 매개변수, `import console from './logger'` 등이 그렇다.
    - `ScopeTracker`는 순회가 선언에 닿을 때 이름을 기록한다. 그래서 AST를 한 번 돌며 선언을 먼저 모으고, 두 번째 순회에서 mutant를 만든다. 이렇게 해야 쓰는 곳보다 아래에 있는 선언도 보인다. 호이스팅되는 `var`와 함수, 파일 아래쪽에서 정의한 모듈 상수가 그런 예다.
    - `declare const console: …` 같은 ambient 선언은 런타임에 아무것도 만들지 않으므로 선언으로 치지 않는다. 그 `console`은 여전히 전역이다. `import type`도 마찬가지다.
    - 이름으로만 판단하므로, sloppy mode 스크립트에서 블록 안의 함수 선언이 바깥으로 호이스팅되는 경우(Annex B)는 보지 못한다. 이때는 전역으로 보고 건너뛰므로 mutant를 놓치는 쪽으로만 틀린다.
  - 로거 이름에 부른 로그 레벨 메서드: `logger.warn(…)`, `this.logger.log(…)`, `ctx.log.error(…)`
    - 로거 이름은 receiver의 마지막 이름(식별자, 또는 계산하지 않는 속성 이름)이다. `log`나 `logger`(앞에 `_`가 붙어도 된다)이거나 `Logger`로 끝나야 한다: `this._logger`, `this.#logger`, `baseLogger`. `auditLog`, `changelog`처럼 `log`로 끝나기만 하는 이름은 아니다. 그런 기록은 코드가 남기려는 것일 때가 많다.
    - 메서드는 로그 레벨만이다: `trace`, `debug`, `verbose`, `silly`, `info`, `log`, `notice`, `warn`, `warning`, `deprecate`, `error`, `critical`, `fatal`. 로거의 다른 메서드는 일을 한다. i18next의 `baseLogger.create('translator')`(6곳)는 로거를 만들고, `baseLogger.init(…)`(2곳)는 설정하고, `clone.logger.clone(options)`는 복사한다.
    - 레벨 이름만으로는 고르지 않는다. 다른 객체의 같은 이름 메서드는 일을 한다. Rollup 플러그인의 `this.error(…)`는 throw하고, PostCSS의 `result.warn(…)`은 결과에 경고를 더하고, Node의 `util.deprecate(f, msg)`는 `f`를 감싼 함수를 돌려준다.
    - 스코프는 보지 않는다. 매개변수나 import로 받은 `logger`도 로거다. `log`라는 이름의 다른 값은 로그 레벨 메서드가 없어서 그대로 변형한다. i18next 테스트의 `this.entries.log.push(x)`가 그렇다(로그를 모으는 배열). 설치된 패키지에서 찾은 `log.<레벨>(…)` 호출(npmlog, ESLint, yaml, Octokit의 `log || console`)은 모두 로거였다.
    - `console`처럼 값을 쓰는 호출(`return logger.warn(…)`)도 건너뛴다.
    - `this.logger?.warn(x)`의 `?.`는 변형한다. 로거가 없을 때 throw하지 않게 하는, 코드가 하는 일이다.
  - 값을 버리는 메트릭·트레이싱 호출 문: `metrics.increment('hits')`, `await this.statsd.timing('load', ms)`
    - receiver의 마지막 이름이 `metrics`, `statsd`, `telemetry`, `tracer`(앞에 `_`가 붙어도 된다)이거나 `Metrics`, `Telemetry`, `Tracer`로 끝나고, 메서드가 `increment`, `decrement`, `gauge`, `histogram`, `timing`, `distribution`, `record`, `addEvent`, `setAttribute`, `setAttributes`, `setStatus`, `recordException`인 것이다.
    - 값을 쓰는 호출(`return metrics.increment(x)`)은 변형한다. 그 값은 코드가 쓰는 것이다.
    - 근거는 Google 논문이 "모니터링 시스템의 값 증가"를 바람직하지 않은 테스트 목표의 예로 든 것뿐이다(TSE §3.2.3). 트레이싱(`tracer`, `recordException` 등)과 메서드 이름 목록은 논문에 없고 우리가 정했다. es-toolkit과 i18next에는 이런 호출이 없어서 여기서는 확인하지 못했다. 그래서 좁게 잡았다. `span`은 DOM 요소일 때도 많아서(`span.setAttribute('class', c)`) 넣지 않았다. `counter`, `stats`도 같은 이유로 뺐다.
  - 로그만 하는 `if`는 조건까지 통째로 건너뛴다. `if (err) this.logger.warn(…)`의 `err`도 변형하지 않는다. 그 조건은 로그를 남길지만 정한다.
    - Google의 정의를 따른다. 자식이 모두 arid인 복합 노드는 arid다. 그래서 두 갈래(`else`가 없으면 한 갈래)가 arid한 문만 담은 `if`를 건너뛴다. arid한 문은 로그 필터가 아무 mutant도 남기지 않는 문(위의 로그 호출 문과 메트릭 호출 문), 빈 블록과 빈 문, 그리고 arid한 `if`다. `else if`로 이어진 `if`도 그렇다.
    - 문으로 쓴 같은 조건도 건너뛴다: `err && logger.warn(…)`, `c ? logger.warn(a) : logger.info(b)`.
    - `this.logger?.warn(…)`을 담은 `if`는 건너뛰지 않는다. 그 `?.`는 위처럼 코드가 하는 일이다. `return`이나 다른 호출을 같이 하는 갈래가 있어도 건너뛰지 않는다(`if (a) { logger.warn(a); return }`).
    - 조건의 부수 효과는 보지 않는다. `if ((m = re.exec(s)) === null) logger.warn(…)`도 건너뛰므로, 대입을 건너뛰는 `→ true`를 놓친다. es-toolkit과 i18next의 `src`에는 그런 조건이 없었다.
    - `if`와 식 문만이다. 로그만 하는 함수의 FunctionBody는 그대로 만든다.
- `!!x`에서는 바깥 `!`만 변형한다. 안쪽을 빼도 결과가 같은 `!x`이기 때문이다.
- `x.length >= 0` 같은 항상 참인 조건은 `true`로 바꾸지 않는다.
- 조건이 이미 `true`/`false` 리터럴이면 Condition mutant를 만들지 않는다. BooleanLiteral mutant와 겹치기 때문이다.
- 같은 지점의 mutant끼리 대체 텍스트가 같으면 하나만 만든다. `if (check(true))`의 CallUnwrap `→ true`는 Condition `→ true`와 같다.
- `CallUnwrap`은 첫 인자가 콜백인 함수 호출, 변환이 아닌 메서드 호출, 바로 읽고 버리는 사본(`xs.slice().map(f)`), `.call`/`.apply`/`.bind`, 다른 호출의 callee인 호출, 값을 버리는 호출 문, 둘레의 코드가 어차피 하는 변환(`if (Boolean(x))`, `` `${String(x)}` ``, `await Promise.resolve(x)`)은 만들지 않는다. `CallStatement`는 `super(…)`를 지우지 않는다("호출과 정규식" 참고).
- `Regex`는 `^`·`$`가 없는 패턴의 `m`, `.`가 없는 패턴의 `s`를 빼지 않는다. 빼도 같은 정규식이다. 컴파일되지 않는 mutant도 만들지 않는다.
- `x * 1`, `x / 1`, `x * 1n`, `x / 1n`은 `*`↔`/` 변형을 만들지 않는다.
  - bigint에서도 `x * 1n`과 `x / 1n`은 같은 값이다. `x`가 bigint가 아니면 둘 다 같은 메시지의 TypeError를 던진다(Symbol이면 `Cannot convert a Symbol value to a number`, 그 밖에는 `Cannot mix BigInt and other types, use explicit conversions`). 0n, 음수, 2^100 크기의 bigint, 수, `-0`, NaN, 문자열, null, undefined, boolean, 객체, bigint를 주는 `valueOf`, Symbol, `Object(3n)`의 21가지로 확인했다. `valueOf`도 양쪽에서 한 번씩 불린다.
  - 리터럴의 값으로 비교하므로 `0x1n`도 같다.
- 문자열 연결 `+`는 변형하지 않는다. 문자열 변형은 2차로 미뤘다. 범위 안의 `+`는 다음 순서로 판단한다.
  1. 문법 규칙(아래)이 피연산자 하나가 문자열인 것이 확실하다고 하면 문자열 연결이다. 리터럴(`"a" + x`)이 여기에 든다. 타입 검사기도 달리 답할 수 없으므로 TypeScript에 묻지 않는다.
     - 이전에는 tsrs가 먼저 답하고 문법 규칙은 그 뒤였다. 문법 규칙이 문자열이라고 한 `+`에 TypeScript가 다르게 답한 것은 측정한 저장소 어디에도 없었다(아래 "측정"). 그래서 순서를 바꿔 물을 것을 줄였다.
  2. 그 밖의 `+`는 TypeScript에 묻는다("타입 정보 (TypeScript 7 API)" 참고). 답이 있으면 그것을 따른다.
     - 식 전체의 타입이 문자열 계열이면 변형하지 않는다. 체커가 정한 결과라서 문자열 변수, 템플릿 리터럴 타입, 문자열 enum, `string`으로 제한된 타입 매개변수, branded string이 모두 들어간다.
     - 식 전체의 타입이 `number`나 `bigint`이면 변형한다. 숫자 리터럴 타입과 숫자 enum이 여기에 든다.
     - 타입 오류 때문에 식 전체가 `any`인데 피연산자 하나가 문자열을 포함하는 union이면(`string | undefined` + 숫자) 문자열 연결로 본다.
  3. TypeScript가 답하지 못하면 변형한다. `any`, 타입 오류, tsconfig에 속하지 않는 파일, 엄격하게 검사되지 않는 JS 파일, TypeScript를 쓸 수 없거나 시간을 넘긴 경우, `--no-types`가 그렇다.
  - 생성 단계에서 남은 `+`는 기준 실행에서 한 번 더 거른다. 실행된 모든 평가에서 피연산자 하나가 문자열이었으면 그 mutant는 실행하지 않는다("실행 시간 프로파일링" 참고). JS와 TS 모두 해당한다.
  - TypeScript가 틀리면 다음 둘 중 하나가 된다.
    - 숫자 `+`를 문자열로 보면 mutant를 놓친다.
    - 문자열 `+`를 숫자로 보면 변형된다. 문법 규칙이 모르는 `+`라서, TypeScript가 없을 때와 같다.

**문자열 `+`의 문법 규칙.** `src/mutate/infer.ts`가 파일 하나의 AST와 스코프만 보고, 식이 늘 문자열로 평가되는지(아니면 throw하는지) 정한다. 문자열이라고 잘못 답하면 숫자 `+`의 mutant를 놓치므로, 확실한 경우에만 문자열이라고 답한다.

- 문자열로 보는 식
  - 문자열 리터럴, 템플릿 리터럴, `typeof x`
  - 피연산자 하나가 문자열인 `+`. 그래서 `"a" + b + c`의 바깥 `+`도 문자열 연결이다. 리터럴만 보던 규칙은 이것을 변형했다.
  - 두 갈래가 모두 문자열인 `c ? a : b`, `a || b`, `a && b`, `a ?? b`. 값은 둘 중 하나다.
  - 괄호, `x!`, `satisfies`, 타입 단언으로 감싼 문자열. 값은 그대로다.
  - 전역 `String(x)`, `encodeURIComponent`, `encodeURI`, `decodeURIComponent`, `decodeURI`, `escape`, `unescape`, 그리고 `String.fromCharCode`, `String.fromCodePoint`, `String.raw`
    - 둘러싼 스코프에서 같은 이름을 선언했으면 전역이 아니므로 제외한다. 매개변수, import, 아래쪽의 함수 선언이 그런 예다. 로그 필터의 `console`과 같은 `ScopeTracker`로 본다.
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
  - 타입 주석을 믿는다. `any`로 바꾼 값이나 `strictNullChecks: false`에서의 null처럼 주석과 다른 값이 들어올 수 있다. 그래도 주석이 문자열이라고 밝힌 `+`이고, TypeScript도 같게 답한다.
  - 로그 필터의 `console`처럼, sloppy mode에서 블록 안 함수 선언이 바깥으로 호이스팅되는 경우(Annex B)는 보지 못한다.
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
- 추론은 생성 단계의 두 번째 순회 안에서, 범위 안의 `+`에만 한다. 위 저장소의 644개 파일에 있는 `+`를 모두 물었을 때 합쳐서 15ms 미만이 들었다. 파싱과 순회(1.3초)는 원래 하던 일이다.

**로그 필터의 측정.**

- Google의 mutation testing 서비스는 코드 리뷰(Critique)에서 바뀐 줄의 mutant를 보고한다. 2014년부터 운영했고, 프로젝트가 골라서 켠다. 이 서비스는 "arid" 노드에는 mutant를 아예 만들지 않는다. arid 노드는 변형하면 비생산적인 mutant가 나오는 노드다. 로그 호출 같은 단순 노드와, 자식이 모두 arid인 복합 노드(로그만 하는 `if`)가 있다.
  - 출처는 Petrović·Ivanković(Google)·Fraser·Just, "Practical Mutation Testing at Scale: A view from Google", IEEE TSE 48(10), 2022(온라인 2021)다. 시스템을 만든 사람들의 보고다.
  - 초기 세 휴리스틱(로그, deadline·timeout·exponential backoff 같은 시간 관련 설정, 설정 플래그)이 productive 비율을 약 15%에서 80%로 올린 것으로 본다고 쓴다. 다만 논문 스스로 "정확히 재기는 어렵지만 강한 정황이 있다"고 단서를 단다. productive 비율은 개발자가 피드백한 mutant 중 "Not useful"이 아닌 비율이다. 그 뒤 규칙을 더해 89%가 됐다(§3.2.5). 2018년 ICSE-SEIP 논문은 같은 개선을 20%에서 80%로 적었다.
  - 로그 휴리스틱은 함수 이름이 `log`로 시작하거나, 호출하는 객체의 이름이 `logger`인 호출을 arid로 본다. 표본 100개 중 99개가 맞았고, 나머지 하나는 효용이 미미했다(§3.2.3).
  - 모니터링 시스템의 값 증가, 저수준 API, 플래그 변경을 "변형하기 쉽고 테스트하기도 쉽지만 대개 바람직하지 않은 테스트 목표"의 예로 든다(§3.2.3).
- 모든 줄을 바뀐 것으로 쳤을 때 로거와 메트릭 규칙이 없애는 mutant는 i18next `src`에서 2604개 중 32개, es-toolkit `src`에서 0개다. es-toolkit `src`에는 로그 레벨 이름의 메서드 호출이 하나도 없다. i18next의 32개는 `this.logger.warn`(19곳), `.log`(4곳), `.error`(1곳)의 `CallStatement` 24개와, `this.logger.log(updateMissing ? … : …)` 인자 안의 Condition·Logical·Negation 8개다.
- 32개를 하나씩 원본에 적용하고 `vitest related`로 돌렸다. 25개가 살아남고 7개가 잡혔다. 인자 안의 8개는 모두 살아남았고, `CallStatement`는 17개가 살아남고 7개가 잡혔다. 잡은 테스트는 모두 로거를 바꿔 끼우고 `warn`을 확인한다.
  - `i18next.hasLoadedNamespace.test.js`: `type: 'logger'` 모듈이 `warn`의 첫 인자를 모으고, 테스트가 메시지와 개수를 확인한다. `i18next.js`의 175·491줄, `Translator.js`의 287·504줄, `BackendConnector.js`의 237줄
  - `security.test.js`: `escapeValue: false`에서 위험한 nesting 옵션 문자열에 경고하는지 확인한다. `Interpolator.js`의 173줄
  - `translator.translate.returnObject.test.js`: `vi.spyOn(logger, 'create')`로 넣은 `warn` spy가 불렸는지 확인한다. `Translator.js`의 206줄
- 살아남는 25개는 CI를 실패시키는 잡음이고, 잡히는 7개는 잃는 검출이다. 살아남는 쪽이 많아서 로그 호출 전체를 거른다. `CallStatement`는 두고 인자 안쪽만 거르는 안도 봤다. 없애는 8개가 모두 살아남는 것이라 잃는 검출은 없지만, 살아남는 `CallStatement` 17개가 그대로 남는다.
- upstream PR 13개의 계획은 그대로다. 로그 호출을 바꾼 PR이 없다.
- 로그만 하는 `if` 규칙은 모든 줄을 바뀐 것으로 쳤을 때 i18next `src`에서 2572개 중 32개를 더 없앤다. 8곳(`BackendConnector.js` 224·225, `Interpolator.js` 172, `Translator.js` 205·286, `i18next.js` 174·206·208)의 조건에 있던 Condition 16개, Negation 7개, Logical 6개, Equality 1개, Regex 2개다. es-toolkit `src`에서는 0개다.
  - 32개를 같은 방법으로 돌렸다. 10개가 살아남고 22개가 잡혔다. 잡은 테스트는 위의 세 파일이다. `Interpolator.js` 172의 8개는 모두 `security.test.js`가, `Translator.js` 205의 3개는 `translator.translate.returnObject.test.js`가, `Translator.js` 286, `i18next.js` 174·206, `BackendConnector.js` 224의 `→ true`는 `i18next.hasLoadedNamespace.test.js`가 잡았다. 살아남은 것은 `loaded namespace`와 `initialized` 로그를 지키는 225·208의 조건 전부, 206의 `→ false`와 `!this.initializedStoreOnce`, 224의 `→ false`다.
  - 잡히는 쪽이 많아도 거르기로 했다. 경고를 테스트하는 라이브러리에서 경고를 지키는 조건의 검출을 잃는 것은 로그 호출을 거를 때 이미 받아들인 손실과 같은 종류다. 대신 로그만 더하는 PR이 경고 테스트 없이 실패하지 않는다. i18next 사례 PR(`nyorori/case-log-guard-if`, 경고하는 `if` 두 개를 더함)은 3K 1T 6S로 실패했고, 이제 mutant가 없어 통과한다.
  - upstream PR 13개의 계획은 그대로다.

**타이머는 거르지 않는다.** `setTimeout(f, ms)`, `setInterval(f, ms)`과 그 인자는 변형한다.

- Google이 거르는 시간 관련 코드는 sleep, deadline, timeout 같은 시간 설정이다. 단위 테스트가 시간을 거의 확인하지 않고, 확인할 때는 가짜 시계를 쓴다는 이유다. JavaScript의 타이머는 콜백 `f`가 코드가 하는 일이고, Vitest의 fake timer(`vi.useFakeTimers()`)로 흔히 테스트한다. i18next도 `init`이 `setTimeout(load, 0)`으로 미룬 로드와 `changeLanguage`의 순서를 fake timer로 확인한다.
- 시간을 재는 코드(`Date.now() - start`)는 JavaScript에서 대개 로그나 메트릭으로 간다. 그 인자는 로그 필터가 이미 거른다(`metrics.timing('load', Date.now() - start)`).

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

### 타입으로 불필요한 방어 코드

`a?.b`→`a.b`, `f?.()`→`f()`, `a ?? b`→`a`는 `a`가 null이나 undefined가 아니면 원본과 같다. 그래서 `a`의 타입이 null을 배제하고 **타입이 맞다면** equivalent다.
그러나 strict에서 타입 검사를 통과하면서도 그 자리에 null을 넣는 흔한 방법이 적어도 열 가지 있다. `JSON.parse`와 `any`, `as`, `!`, `noUncheckedIndexedAccess` 없는 `xs[0]`, `Record`와 index signature 조회, `user!: User` 확정 할당, 실제와 다른 `.d.ts`, `catch (e: any)`, 배열 공변성, 메서드 매개변수 bivariance다.
그래서 타입만으로 버리지 않고 기준 실행의 프로파일과 같이 본다(`src/mutate/profile.ts`의 `neverNullish`).

| 정적 타입 | 기준 실행에서 null/undefined였던 적 | 결과 |
|---|---|---|
| null이 될 수 없음(아래 규칙) | 없음(실행됐고 늘 아님) | **unnecessary by types**: 실행하지 않고, CI를 실패시키지 않고, 목록으로 보고 |
| null이 될 수 없음 | 있음 | 테스트에서 타입이 틀린 것이다(`null as any` 등). 그대로 실행 |
| null이 될 수 있음, 모름, JavaScript, 타입 정보 없음 | 없음 | 그대로: 이유와 함께 예측한 Survived |
| 상관없음 | 실행되지 않음 | 그대로 NoCoverage |

- 첫 줄은 타입도 테스트도 null이 오지 않는다고 하는 방어 코드다. 대개 지워도 되지만 타입이 틀렸을 수도 있다(아래 "남은 구멍"). 그래서 Survived처럼 실패시키지도, TCE처럼 조용히 버리지도 않고, 이유와 함께 목록에 남겨 사람이 보게 한다.
- 둘째 줄이 있으므로 `as any`로 null을 넣는 테스트가 있으면 보통의 mutant처럼 판정된다.

**null이 될 수 없다고 보는 타입.** TS 파일이고 config가 `strictNullChecks`를 켰을 때만 본다("타입 정보 (TypeScript 7 API)" 참고). 값의 위치에서 체커가 준 타입(좁혀진 타입)이 다음이어야 한다.

- 문자열, 수, bigint, boolean, enum, symbol, 객체, 함수 타입(TypeScript의 `TypeFlags.DefinitelyNonNullable`)이거나, 그것들만의 union
- 또는 구성원 하나가 그런 타입인 intersection(`T & {}`, `string & Brand`). intersection의 값은 모든 구성원에 속해야 한다. `T & {}`에 null을 넘기는 호출은 tsc 7.1이 거부했다.
- 제외하는 것
  - `any`, `unknown`, `void`, `never`, 타입 매개변수, `T[K]`, conditional type
  - null, undefined, void가 들어 있는 union
  - mapped type. `Readonly<T>`와 `Partial<T>`는 `T`가 null이면 null이다. `function f<T>(x: Readonly<T>)`를 `f<null>(null)`로 부르는 코드가 tsc 7.1을 통과하고, 실행하면 `x`가 null인 것을 확인했다. 제네릭인지는 API로 싸게 알 수 없어서 `Partial<User>`처럼 구체적인 것도 뺀다.
  - 인덱스 접근: 원소 접근(`xs[i]`, `pair[0]`, `byId[id]`)과 index signature로 찾는 속성 접근(`byId.admin`). `noUncheckedIndexedAccess`가 없으면 끝을 넘은 원소나 없는 키도 원소 타입이다. 이 옵션이 켜져 있으면 체커가 `| undefined`를 붙이므로 그 타입을 그대로 쓴다. 튜플의 `pair[0]`은 그때도 `User`다.
    - index signature로 찾는 속성은 이름의 심볼로 안다. `Record<string, T>`에서는 심볼이 없고, `[key: string]: T`를 선언한 interface에서는 `CheckFlags.IndexSymbol`인 `__index` 심볼이 온다. `Record<'a' | 'b', T>`의 `a`는 보통 속성이다.
  - 여러 선언을 합친 속성(심볼의 `declarations`가 둘 이상). spread가 이렇게 만든다. `{ tags: ['new'], ...options }`에서 `options.tags`가 optional이면, `exactOptionalPropertyTypes` 없이는 `{ tags: undefined }`를 넘길 수 있는데도 합친 `tags`의 타입은 `string[]`이다. tsc 7.1이 통과시키고 실행하면 undefined인 것을 확인했다. union 타입의 공통 속성, overload가 있는 메서드, 여러 lib에 선언된 전역(`globalThis.crypto`는 `lib.dom.d.ts`와 `@types/node`)도 여기에 걸린다. 보수적으로 빼는 것이다.
  - 단언한 값: `x!`, `x as T`, `<T>x` 자체와, 받는 쪽 체인에 `as`가 있는 값(`(r as HtmlEscapedString).isEscaped`). hono의 `html.ts`에서 이 `??`의 왼쪽은 `r`이 문자열일 때 undefined다. 체인 안쪽의 `!`는 상관없다. `x!.y?.z`에서 `x`가 null이면 원본도 mutant도 `?.`에 닿기 전에 throw한다.
  - JavaScript 파일. 조사에서 JavaScript에 대한 TypeScript의 답은 null에 대해 믿을 수 없었다.

**실제 코드.** hono의 `src`(테스트와 `.d.ts`를 뺀 188개 파일)에서 생성이 묻는 값 272개를 모두 물었다. null이 될 수 없다고 한 것은 23개였다(`as` 체인과 여러 선언 규칙을 넣기 전에는 30개).
- 손으로 확인하니 대부분은 정말 불필요했다. 바로 앞 줄에서 `?.` 없이 쓴 값의 `_fetchRes?.status`, 객체 리터럴로 만든 값의 `options?.removePoweredBy`, interface가 필수로 정한 `options?.recursive ?? false` 등이다.
- 나머지는 아래 "남은 구멍"에 해당했다. `delete (node as any).vR`를 하는 함수의 `node.vR?.length`, Lambda 이벤트처럼 밖에서 오는 데이터, `const callbacks = (str as T).callbacks as U` 뒤의 `callbacks?.length`다. 이런 곳은 테스트가 그 경우를 지나면 실행되고, 아니면 목록에서 사람이 본다.
- nyorori의 `src`(값 46개)에서는 0개였다. 모두 null이 될 수 있는 값이나 인덱스 접근을 지킨다.

**남은 구멍.** 타입은 검사된 만큼만 맞다. 다음은 strict에서도 타입 검사를 통과하면서 null을 넣고, nyorori는 알아보지 못한다.
- 다른 곳의 `as`, `!`, `any`(`const u: User = JSON.parse(s)`, `catch (e: any)`, `delete (x as any).p`), `user!: User` 확정 할당, 실제와 다른 `.d.ts`
- 배열 공변성(`const ys: (User | null)[] = xs; ys.push(null)`), 메서드 매개변수 bivariance, 구멍 난 배열(`new Array<User>(3)`을 `for...of`로 돌 때)
- 함수 호출을 넘어 유지되는 좁히기: `if (this.user) { this.logout(); return this.user?.name }`에서 `this.user`는 `User`로 좁혀진 채다(TypeScript #9998).
- 실행 환경마다 다른 lib 타입. 한 곳에만 선언된 전역은 그 환경에 없어도 타입으로는 있다.
- 이런 곳은 "테스트가 null을 넣으면 실행한다"가 잡거나, 목록에서 사람이 본다. 목록의 안내도 "지우는 것을 생각해 보고, 정말 null이 올 수 있으면 그 값을 넘기는 테스트를 추가하라"이다.

**파일의 타입 오류는 보지 않는다.** 같은 파일 안에서 null을 넣는 코드는 타입 오류가 되므로, 오류가 있는 파일의 답을 버리는 방법도 생각했다. 그러나 TypeScript 7.1은 `types`의 기본값이 `[]`라서, 이전 TypeScript를 위해 쓴 config에서는 `Cannot find name 'process'` 같은 오류가 흔하게 난다(확인함). 그러면 이 기능이 관계없는 이유로 켜졌다 꺼졌다 한다. 파일 하나의 진단에 16~83ms도 든다. 그래서 하지 않았다.

**보고.**
- 텍스트: ``N mutants unnecessary by types: `?.` or `??` where the type can't be null or undefined and no test made it so`` 한 줄
- step summary: "Unnecessary by types" 절. 대개 불필요한 방어 코드이니 `?.`나 `??`를 지우는 것을 생각해 보고, 정말 null이 올 수 있으면 그 값을 넘기는 테스트를 추가하라는 안내, CI는 실패하지 않는다는 말, 위치·연산자·변경·이유의 표
- `--json`: `unnecessary`. 각 항목은 `id`, `file`, `line`, `column`, `operator`, `description`, `reason`, `tests`(그 지점을 실행한 테스트 파일), `--no-predict`일 때의 `mispredicted`다.
- 어노테이션은 만들지 않는다. 할 일을 요구하지 않는 정보인데, PR이 건드린 방어적 `?.`마다 diff에 표시하면 정말 고쳐야 할 `::error`가 그 사이에 묻힌다. `::notice`도 diff 줄에 표시되므로 마찬가지다. 목록은 summary에 한 번에 있다.
- 억제 주석이 가리키는 mutant는 목록에 넣지 않고, 다른 예측한 mutant처럼 실행하지 않고 Ignored로 둔다. 이미 있는 억제가 "해당 mutant 없음"으로 실패하지 않게 하려는 것이다.
- `--no-types`면 묻지 않으므로 이전처럼 예측한 Survived가 된다.
- `--no-predict`면 실행한다. 결정적 테스트에서는 살아남아야 한다. 살아남지 않으면 `mispredicted`와 `MISPREDICT` 줄, "Wrong predictions"로 알리고 exit code는 바꾸지 않는다. `test/e2e.test.ts`가 이 모드로도 확인한다.

**Condition으로 넓히지 않은 이유.** `if (obj)`에서 `obj`가 null이 될 수 없는 객체 타입이면 `→ true` mutant도 같은 방식으로 볼 수 있을 것 같지만, 객체 타입이 truthy를 보장하지 않는다. 구조적 타입이라서 falsy인 원시값이 객체 타입에 들어간다. `{ length: number }`에 `''`, `{ toString(): string }`에 `0`, `{}`에 `false`, `Object`에 `0`을 넘기는 호출이 tsc 7.1을 통과했고, 실행하면 모두 falsy였다. 원시값을 받지 않는 것은 `object`뿐이었고, 거기에도 falsy 객체인 `document.all`이 있다. 건전하게 하려면 falsy 원시값마다 할당 가능성을 물어야 해서 하지 않았다.

### L2. 소스 주석 억제

```ts
// nyorori-ignore-next-line ComparisonBoundary -- 18세 경계는 상위 validator가 이미 막음
return age >= 18
```

- **연산자를 반드시 지정한다.** 줄 전체를 억제하는 방식은 없다.
- **이유를 반드시 쓴다.** 형식이 틀리거나 이유가 없거나, 알 수 없는 연산자를 쓰면 문제로 보고하고 exit 1로 끝낸다.
- 억제된 mutant도 실행한다. 테스트가 이미 잡는 mutant를 억제한 주석은 "불필요한 억제"로 보고하고 실패시킨다.
- 이 PR이 추가한 억제 주석이 아무 mutant에도 해당하지 않으면 실패시킨다. 그래야 낡은 주석이 쌓이지 않는다.
  - 주석은 토큰이 아니므로, 이 PR이 추가한 억제인지는 줄로 본다. 주석이 있는 줄을 바꿨으면(들여쓰기만 바꿔도) 새 억제로 표시한다.
  - 대상 줄에서 공백이나 주석, 타입만 바꾼 경우에는 실패시키지 않는다. 블록의 들여쓰기를 바꾸면 억제 주석과 대상 줄이 모두 바뀐 줄이 되지만, 대상 줄에는 범위 안의 mutant가 없다. 이때 지우라고 하면 틀린 안내다.
  - 범위가 토큰 단위로 좁아져서, 이전에는 필요했던 억제에 해당하는 mutant가 없어질 수 있다. 이 PR이 추가한 억제라면 지우라고 알린다. es-toolkit PR 2047에서 `arr.length - 1`의 Arithmetic을 억제했다면 이제는 그 억제가 문제로 보고된다.

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
- **TypeScript 7.1 beta API 의존.**
  - 7.1 정식판 전의 beta(`7.1.0-beta`, 2026-10-20)다. 정식판까지 API가 바뀔 수 있다. 7.0.2의 `unstable/` API와도 이미 다르다(`updateSnapshot`/`getProject` → `createSnapshot`/`Snapshot.update`/`getDefaultProjectForFile`).
  - 그래서 버전을 정확히 고정하고, 올릴 때는 `test/typecheck.test.ts`로 확인한다. 쓰는 것은 다음과 같다.
    - `typescript/async`: `API`, `createSnapshot`, `Snapshot.update({ openFiles })`, `getDefaultProjectForFile`, `Project.configFileName`, `program.getCompilerOptions`, `program.getSourceFile`, `checker.getTypeAtLocation`, `checker.getSymbolAtLocation`, `checker.typeToString`, `Type.flags`/`objectFlags`/`isUnionType`/`isIntersectionType`/`isObjectType`/`getTypes`, `Symbol.checkFlags`/`declarations`, `TypeFlags`, `ObjectFlags`, `CheckFlags`, `API.close`
    - `typescript/ast`: `getTokenAtPosition`, `isBinaryExpression`, `isPropertyAccessExpression`, `isElementAccessExpression`, `isCallExpression`, `isParenthesizedExpression`, `isNonNullExpression`, `isAsExpression`, `isTypeAssertion`, `SyntaxKind`
    - 같은 틱에 보낸 요청을 클라이언트가 `batchRequests` 하나로 묶는 동작. 바뀌면 왕복이 늘 뿐이다.
    - Node의 diagnostics channel `child_process`. Node 문서에서 기본 제공 채널은 experimental이다. 바뀌면 프로세스를 죽이는 보호만 빠진다.
    - 클라이언트 안의 `vscode-jsonrpc`가 쓰기 실패를 처리되지 않은 rejection으로 남기는 동작. 고쳐지면 그 리스너는 할 일이 없어진다.
  - `typescript`는 런타임 의존성이자 nyorori의 빌드 도구라서, 올리면 둘 다 바뀐다. nyorori의 코드는 7.1.0-beta로 타입 검사와 빌드가 된다.
  - TypeScript 7은 `strict`의 기본값이 켜짐이고, `getCompilerOptions()`는 config에 쓰인 옵션만 준다. `strictNullChecks`도 `checkJs`처럼 config가 켠 것만 친다("타입 정보 (TypeScript 7 API)" 참고). 프로젝트의 TypeScript가 7 이상이라도 config에 쓰지 않았으면 unnecessary를 가리지 않는다.
  - 바이너리는 21개 플랫폼용이 있다. 이 저장소에서 확인한 것은 Linux x64뿐이다. Windows와 macOS에서 실제로 도는지는 확인하지 않았다.
  - 프로젝트를 여는 비용은 프로그램 크기에 비례하고, tsrs보다 느렸다. 첫 프로젝트를 여는 데 이 저장소에서 약 3.5배, hono에서 약 7배가 걸렸다. 큰 monorepo에서는 references를 따라 여러 프로젝트를 읽을 수 있다. 파일 열기 하나가 30초를 넘으면 나머지는 문법 규칙으로 판단한다.
- **프로파일 예측.**
  - 결정적이지 않은 테스트에서는 예측이 틀릴 수 있다. 이때는 테스트가 잡을 mutant를 Survived로 보고하므로 CI를 거짓으로 실패시킨다. 원래의 flaky 테스트 위험과 방향이 반대다. `--no-predict`로 돌리면 확인할 수 있다.
  - Condition 예측의 부수 효과 판정은 문법만 본다. getter나 Proxy가 상태를 바꾸면 틀릴 수 있다.
  - 실행 시간의 문자열 `+` 규칙은 테스트가 문자열만 넣은 숫자 `+`의 mutant를 놓친다.
  - probe 함수 이름(`__nyorori_v`, `__nyorori_b0` 등)이 사용자 코드와 겹치지 않는다고 가정한다. `__nyorori_h`와 같다.
  - 호출 probe의 spread는 `Array.prototype[Symbol.iterator]`를 부른다. 이것을 바꾸는 코드는 기준 실행에서 그 호출을 더 보게 된다.
- **토큰 단위 범위.** 토큰이 같으면 같은 코드로 본다("범위 규칙"의 남은 한계). 다시 쓴 코드에서 diff가 우연히 맞춘 식이나, 이름이 가리키는 변수만 바뀐 식은 범위 밖이 된다. 틀리는 방향은 mutant를 놓치는 쪽이다.
  - 타입만 고친 것은 oxc-parser의 AST로 가린다. 실행되는 토큰을 타입으로 잘못 표시하면 그 변경의 mutant를 놓친다.
- **문자열 `+`의 문법 규칙.** 타입 주석과 내장 객체를 믿는다(L1 참고). 주석과 다른 값이 들어오거나 내장 객체를 덮어쓴 코드에서는 숫자 `+`의 mutant를 놓친다.
- **타입으로 불필요한 방어 코드.**
  - TypeScript 7.1이 본 타입을 믿는다. 타입 검사를 통과하면서 null을 넣는 길("남은 구멍")로 null이 오는데 테스트가 그 경우를 지나지 않으면, 필요한 `?.`가 "아마 불필요"로 목록에 오르고 CI는 통과한다. 원래라면 테스트가 없다고 실패했을 곳이다. 목록의 이유가 타입을 밝히므로 사람이 볼 수 있다.
  - 프로젝트가 타입 검사를 하지 않으면(Vitest는 하지 않는다) 타입이 틀린 채로 남을 수 있다. 프로젝트의 TypeScript와 7.1의 판단이 다를 수도 있다. 그 차이를 nyorori가 알아보지는 않는다.
  - 좁혀진 타입을 쓴다. 함수 호출이 속성을 바꿔도 TypeScript는 좁히기를 유지한다(TypeScript #9998).
  - mapped type, 여러 선언을 합친 속성, 단언을 거친 값, 원소 접근은 보수적으로 뺀다. 그 안의 정말 불필요한 `?.`는 이전처럼 예측한 Survived로 실패한다.
- **호출과 정규식 연산자.**
  - `CallUnwrap`은 타입을 보지 않는다. 메서드 이름으로 receiver를 고르므로, 이름이 같은 다른 객체의 메서드도 receiver로 바뀐다("호출과 정규식" 참고). 지역 변수에 담은 모듈(`const { posix } = path`의 `posix.normalize(p)`)은 알아보지 못해 `posix`로 바꾼다.
  - 전역 내장 객체의 정적 조건(`Object.hasOwn(o, k)`→`o`, `Array.isArray(x)`→`x`)은 함수 호출처럼 첫 인자로 바꾸므로, 결과가 다른 종류의 값이 된다. 조건에서는 그 값의 truthiness를 보는 mutant라서 Condition과 겹칠 수 있다.
  - 값을 그대로 돌려주는 호출(`Object.freeze(x)`, Vue의 `markRaw(x)`, 정체성만 다른 메모이즈)과, 고치지도 내주지도 않는 사본(`const c = xs.slice()` 뒤에 읽기만 하는 코드, es-toolkit 2099의 `Array.from(strings)`)은 살아남아 억제 주석이 필요할 수 있다. 바로 읽고 버리는 사본(`xs.slice().map(f)`)에는 만들지 않는다("호출과 정규식" 참고).
  - 문자열 사본(`s.slice()`)은 언제나 equivalent지만, 타입을 보지 않으므로 배열 사본과 구별하지 못한다.
  - `` `${String(x)}` ``에는 만들지 않는다. `x`가 Symbol이면 `` `${x}` ``는 TypeError를 던지고 `String(x)`는 던지지 않으므로, 그 mutant는 Symbol을 넣는 테스트가 잡을 수 있었다. 템플릿에 Symbol을 넣는 코드는 드물어서 받아들였다.
  - async 함수가 돌려주는 `Promise.resolve(x)`에도 만들지 않는다. `x`가 native promise가 아니면 `return x`와는 함수의 promise가 resolve되는 microtask 시점만 다르다. 그 순서에 기대는 테스트만 잡을 수 있으므로 받아들였다. `await Promise.resolve(x)`와 `await x`는 시점까지 같다.
  - 기본 import한 모듈의 함수(`path.dirname(f)`)에는 만들지 않으므로, 그런 함수를 더한 수정은 놓친다.
  - 정규식 mutant는 CLI를 돌리는 Node가 컴파일하는지로 거른다. 세션은 같은 Node로 뜨므로 테스트도 같은 엔진에서 돈다.
- **로그 필터.**
  - 이름으로 판단한다. 로거 이름에 로그 레벨 메서드가 있지만 로거가 아닌 객체의 호출은 변형하지 않아서, 그 mutant를 놓친다. 이름이 다른 로거(`out.warn(…)`, `debug('x')`나 `log('x')`처럼 함수로 부르는 로거, `logger.child({ id }).info(…)`)는 거르지 않아서, 그 mutant가 살아남으면 억제 주석이 필요하다.
  - 경고를 테스트하는 라이브러리에서는 그 검출을 잃는다. i18next에서는 로그 호출 24곳 중 7곳을 테스트가 확인했다("로그 필터의 측정" 참고). 경고 호출을 더하거나 지우는 PR은 그 경고를 테스트하지 않아도 통과한다.
  - 로그만 하는 `if`는 조건까지 변형하지 않으므로, 경고를 지키는 조건의 검출도 잃는다. i18next `src`에서는 그 조건의 mutant 32개 중 22개를 테스트가 잡았다("로그 필터의 측정" 참고). 조건에 부수 효과가 있어도 건너뛴다.
  - 메트릭 이름은 Google 논문의 예(모니터링 값의 증가)만 근거로 하고, 트레이싱과 메서드 이름 목록은 우리가 정했다. 측정한 저장소에 그런 호출이 없었다.
- **브라우저 모드.** 지원하지 않는다.
- **실행 시간.**
  - mutant 수 × 관련 테스트 시간만큼 걸린다.
  - hit 기반 테스트 선택과, 프로파일로 살아남는 것이 확실한 mutant를 실행하지 않는 것으로 줄이고, `--max-mutants`로 상한을 둔다.
  - `bail: 1`은 쓰지 않는다. 한 파일이 실패해 실행이 중간에 멈추면, 아직 시작하지 않은 파일이 이전 실행의 상태를 보고하거나 다음 실행까지 취소되어, 테스트가 잡는 mutant가 Survived로 나오는 일이 실제 저장소(chroma.js, axios)에서 재현됐다. 그래서 mutant마다 그 지점을 실행한 파일을 모두 끝까지 돌린다.
  - mutant는 아직 하나씩 순서대로 실행한다.

## 다음 단계

1. 실제 저장소 몇 곳에서 돌려 보고 오탐과 실행 시간을 측정한다.
2. Vite 서버를 따로 쓰는 project와 `experimental.viteModuleRunner: false`를 지원한다.
3. mutant를 병렬로 실행한다. Vitest 세션 여러 개를 쓰는 방식이다.
4. B: base와 head를 비교해서 기존 테스트가 약해졌는지 확인한다.
