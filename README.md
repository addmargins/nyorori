# Nyorori

JS/TS PR을 위한 cccc 기반 품질 게이트입니다. 복잡도·구조·의존성·테스트·커버리지를 각각 판정하고, 점수만 낮춘 분할이나 분기 은닉은 독립된 사람의 단순화 리뷰로 보냅니다. 측정이 불완전하면 `INCONCLUSIVE`로 기록합니다.

**기본 정책은 P0 shadow입니다.** 관측 게이트의 `FAIL`을 지우지 않으며, 집계 결과와 `would_block`을 함께 제공합니다. 조직의 보정·정책 승인 후 `enforce`를 활성화합니다. 로컬 CLI 결과는 GitHub의 공식 병합 승인이 아닙니다.

## 빠른 시작

Node.js 24.11 이상 (`.node-version`: 24.19.0)과 Git이 필요합니다. 의존성은 lockfile에 고정되어 있습니다.

```bash
npm ci
npm run build
npm test
```

실제 측정기 계약까지 검사하려면 검증된 **Linux x86_64 cccc 1.8.5**를 대상 저장소 밖에 설치합니다. 프로덕션 설치 경로는 릴리스 체크섬·attestation·릴리스 자산 검증을 모두 요구합니다. 최신 `gh`와 GitHub/Sigstore 검증 대상에 대한 네트워크 접근이 필요합니다.

```bash
bash scripts/install-cccc.sh /absolute/trusted/tools/cccc/1.8.5
NYORORI_REAL_CCCC=/absolute/trusted/tools/cccc/1.8.5/cccc npm test
npm run demo -- --cccc /absolute/trusted/tools/cccc/1.8.5/cccc
```

데모는 임시 Git 저장소에 CogC 21인 새 함수를 만들고 원본 측정·위반·누락된 테스트 증거를 보고합니다. shadow 집계 `PASS`와 G1 `FAIL`이 함께 나타나는 것이 의도된 동작입니다.

## 저장소 분석

[예제 정책](examples/policy.json)을 **대상 Git checkout 밖**으로 복사해 `measurement.binary`, 범위, 보호 경로, 역할과 커버리지 provider를 설정합니다. 정책·측정기를 후보 브랜치에서 읽을 수 없습니다. 결과 디렉터리도 대상 저장소 밖의 새 디렉터리 또는 빈 디렉터리여야 합니다.

```bash
node dist/cli.js analyze \
  --repo /absolute/application \
  --base BASE_SHA --candidate CANDIDATE_SHA \
  --repository owner/application \
  --policy /absolute/trusted/policy.json \
  --out /absolute/reports/run-001
```

필요하면 `--evidence /absolute/trusted/evidence.json`과 `--rolling-base SHA`를 추가합니다. 이동 기준을 지정하지 않으면 B의 first-parent 이력에서 최대 5개 커밋 전 상태를 사용합니다. 이 근사는 정책 초안의 “직전 5회 병합 또는 30일”과 다릅니다. 정확한 조직 기준은 `--rolling-base`로 공급합니다. 이동 기준의 S1/S9/S10은 P0/P1에서 관측만 합니다.

종료 코드는 `0`(적용 중인 차단 게이트 수용 또는 shadow), `1`(확인된 위반), `2`(필수 증거·측정 불완전)입니다. GitHub에서는 `INCONCLUSIVE`를 반드시 `failure`로 보냅니다.

| 산출물               | 내용                                               |
| -------------------- | -------------------------------------------------- |
| `manifest.json`      | B/C별 경로·Git blob·모드·측정 분류                 |
| `raw.B.*`, `raw.C.*` | 원본 JSON·stderr 및 배치별 원본·직렬 재실행        |
| `gate-result.json`   | 모든 G1~G7 판정, B/C/P/M, trigger·waiver·관측 자료 |
| `gate-summary.md`    | 위반을 먼저 보여 주는 사람용 보고서                |
| `gate-feedback.json` | AI 수정 루프용 위반·금지 행위·재시도 계약          |

`agent-feedback.json`은 같은 피드백의 별칭입니다. 같은 B/C/P/M의 반복 실행은 동일한 정규화 결과를 만듭니다. 실행마다 별도 출력 디렉터리를 사용합니다.

## 게이트와 신뢰 경계

| 게이트                   | 구현                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| G1 complexity            | 변경 단위와 중첩 함수·module residue, CogC 15, 기존 부채 비악화, 보수적 1:1 대응       |
| G2 lint-structure        | 신뢰 ESLint·TS parser, 동적 코드 생성·새 억제·bidi·params·callback 검사, S4/S9/S10/S11 |
| G3 deps                  | 정적 import 그래프의 신규 순환·금지 간선·S3; 미지원 resolver는 INCONCLUSIVE            |
| G4 tests                 | 서명된 B/C 테스트 결과·0개 실행·실패·테스트 소실·focus/skip·assertion·보호 경로 검사   |
| G5 coverage              | 고정 provider의 Istanbul 변경 분기 결과·변경 함수·누락 파일 검사                       |
| G6 simplification-review | S8을 제외한 라우팅 신호에 현재 head·루브릭·독립 역할 승인을 요구                       |
| G7 mutation              | 외부 Stryker 결과 관측; 변이 테스트 자체는 격리 CI에서 실행                            |

