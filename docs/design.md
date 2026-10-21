# nyorori 설계 초안

## 목표

PR이 **추가하거나 바꾼 코드**에만 mutation을 넣고, 그 PR 시점의 Vitest 테스트를 돌린다.
살아남은 mutant가 하나라도 있으면 CI를 실패시킨다.
살아남은 mutant는 "이 PR이 바꾼 동작을 확인하는 테스트가 없다"는 증거다.

범위:

- 대상은 JS/TS 저장소이고, 테스트 러너는 Vitest만 지원한다.
- 모든 PR에 적용한다. CLI로 만들고 GitHub Action으로 감싼다.
- 지금 다루는 것은 A(PR이 바꾼 동작이 검증되지 않은 경우)다. B(기존 테스트가 약해진 경우)는 base와 head를 비교해야 하므로 나중에 다룬다.
- mutation 점수의 임계값은 두지 않는다. diff 범위 안에서 살아남은 mutant는 0개여야 한다.

## 전체 흐름

```
nyorori run --base <sha>
  1. 범위 계산    git diff --unified=0 <merge-base>...HEAD → 파일별 "바뀐 줄" 집합
                 테스트 파일과 비소스 파일은 제외 (Vitest의 테스트 glob으로 판별)
  2. mutant 생성  oxc로 바뀐 파일을 파싱 → 바뀐 줄에 앵커가 걸린 노드에만 mutant를 만든다
                 → 정적 equivalent 필터 (아래 L1)
                 → 소스 주석 억제 적용 (아래 L2)
  3. 계측         Vite 플러그인(enforce: 'pre')이 바뀐 파일에 schemata를 삽입
                 (id === __nyorori_active ? 변형 : 원본)
  4. 기준 실행    mutant 0(원본)으로 관련 테스트를 실행한다. 이 실행에서는
                 - 실패가 하나라도 있으면 중단한다 (도구 에러이지 mutant 판정이 아님)
                 - 테스트 파일별로 어떤 mutant 지점이 실행되었는지(hit) 기록한다
                 - 테스트 파일별 실행 시간을 재서 timeout 기준으로 쓴다
  5. mutant 실행  mutant마다 provide(id) → hit한 테스트 파일만, bail: 1로 실행
  6. 보고         stdout, $GITHUB_STEP_SUMMARY, ::error 어노테이션, --json
                 Survived 또는 NoCoverage가 하나라도 있으면 exit 1
```

3번과 5번 단계, 그리고 관련 테스트를 고르는 방식은 Vitest 5.0.5로 직접 확인했다
([`spikes/vitest-runtime-switch`](../spikes/vitest-runtime-switch)).
Vitest 인스턴스 하나로 재변환이나 재시작 없이 mutant를 바꿔 가며 실행할 수 있다.

### mutant 판정

| 상태 | 의미 | CI |
|---|---|---|
| Killed | 테스트가 하나 이상 실패 | 통과 |
| Timeout | 시간 초과(무한 루프 등) | 통과 (killed로 취급) |
| Survived | 관련 테스트가 모두 통과 | **실패** |
| NoCoverage | 기준 실행에서 이 지점을 실행한 테스트가 없음 | **실패** |
| Ignored | 소스 주석으로 억제됨 (L2) | 통과, 보고서에 표시 |
| Error | 계측 결과가 로드되지 않는 등 도구 문제 | 실행 전체를 에러로 처리 |

NoCoverage는 실행하지 않고도 판정할 수 있으므로 비용이 들지 않는다.
바뀐 코드를 아무 테스트도 실행하지 않는다는 뜻이고, 이것이 가장 흔한 실패일 것이다.

### 범위 규칙

- 앵커는 mutant가 바꾸는 토큰의 위치다. 연산자 mutant라면 연산자, 리터럴이라면 리터럴, 조건 mutant라면 조건식의 시작이다. 앵커가 바뀐 줄에 있을 때만 mutant를 만든다.
- 순수 삭제는 mutant를 만들 대상이 없으므로 A의 범위 밖이다. 이것은 B에서 다룬다.
- 타입 전용 코드(타입 주석, interface, type alias, `declare`)는 런타임에서 지워지므로 대상에서 뺀다.

### 1차 mutation 연산자

| 분류 | 변형 |
|---|---|
| 비교 | `<`↔`<=`, `>`↔`>=`, `===`↔`!==`, `==`↔`!=` |
| 논리 | `&&`↔`\|\|`, `a ?? b`→`a` |
| 산술 | `+`↔`-`, `*`↔`/`, `%`→`*`, 단항 `-x`→`x`, `++`↔`--` |
| 불리언 | `true`↔`false`, `!x`→`x` |
| 조건 | `if`/삼항/루프의 조건 → `true`, `false` |
| 블록 | 함수 본문 → `{}` (반환값이 있는 함수는 `return undefined`) |
| 옵셔널 체이닝 | `a?.b`→`a.b` |

