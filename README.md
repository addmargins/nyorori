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

종료 코드는 세 가지입니다.

- `0`: 모든 mutant가 테스트에 걸렸습니다.
- `1`: 살아남은 mutant, 테스트가 실행하지 않는 코드, 또는 억제 주석의 문제가 있습니다.
- `2`: 판정할 수 없습니다. mutant 없이도 테스트가 실패하는 경우, merge-base가 없는 경우, [지원하지 않는 Vitest 설정](#지원하지-않는-vitest-설정)인 경우 등입니다.

## 판정

| 상태 | 의미 | CI |
|---|---|---|
| Killed | 테스트가 하나 이상 실패 | 통과 |
| Timeout | 무한 루프 등으로 시간 초과 | 통과 |
| Survived | 관련 테스트가 모두 통과 | 실패 |
| NoCoverage | 바뀐 코드를 실행하는 테스트가 없음 | 실패 |
| Ignored | 억제 주석으로 제외 | 통과. 요약에 표시 |

죽은 분기 안의 변경처럼 압축(`oxc-minify`)하면 원본과 같아지는 mutant는 실행하기 전에 버립니다(TCE).
출력과 job summary에는 버린 개수만 표시하고, `--json`에는 `equivalent`로 남깁니다. CI 결과에는 영향이 없습니다.

대상은 diff에서 추가되거나 바뀐 줄 중 함수 안의 코드입니다. 다음은 제외합니다.

- 테스트 파일
- 타입 선언
- Vitest `coverage.exclude`에 걸리는 파일(설정 파일 등)

## 지원하지 않는 Vitest 설정

nyorori는 Vite 플러그인으로 바뀐 코드를 계측합니다.
플러그인이 닿지 않는 테스트에서는 바뀐 코드가 실행되지 않는 것처럼 보여 NoCoverage로 거짓 실패하게 됩니다.
그래서 다음 설정에서는 판정하지 않고, 해당 project를 알려 주고 exit 2로 끝납니다.

- `test.projects` 중 Vite 서버를 따로 쓰는 project
  - Vite 옵션(`plugins`, `resolve` 등)이나 Vite에 영향을 주는 `test` 옵션(`alias`, `css`, `mode`, `root` 등)을 직접 정했거나, `extends: false`인 inline project
  - 설정 파일이나 디렉터리로 정한 project. project마다 설정 파일이 있는 monorepo라면 `--root`(Action은 `working-directory`)로 project마다 따로 실행하세요.
- `experimental.viteModuleRunner: false`

Vite에 영향을 주지 않는 `test` 옵션(`name`, `include`, `environment` 등)만 바꾸는 inline project는 루트 설정의 Vite 서버를 같이 쓰므로 지원합니다.

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
