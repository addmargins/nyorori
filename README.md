# nyorori

PR이 바꾼 코드에만 mutation을 넣고, 그 코드를 실행하는 Vitest 테스트를 돌립니다.
테스트가 알아채지 못하는 mutant가 하나라도 있으면 CI를 실패시킵니다.

"테스트는 통과하지만 바뀐 동작은 확인하지 않는" PR을 리뷰어가 손으로 가려내지 않아도 되게 하는 것이 목적입니다.
설계와 그 이유는 [`docs/design.md`](docs/design.md)에 있습니다.

## GitHub Action

```yaml
name: nyorori
on: pull_request

jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # merge-base를 구하려면 base 커밋이 필요합니다
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: addmargins/nyorori@main
        # with:
        #   working-directory: packages/app
        #   exclude: |
        #     scripts/**
        #   max-mutants: 300
        #   types: false # TypeScript 없이: 문자열 `+`는 문법으로만, 타입으로 불필요한 `?.`·`??`는 가리지 않음
        #   predict: false # 살아남을 것으로 예측한 mutant도 실제로 실행
```

- 문제가 된 mutant는 PR diff의 해당 줄에 어노테이션으로 표시되고, 요약은 job summary에 실립니다. 토큰 권한은 필요 없습니다.
- 프로젝트에 Vitest 5나 Vite+(`vite-plus`)가 설치되어 있어야 합니다. nyorori는 프로젝트의 Vitest와 설정을 그대로 사용합니다. Vite+ 프로젝트에서는 `vp test`처럼 vite-plus에 들어 있는 Vitest를 씁니다.

## CLI

```sh
npx nyorori run --base origin/main
```