문자열 리터럴→`""`과 배열/객체 리터럴 비우기는 오탐이 많아 2차로 미룬다.
모든 schemata는 괄호로 감싼 표현식이나 블록 수준에서만 삽입한다.
그래서 TS 문법이 깨질 여지를 줄인다.

## 구현 구조: Rust와 JS의 역할 나누기

Vitest는 JS 안에서 돈다. 모듈 그래프, 플러그인 transform, 워커 재사용을 쓰려면 오케스트레이터가 같은 Node 프로세스 안에 있어야 한다.
순수 Rust 바이너리로 만들면 mutant마다 Vitest를 새로 띄워야 한다(시작에만 1~2초).
어차피 JS 플러그인도 따로 배포해야 한다.
그래서 오케스트레이션은 TS로 하고, AST 작업에만 voidzero의 Rust 도구를 쓴다.
이것은 rolldown/vite와 같은 분할이다.

AST 작업을 어디에 둘지는 두 가지 선택지가 있다.

| | (1) 자체 Rust 코어 + napi-rs | (2) `oxc-parser` npm 패키지 + TS |
|---|---|---|
| 파서 | `oxc_parser`, `oxc_ast`, `oxc_semantic`, `oxc_codegen` 크레이트 | 같은 Rust 파서. voidzero가 플랫폼별로 미리 빌드해 배포 |
| mutant 생성과 계측 | Rust visitor, codegen + sourcemap | TS visitor, `magic-string`으로 범위 치환 + sourcemap |
| 배포 | 플랫폼별 napi 바이너리 빌드 CI가 필요 | 순수 JS 패키지 |
| 성능 | 더 빠름 | 파싱은 같은 Rust이고 나머지는 JS. 바뀐 파일 몇 개라 차이가 작음 |

**추천은 (2)로 시작하는 것이다.** 실행 시간의 거의 전부는 테스트 실행이고, PR diff 범위의 AST 처리는 미미하다.
(2)도 voidzero의 Rust 파서 위에 서 있다.
프로파일링에서 AST 단계가 병목으로 나오면 그 부분만 (1)로 옮긴다.

```
nyorori/
├─ src/
│  ├─ cli.ts          인자 처리, exit code
│  ├─ diff.ts         git diff → 바뀐 줄 범위
│  ├─ mutate/         oxc-parser AST → mutant 목록, L1 필터, L2 주석 파싱
│  ├─ instrument.ts   schemata 삽입 (Vite 플러그인)
│  ├─ runner.ts       Vitest Node API: 기준 실행, hit 수집, mutant별 실행
│  └─ report/         stdout, step summary, 어노테이션, json
├─ action.yml         composite action: npx nyorori run --base ${{ github.event.pull_request.base.sha }}
└─ docs/
```

GitHub Action에서는 `::error file=…,line=…` 워크플로 명령을 쓴다.
그래서 토큰 권한 없이도 살아남은 mutant가 PR diff의 해당 줄에 바로 표시된다.
merge-base를 구하려면 `actions/checkout`에 `fetch-depth: 0`이 필요하고, 이것을 README에 적는다.

## Equivalent mutant: 같이 정해야 할 부분

### 전제

1. **살아남았다고 equivalent인 것은 아니다.** spike의 `age >= 18 → age > 18`은 살아남았지만, equivalent가 아니라 경계값 테스트가 빠진 것이다. 실제로 살아남는 mutant 대부분은 이런 경우일 것이다.
2. **억제 수단은 PR을 만든 에이전트도 쓴다.** CI를 통과시키려는 에이전트에게 쉬운 억제 수단은 우회로가 된다. 그러므로 억제는 **눈에 띄고, 이유가 있어야 하고, 범위가 좁아야** 한다.
3. 그 대신 리뷰어가 할 일은 크게 줄어든다. "이 테스트가 바뀐 동작을 정말 확인하는가?"를 판단하던 일이 "이 한 줄짜리 억제 주석의 이유가 맞는가?"를 판단하는 일로 바뀐다.

### 3단계 제안

**L1. 생성 단계에서 거르기 (자동, 사람 개입 없음).** 보수적으로, 확실한 것만 거른다.