G1~G3은 후보의 설정·플러그인·테스트를 실행하지 않습니다. Git blob에서 직접 입력을 만들므로 `.gitattributes`와 checkout 필터가 측정 내용을 바꾸지 못합니다. cccc 해시·버전·출력·manifest·stderr·parse error·residue·시간을 검사하고, 모든 C 배치를 `-j1`로 다시 실행해 byte 일치를 검증합니다.

G4/G5/G7은 비신뢰 CI에서 나온 결과를 신뢰된 attestor가 출처 검증 후 서명한 경우에만 사용합니다. 서명은 저장소, B/C, 정책 내용 해시, 측정 fingerprint와 만료 시간에 묶입니다. 리뷰·waiver도 역할·독립성·head·blob 범위를 검사합니다. 생성자 탐지는 알려진 우회에 대한 방어이며 JS의 모든 동적 실행을 증명하는 분석은 아닙니다.

## 서비스와 운영

- [검증 결과](docs/VALIDATION.md): 실제 실행 결과와 운영 검증의 범위.
- [배포 지침](docs/DEPLOYMENT.md): GitHub App, merge queue, 영속 큐, 별도 worker, App 출처 고정 ruleset.
- [증거 계약](docs/EVIDENCE.md): 외부 CI attestor·Ed25519 서명·권한 있는 승인 자료.
- [정적 검사 범위](docs/STATIC-GATES.md): 지원 resolver와 안전하게 닫히는 조건.
- [설계 결정](docs/DECISIONS.md): 설계·보안·QA 교차 검토의 합의 및 초안 대비 차이.
- [원본 기획서](docs/PRODUCT-SPEC.v0.9.md): 사용자가 제공한 v0.9.

```bash
NYORORI_SERVICE_CONFIG=/absolute/trusted/service.json npm run service
node dist/replay.js --repo /absolute/mirror.git --pairs /absolute/trusted/pairs.json \
  --policy /absolute/trusted/policy.json --out /absolute/replay-report
```

서버는 `merge_group/checks_requested`만 공식 판정으로 처리합니다. App 비밀키는 후보 Actions에 두지 않습니다. 분석 worker는 별도 프로세스로 메모리·시간을 제한하며, 프로덕션에서는 별도 사용자 또는 컨테이너·cgroup·읽기 전용 마운트·외부 네트워크 차단도 적용해야 합니다. 같은 UID 프로세스 분리는 파일 접근 보안 경계가 아닙니다.

실제 조직의 App 설치, merge queue/ruleset, 신뢰 workflow·attestor, 역할과 정책 책임자, 과거 PR 재생·shadow 보정은 운영자가 구성해야 합니다. 이 저장소의 로컬 검증은 실제 조직 배포나 임계값 보정을 대신하지 않습니다.

## 알려진 범위와 결정

- 지원 대상은 JS/TS입니다. SFC·미측정 코드 형식은 S11, 등록되지 않은 확장자는 INCONCLUSIVE로 처리합니다.
- G3은 dependency-cruiser 대신 고정 TS AST 그래프를 사용합니다. 경로 별칭·workspace·사용자 번들러 설정 등의 미지원 조건은 통과시키지 않습니다.
- G4의 정적 테스트 검사는 Vitest/Jest의 표준 `test`/`it`/`expect` 형식에 맞춥니다. 동적 테스트 ID·지원하지 않는 형식은 수동 통과 대신 INCONCLUSIVE입니다.
- G5는 변경된 모든 계측 함수의 미실행도 보고합니다. 초안의 “변경 export 함수”보다 보수적입니다.
- 자동 수정을 실행하지 않습니다. `planRepair`는 동일한 B/P/M, 최대 2회, 진전 없음·새 트리거·정책/테스트 약화의 조기 중단만 결정하며 실제 수정은 시크릿 없는 별도 executor가 맡습니다.
- LLM 리뷰어·90일 GitHub 부채 이슈·조직 승인 UI는 외부 운영 연동입니다. 이 구현은 LLM을 차단 판정에 사용하지 않습니다. waiver 적용 증거는 결과에 보존됩니다.
- 첨부 문서가 언급하는 원본 픽스처 압축 파일은 제공되지 않았습니다. 저장소에는 독립적으로 작성한 수용·우회·실제 측정기 픽스처가 포함되어 있습니다.

MIT License.