| 옵션 | 설명 |
|---|---|
| `--base <ref>` | 비교 기준. 기본값은 `origin/$GITHUB_BASE_REF` |
| `--root <dir>` | Vitest 프로젝트 루트. 기본값은 현재 디렉터리 |
| `--exclude <glob>` | 대상에서 뺄 소스 파일(루트 기준, 여러 번 사용 가능) |
| `--timeout <ms>` | mutant 한 번 실행에 기준 실행 시간의 2배에 더해 허용할 시간. 기본값 10000 |
| `--max-mutants <n>` | mutant가 n개를 넘으면 실행하지 않고 에러로 끝냄 |
| `--json <file>` | 전체 결과를 JSON으로 저장 |
| `--dry-run` | 테스트를 돌리지 않고 mutant 목록만 출력 |
| `--no-types` | TypeScript를 띄우지 않음. 문자열 `+`를 문법으로만 가리고, [타입으로 불필요한 방어 코드](#타입으로-불필요한-방어-코드)도 가리지 않음. [문자열 `+`](#문자열-) 참고 |
| `--no-predict` | 기준 실행의 프로파일로 살아남는 것이 확실한 mutant도 실행하고, 예측이 틀린 mutant를 알림. [기준 실행의 프로파일](#기준-실행의-프로파일) 참고 |

종료 코드는 세 가지입니다.

- `0`: 모든 mutant가 테스트에 걸렸습니다.
- `1`: 살아남은 mutant, 테스트가 실행하지 않는 코드, 또는 억제 주석의 문제가 있습니다.
- `2`: 판정할 수 없습니다. mutant 없이도 테스트가 실패하는 경우, merge-base가 없는 경우, [지원하지 않는 Vitest 설정](#지원하지-않는-vitest-설정)인 경우 등입니다.

## 판정

| 상태 | 의미 | CI |
|---|---|---|
| Killed | 테스트가 하나 이상 실패 | 통과 |
| Timeout | 무한 루프 등으로 시간 초과 | 통과 |
| Survived | 관련 테스트가 모두 통과, 또는 [기준 실행의 프로파일](#기준-실행의-프로파일)로 보아 통과할 것이 확실함 | 실패 |
| NoCoverage | 바뀐 코드를 실행하는 테스트가 없음 | 실패 |
| Ignored | 억제 주석으로 제외 | 통과. 요약에 표시 |

`--json`의 Survived와 NoCoverage 결과에는 모두 `reason`이 있습니다. [기준 실행의 프로파일](#기준-실행의-프로파일)이 이유를 알면 그 이유이고, 아니면 텍스트 출력과 같은 `every test still passes with this change`나 `no test runs this code`입니다. `--dry-run`은 판정하지 않으므로 `reason`이 없습니다.

죽은 분기 안의 변경처럼 압축(`oxc-minify`)하면 원본과 같아지는 mutant는 실행하기 전에 버립니다(TCE).
출력과 job summary에는 버린 개수만 표시하고, `--json`에는 `equivalent`로 남깁니다. CI 결과에는 영향이 없습니다.

대상은 diff에서 추가되거나 바뀐 줄 중 함수 안의 코드입니다. 다음은 제외합니다.

- 테스트 파일
- 타입 선언
- Vitest `coverage.exclude`에 걸리는 파일(설정 파일 등)

### 기준 실행의 프로파일

mutant 없이 테스트를 돌리는 기준 실행에서, 바뀐 코드의 각 지점을 지나간 값의 종류를 기록합니다.
모든 테스트에서 원본과 똑같이 동작한 mutant는 실행하지 않고, 이유와 함께 Survived로 보고합니다.

```
  Survived   src/user.js:2:14  OptionalChaining  `?.` → `.`  (no test makes `user` null or undefined here)
  Survived   src/cart.js:5:32  Arithmetic  `+` → `-`  (`item.fee` was always 0)
  Survived   src/range.js:2:9  ComparisonBoundary  `<` → `<=`  (no test has `x === lo`)
  Survived   src/log.js:3:7  Condition  `options.verbose` → `false`  (the condition was always falsy in tests)
```

| mutant | 실행하지 않는 경우 |
|---|---|
| `a?.b`→`a.b`, `f?.()`→`f()`, `a ?? b`→`a` | 어떤 테스트에서도 `a`나 `f`가 null이나 undefined가 아님. 타입도 그렇다고 하면 [따로 보고](#타입으로-불필요한-방어-코드) |
| `ComparisonBoundary` | 어떤 테스트에서도 두 피연산자가 같지 않음 |
| `Arithmetic` | 바꾼 연산자가 어떤 테스트에서도 같은 값을 냄. 예: `x + fee`에서 `fee`가 늘 0 |
| `Condition` | 조건에 호출, 대입 같은 부수 효과가 없고, 늘 그 값(`true`나 `false`)이었음 |

- 이것은 "그런 값이 올 수 없다"는 뜻이 아니라 "테스트가 그런 경우를 확인하지 않는다"는 뜻입니다. 그래서 CI는 실패합니다. 정말 올 수 없는 값이라면 [억제 주석](#equivalent-mutant-억제)에 그 이유를 적으세요.
  - TypeScript 타입도 null이 될 수 없다고 하는 `?.`와 `??`는 예외입니다. [타입으로 불필요한 방어 코드](#타입으로-불필요한-방어-코드)를 보세요.
- 테스트가 결정적이라고 가정합니다. 시간이나 난수에 따라 다르게 도는 테스트에서는 예측이 틀릴 수 있습니다. `--no-predict`로 실행하면 이런 mutant도 실제로 돌려 보고, 예측과 다르게 살아남지 않은 mutant를 `MISPREDICT` 줄로 알립니다.
- getter와 Proxy는 부수 효과가 없다고 봅니다.
- mutant 실행에는 기록 코드가 들어가지 않은 계측을 씁니다. 그래서 기록 비용은 기준 실행에만 듭니다. 보통의 테스트에서는 수 % 이내였고, 바뀐 코드를 아주 많이 반복해서 부르는 테스트에서는 더 큽니다.
- `--json`의 결과에는 이유가 `reason`으로, 실행하지 않은 것은 `predicted: true`로 남습니다.
- 호출과 정규식 mutant(`CallUnwrap`, `CallStatement`, `Regex`)는 예측하지 않습니다.

### 타입으로 불필요한 방어 코드

TypeScript 파일에서는 `a?.b`, `f?.()`, `a ?? b`가 지키는 값(`a`, `f`)이 타입으로 null이나 undefined가 될 수 있는지도 TypeScript에 묻습니다.
될 수 없고, 기준 실행에서 어떤 테스트도 그 값을 null이나 undefined로 만들지 않았다면, 그 mutant는 실행하지 않고 **unnecessary by types**로 따로 보고합니다. CI는 실패하지 않습니다.

```
  1 mutant unnecessary by types: `?.` or `??` where the type can't be null or undefined and no test made it so
```

| 값의 타입 | 기준 실행 | 결과 |
|---|---|---|
| null이나 undefined가 될 수 없음 | 실행됐고, null이나 undefined였던 적이 없음 | unnecessary by types. 실행하지 않고, CI를 실패시키지 않음 |
| null이나 undefined가 될 수 없음 | null이나 undefined였던 적이 있음(`null as any` 등) | 타입이 틀린 곳이므로 그대로 실행 |
| 될 수 있음, 알 수 없음(`any` 등), JavaScript, 타입 정보 없음 | 실행됐고, null이나 undefined였던 적이 없음 | 이전처럼 이유와 함께 Survived |
| 상관없음 | 실행되지 않음 | NoCoverage |

- 대개 지워도 되는 방어 코드라는 뜻입니다. `?.`나 `??`를 지우거나, 그 값이 정말 null이 될 수 있다면(외부 데이터, `as`, `!` 등) 그 값을 넘기는 테스트를 추가하세요. 그러면 mutant가 실행되어 판정됩니다.
- job summary에는 "Unnecessary by types" 표로, `--json`에는 `unnecessary`로 남습니다. 위치, 연산자, 변경, 이유(``"`user` is `User` by its type, which can't be null or undefined, and no test passed null or undefined"``), 그 지점을 실행한 테스트 파일이 들어갑니다.
- 어노테이션은 만들지 않습니다. 고칠 것을 요구하지 않는 정보인데, PR이 건드린 방어적인 `?.`마다 표시하면 정말 고쳐야 할 오류 어노테이션이 묻히기 때문입니다.
- 억제 주석이 가리키는 mutant는 다른 예측한 mutant처럼 Ignored가 됩니다.
- 다음은 타입을 믿지 않고 이전처럼 판정합니다.
  - tsconfig가 `strict`나 `strictNullChecks`를 켜지 않은 프로젝트. TypeScript 7은 기본으로 켜지만, 프로젝트가 쓰는 TypeScript는 더 오래되어 꺼져 있을 수 있습니다.
  - `any`, `unknown`, 타입 매개변수, `Readonly<T>` 같은 mapped type, null·undefined·void가 들어 있는 union
  - 인덱스 접근: `xs[i]`, `record[key]`, index signature로 찾는 `record.key`. `noUncheckedIndexedAccess`를 켜면 TypeScript가 `| undefined`를 붙이므로 그 타입을 씁니다.
  - spread처럼 여러 선언을 합친 속성. `{ tags: [], ...options }`의 `tags`는 `options.tags`가 명시적으로 undefined여도 `string[]` 타입입니다.
  - `x!`, `x as T`처럼 단언한 값, 그리고 `(x as T).y`처럼 단언을 거친 값
  - JavaScript 파일
- 타입은 검사된 만큼만 맞습니다. 다른 곳의 `as`나 `!`, `JSON.parse` 결과를 타입 있는 변수에 넣는 것, `user!: User` 같은 확정 할당, 실제 코드와 다른 `.d.ts` 등은 타입 검사를 통과하면서도 null을 넣을 수 있습니다. 그래서 이런 mutant를 버리지 않고 목록에 남기고, 테스트가 null을 넣는 지점은 그대로 실행합니다.
- `--no-types`면 TypeScript에 묻지 않으므로 모두 "타입 정보 없음"으로 판정합니다. `--no-predict`면 이 mutant도 실행해서, 살아남지 않은 것을 `MISPREDICT` 줄로 알립니다. 이때도 CI 결과는 바꾸지 않습니다.

## 지원하지 않는 Vitest 설정

nyorori는 Vite 플러그인으로 바뀐 코드를 계측합니다.
플러그인이 닿지 않는 테스트에서는 바뀐 코드가 실행되지 않는 것처럼 보여 NoCoverage로 거짓 실패하게 됩니다.
그래서 다음 설정에서는 판정하지 않고, 해당 project를 알려 주고 exit 2로 끝납니다.

- `test.projects` 중 Vite 서버를 따로 쓰는 project
  - Vite 옵션(`plugins`, `resolve` 등)이나 Vite에 영향을 주는 `test` 옵션(`alias`, `css`, `mode`, `root` 등)을 직접 정했거나, `extends: false`인 inline project
  - 설정 파일이나 디렉터리로 정한 project. project마다 설정 파일이 있는 monorepo라면 `--root`(Action은 `working-directory`)로 project마다 따로 실행하세요.
- `experimental.viteModuleRunner: false`

Vite에 영향을 주지 않는 `test` 옵션(`name`, `include`, `environment` 등)만 바꾸는 inline project는 루트 설정의 Vite 서버를 같이 쓰므로 지원합니다.

그 밖에 알아 둘 점:

- 브라우저 모드 project도 지원하지 않습니다(exit 2).
- Yarn PnP(Plug'n'Play)에서는 Action의 `node`가 Vitest를 찾지 못합니다. `.yarnrc.yml`에 `nodeLinker: node-modules`를 두세요.
- nyorori는 테스트 파일마다 실행 기록을 모으려고 `isolate: true`로 실행합니다. `isolate: false`인 프로젝트에서는 평소보다 느릴 수 있습니다.
- 기준 실행은 값 종류를 기록하느라 조금 느립니다. 실행 시간을 직접 재서 단언하는 테스트(예: ReDoS 방어 테스트)는 기준 실행에서 실패해 exit 2가 될 수 있습니다.

## Mutation 연산자

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
| `Condition` | `if`/삼항의 조건 → `true`, `false`. 루프 조건 → `false` |
| `FunctionBody` | 함수 본문 → 즉시 `return` |
| `OptionalChaining` | `a?.b`→`a.b` |
| `CallUnwrap` | 인자가 있는 호출 → 첫 인자. `toInteger(x)`→`x`, `obj.get(key, d)`→`key` |
| `CallStatement` | 값을 버리는 호출 문 → 호출 제거. `unmatched.delete(key)`, `await save(x)`→`await undefined` |
| `Regex` | 정규식 리터럴: flag 하나 제거(`/a/gi`→`/a/i`), 그룹 밖의 `^`·`$` 제거, `[abc]`↔`[^abc]`, `\d`↔`\D`, `\w`↔`\W`, `\s`↔`\S` |

호출과 정규식 연산자는 값을 감싸는 함수를 더하거나(`normalizeZero(x)`), 호출 문을 더하거나(`set.delete(key)`), 정규식 flag를 더한 수정에도 mutant가 생기게 합니다.

- `CallUnwrap`은 함수 호출과 메서드 호출 모두에 만듭니다. 다음은 만들지 않습니다: `super(…)`, `require(…)`, 전역 `console` 호출, 첫 인자가 spread이거나 함수 리터럴(콜백)인 호출, `.call`/`.apply`/`.bind`, 다른 호출이나 `new`의 callee인 호출, optional chain 안에서 `?.` 뒤에 오는 호출(`a?.b(x).c`), 값을 버리는 호출 문(`CallStatement`가 맡음)
- `CallStatement`는 `super(…)`와 전역 `console` 호출을 지우지 않습니다.
- 정규식 mutant는 모두 `new RegExp`로 컴파일되는지 확인하고, 되지 않으면 버립니다. `^`·`$`가 없는 패턴의 `m`, `.`가 없는 패턴의 `s`는 빼도 같으므로 빼지 않습니다.
- 이 셋은 [기준 실행의 프로파일](#기준-실행의-프로파일)로 예측하지 않고 실제로 실행합니다. 호출은 인자를 그대로 돌려주어도 부수 효과가 있을 수 있기 때문입니다.

### 문자열 `+`

문자열을 이어 붙이는 `+`는 변형하지 않습니다.

- 피연산자 하나가 문자열인 것이 문법으로 확실하면 알아봅니다. JavaScript와 TypeScript 모두 해당합니다.
  - 문자열 리터럴과 템플릿 리터럴(`"n=" + x`), `typeof x`, 전역 `String(x)`, 문자열에 부른 `trim()` 같은 메서드, 배열에 부른 `join()`
  - 문자열이 붙은 `+`. `"a" + b + c`의 두 `+`가 모두 해당합니다.
  - 그런 식으로 초기화한 `const`
  - 타입 주석이 `string`이나 문자열 리터럴 타입(`'a' | 'b'`)인 매개변수와 변수. `x?: string`과 `string | undefined`는 제외합니다.
  - 다시 대입될 수 있는 `let`/`var`의 초기값, 함수 반환값, 객체 멤버, `x as string`, JSDoc은 보지 않습니다. 확실하지 않은 `+`는 변형합니다.
- 문법으로 알 수 없는 `+`는 TypeScript 7.1의 API(`typescript` 패키지, 지금은 beta)로 타입을 확인합니다. 그래서 `user.name + user.title`처럼 문법으로는 알 수 없는 `+`도 거르고, `a + b`(숫자)는 변형합니다.
  - 파일이 속한 `tsconfig.json`은 편집기처럼 찾습니다. `references`도 따라갑니다.
  - 어느 tsconfig에도 속하지 않는 파일과 `any`인 값은 문법으로만 판단합니다.
  - JavaScript 파일은 그 프로젝트(`tsconfig.json`이나 `jsconfig.json`)가 `checkJs`와 `noImplicitAny`(또는 `strict`)를 켜서 TypeScript만큼 엄격하게 검사할 때만 타입을 씁니다. 그렇지 않은 JavaScript에서는 TypeScript가 초기값으로 추론한 타입을 다른 대입이나 호출이 아무 오류 없이 깨뜨릴 수 있습니다. 예를 들어 `let s = ''`인 `s`를 다른 함수가 `s = 1`로 바꿔도 TypeScript는 `s + n`을 문자열 연결로 봅니다.
- 그렇게 남은 `+`도, 기준 실행의 모든 평가에서 피연산자 하나가 문자열이었다면 실행하지 않습니다. JavaScript와 TypeScript 모두 해당합니다.
  - 출력과 job summary에는 `N mutants skipped: string concatenation in every observed evaluation` 한 줄만 표시하고, `--json`에는 `skipped`로 남깁니다. CI 결과에는 영향이 없습니다.
  - 문자열 피연산자가 없는 평가가 하나라도 있으면 그대로 실행하고, 실행되지 않은 `+`는 NoCoverage입니다.
- TypeScript가 답하지 못하면 문법으로만 판단합니다.
  - TypeScript의 네이티브 바이너리는 Windows, macOS(Intel, Apple Silicon), Linux를 포함한 21개 플랫폼용이 있습니다. 바이너리가 없는 플랫폼에서도 설치는 되지만 타입 정보 없이 실행됩니다.
  - 요청마다 시간 제한이 있습니다(프로세스 시작과 파일 열기는 30초, 그 밖의 요청은 5초). 시간을 넘기거나 오류가 나면 TypeScript 프로세스를 끝내고, 남은 파일은 문법으로 판단합니다.
  - 타입 정보 없이 판단한 TypeScript 파일이 있으면 출력에 그 이유를 한 줄로 알립니다. `--json`에는 `types`로 남습니다.

## Equivalent mutant 억제

압축 결과로 알 수 있는 equivalent mutant는 nyorori가 알아서 버립니다.
그 밖에 바꿔도 동작이 정말 같은 mutant는 바로 윗줄에 이유를 적어 억제합니다.

```ts
// nyorori-ignore-next-line ComparisonBoundary -- 18세 경계는 상위 validator가 이미 막음
return age >= 18
```

- 연산자와 이유를 반드시 적어야 합니다.
- 주석은 diff에 그대로 보입니다. 이 PR이 추가한 억제는 경고 어노테이션과 job summary 맨 위에 따로 표시됩니다.
- 다음 경우에는 실패합니다.
  - 형식이 틀린 주석
  - 억제할 mutant가 없는 주석
  - 테스트가 이미 잡는 mutant를 억제하는 주석