- 규칙 기반 필터:
  - `console.*`나 로거 호출 인자 안쪽은 건너뛴다(설정으로 바꿀 수 있음).
  - `x.length >= 0`처럼 항상 참인 조건을 `true`로 바꾸는 변형은 만들지 않는다.
  - `x * 1`의 `*`→`/`처럼 결과가 같은 것이 확실한 패턴은 아예 만들지 않는다.
- TCE(Trivial Compiler Equivalence):
  - 원본과 mutant를 각각 `oxc-minify`로 압축한다.
  - 결과가 같으면 equivalent로 보고 버린다.
  - 상수 접기나 죽은 코드 안의 mutant가 여기에 걸린다. 비용이 싸지만 많이 잡지는 못한다.

**L2. 소스 주석 억제 (diff에 드러남).**

```ts
// nyorori-ignore-next-line ConditionalBoundary -- 18세 경계는 상위 validator가 이미 막음
return age >= 18;
```

- **연산자를 반드시 지정한다.** 줄 전체를 억제하는 방식은 없다.
- **이유를 반드시 쓴다.** 이유가 없으면 주석 자체를 에러로 처리한다.
- 주석이 diff에 들어가므로 리뷰어 눈에 띈다. 보고서에는 Ignored 목록과 이유를 함께 싣는다.
- 아무것도 억제하지 않는 주석(대상 mutant가 없거나, 이미 죽는 mutant)은 에러로 처리한다. 그래야 낡은 주석이 쌓이지 않는다.

**L3. 이 PR이 새로 추가한 억제를 어떻게 다룰까. ← 정해 주셔야 할 부분**

| 정책 | 동작 | 장점 | 단점 |
|---|---|---|---|
| `warn` | 통과. 요약 맨 위에 "이 PR이 억제 N개 추가"를 표시 | 마찰이 없음 | 리뷰어가 놓치면 그대로 통과 |
| `fail` | 새 억제가 있으면 실패. 사람이 `nyorori/ack` 라벨을 달면 통과 | 사람의 확인을 강제 | 에이전트에게 라벨 권한이 있으면 무력화됨. 라벨 이벤트로 워크플로를 다시 돌려야 함 |
| `review` | 새 억제마다 PR 리뷰 코멘트를 달고, 체크는 통과 | 판단할 지점이 코드 줄에 붙음 | `pull-requests: write` 권한이 필요 |

제 추천은 기본값 `warn` + 설정으로 `fail` 선택 가능이다.
1차의 목표는 "살아남은 mutant가 조용히 지나가지 않게" 하는 것이다.
억제는 이미 diff에 보이고 요약에도 올라가므로, 조용히 지나가지는 않는다.

### 하지 않을 것

- **저장소의 별도 허용 목록 파일(`.nyorori/equivalent.json` 등)은 두지 않는다.** 코드가 바뀌면 키가 어긋나고, 억제가 코드에서 멀어져 리뷰에 드러나지 않는다.
- **mutation 점수 임계값은 두지 않는다.** 80% 같은 기준이 있으면 그 아래에서 살아남은 mutant가 묻힌다.

## 남은 위험

- **Vitest API 의존.** `related` + `getRelevantTestSpecifications()`, `project.provide()`는 공개 API이지만 메이저 버전마다 바뀔 수 있다. 지원 범위를 Vitest 5.x로 고정하고 CI 매트릭스에서 확인한다.
- **모듈 최상위 코드의 mutant.** 모듈 평가 시점에 한 번만 실행되므로 `isolate: false`에서는 재평가되지 않을 수 있다. 처음에는 최상위 mutant를 빼고, 함수 본문 안의 mutant만 만든다.
- **스냅샷 테스트.** 반드시 `update: false`로 실행해서, mutant가 스냅샷을 바꾸면 killed가 되게 한다.
- **flaky 테스트.** mutant가 우연히 killed로 판정되는 방향이라서 판정이 느슨해질 뿐, 거짓 실패는 만들지 않는다. 기준 실행이 실패하면 전체를 중단한다.
- **브라우저 모드와 workspace.** 1차에서는 Node 환경만 지원한다. workspace는 project별로 `provide`를 호출하면 되므로 바로 지원한다.
- **실행 시간.** mutant 수 × 관련 테스트 시간만큼 걸린다. hit 기반 선택과 `bail: 1`로 줄이고, mutant 수 상한과 전체 timeout을 설정으로 둔다.

## 결정이 필요한 것

1. AST 처리 방식: (2) `oxc-parser` + TS로 시작할지, 처음부터 (1) Rust 코어 + napi로 갈지.
2. L3 정책의 기본값: `warn` / `fail` / `review`.
3. NoCoverage를 Survived와 똑같이 CI 실패로 볼지. 추천은 실패로 보는 것이다.
