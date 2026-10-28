# nyorori

AI가 만든 코드(와 사람이 만든 코드)의 PR 병합을 판정하는 **품질 게이트 묶음**이다. 원칙은 하나다.

> 리뷰어가 "단순하게 바꿔 달라"고 요청할 만한 변경은 병합하지 않는다.

이 판단은 수치 하나로 대신할 수 없으므로 두 층으로 나눈다.

- **기계적 차단(FAIL)**: 거의 모든 리뷰어가 단순화를 요구할 사례, 그리고 측정·테스트·설정이 약화된 사례를 결정론적으로 막는다.
- **리뷰 라우팅(트리거)**: 수치로는 판별할 수 없지만 의심스러운 *모양*(복잡도 재분배, 분기 은닉, 레거시 핫스팟 수정, 측정하지 못한 코드)을 감지하면 사람의 단순화 리뷰(G6)를 필수로 만든다.

복잡도 측정기는 [`moznion/cccc`](https://github.com/moznion/cccc) v1.8.5(commit `af2abb8f5`)이며, 정확한 바이너리를 sha256으로 고정한다. 설계 근거는 [`docs/SPEC.md`](docs/SPEC.md)(기획서 v0.9), 운영 방법은 [`docs/operations.md`](docs/operations.md)에 있다.

## Gates

| # | 체크 | 책임 | 실행 위치 | v1 기본 모드 |
|---|---|---|---|---|
| G1 | `gate/complexity` | 변경 단위의 Cognitive Complexity, B 대비 C (신규 ≤ 15, 기존 ≤ max(15, B)) | 게이트 서비스 | enforce |
| G2 | `gate/lint-structure` | Function 생성자 계열, `max-params` 4, `max-nested-callbacks` 3, bidi 문자, 억제 주석 추가. 분기 은닉·긴 함수는 트리거 | 게이트 서비스 | enforce |
| G3 | `gate/deps` | 새 런타임 순환 의존(차단), 금지 레이어 간선(P2부터), fan-out 트리거 | 게이트 서비스 | enforce |
| G4 | `gate/tests` | 테스트 통과·1개 이상 실행, 테스트 삭제·`.only`/`.skip`·assertion 없는 테스트·설정 약화 | 서비스(정적 검사) + Actions 산출물 | enforce |
| G5 | `gate/coverage` | 실행되지 않은 변경 분기 결과 | Actions 산출물 | observe |
| G6 | `gate/simplification-review` | 라우팅 트리거가 발화하면 독립 리뷰어의 승인 필수 | 게이트 서비스 | enforce |
| G7 | `gate/mutation` | 변경 행의 살아남은 변이 | Actions 산출물 | observe |
| — | `quality-gate` | 집계. **유일한 필수 체크** | 게이트 서비스 | — |

판정 상태와 종료 코드:

| 상태 | 의미 | 종료 코드 | check 결론 |
|---|---|---|---|
| `PASS` | 측정이 완전하고 정책을 충족 | 0 | success |
| `NOT_APPLICABLE` | 범위 안의 변경 없음 | 0 | success ("N/A") |
| `ACCEPTED_WITH_WAIVER` | 모든 FAIL이 유효한 waiver로 덮임 | 0 | success |
| `FAIL` | 작성자가 고칠 수 있는 정책 위반 | 1 | failure |
| `INCONCLUSIVE` | 측정을 신뢰할 수 없음 (**절대 통과가 아님**) | 2 | failure |
| (사용법 오류) | CLI 인자 오류 | 64 | — |

집계 우선순위는 `FAIL` > `INCONCLUSIVE` > `ACCEPTED_WITH_WAIVER` > `PASS` > `NOT_APPLICABLE`이다. `neutral`·`skipped`는 쓰지 않는다(GitHub는 필수 체크의 두 결론을 통과로 취급한다).

## Architecture

```
            B(병합 기준) · C(병합 후보) · P(신뢰 정책 JSON) · M(cccc sha256 + 인자 + runner)
                                   │
 ┌──────────── gate service (PR 코드를 실행하지 않음, App 키 보유) ────────────┐
 │ git/manifest   git diff --name-status -M -C, ls-tree → 분류·범위·문제        │
 │ git/tree       cat-file --batch로 blob에서 직접 트리 (.gitattributes 무력화)   │
 │ git/linemap    blob↔blob diff -U0 → hunk                                       │
 │ measure        cccc --no-config --no-cache, 검증 9항목, 결정론 표본, 소실 검사 │
 │ units          단위 트리·residue·포함 CogC, 4단계 대응("확실하지 않으면 신규") │
 │ gates/complexity  G1 판정 + S1 S2 S5 S8 S9 S10 S11                             │
 │ gates/lint        G2 (P의 ESLint 설정, --no-inline-config) + S4 S9 S10         │
 │ gates/deps        G3 (전체 트리 모듈 그래프, 새 순환 간선)                     │
 │ gates/tests       G4 정적 무결성 (blob) + 산출물의 테스트 결과                 │
 │ gates/coverage    G5,  gates/mutation  G7                                      │
 │ override · waivers · review(G6) · ailoop(12.2) → aggregate → quality-gate     │
 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                        │ 산출물 + GitHub API로 확인한 provenance
 ┌──── Actions: gate-untrusted-tests.yml (PR 코드 실행, contents: read, 시크릿 없음) ┐
 │ B·C 테스트(JSON 리포터), 변경 파일 커버리지, (선택) Stryker                        │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

코드 구조: `src/pipeline/run.ts`의 `runGates()`가 한 번의 (B, C, P, M) 판정 전체를 조립한다. CLI와 서비스, e2e 테스트가 모두 같은 함수를 쓴다.

## Quick start

```bash
scripts/fetch-cccc.sh            # 릴리스 자산을 sha256 pin·.sha256·attestation·verify-asset로 검증(불일치 시 중단). sha256 출력. 소스 빌드는 CCCC_FROM_SOURCE=1(pin 금지)
```

```bash
npm ci
```

```bash
npm run build
```

```bash
node dist/cli.js run --repo . --base origin/main --candidate HEAD \
  --policy policy/default.policy.json --cccc .nyorori-work/cccc-v1.8.5/cccc --out gate-out
```

`--out` 디렉터리에는 `manifest.json`, cccc 원본 `raw.B.json`/`raw.C.json`과 stderr, 게이트별 `gate-result.<gate>.json`, 집계 `quality-gate.json`, 사람이 읽는 `gate-summary.md`, AI 수정 루프용 `gate-feedback.json`이 생긴다.

로컬 실행에는 다음 옵션을 더 쓸 수 있다.

- `--artifacts <dir>`: required workflow 산출물과 같은 구조(`tests.C.json`, `tests.B.json`, `coverage/coverage-final.json`, `coverage-meta.json`, `mutation.json`, `metadata.json`). `provenance.json`이 없으면 산출물은 게이트를 **통과시키지 못한다**(차단만 가능).
- `--pr <pr.json>`: `{ comments, identity, teams, headSha, carryOver, quarterWaiversUsed }`. waiver·단순화 리뷰·override 명령을 재현할 때 쓴다.
- 기본 정책은 cccc sha256을 고정하지 않으므로, enforce 게이트가 있으면 `MEASURER_MISMATCH`(INCONCLUSIVE)다. 운영에서는 `measurer.cccc_sha256`에 attestation을 검증한 바이너리 해시를 넣고, 로컬 실험에서만 `measurer.allow_unpinned: true`를 쓴다.
- **이동 기준(spec 7.5)**: 변경 파일마다 기준 브랜치 first-parent 이력에서 "그 파일을 건드린 5번째 이전 commit"과 "B보다 30일 이상 앞선 마지막 commit" 중 더 오래된 쪽(파일 생성 시점보다 앞서지 않음)을 기준으로 S1·S9·S10·S12를 한 번 더 계산한다. 여러 PR에 나눈 조작이 합쳐 보인다. `triggers.moving_baseline.route`가 false(P1 기본값)이면 관측만 하고, P2에서 true로 바꾸면 G6 리뷰로 보낸다. 이 추가 계산이 실패해도 차단하지 않고 observe에 TOOL_ERROR로 남긴다.
- AI 수정 루프의 재시도는 `runGates({ previousAttempt })`로 직전 시도 C_{n−1}을 넘기면, C_{n−1}에서 G1 위반이 있던 파일의 S1·S9·S10을 C_{n−1} 대비로도 계산한다(ruling D17).
- `policy/default.policy.json`은 tests를 enforce로 두므로 산출물 없이 코드 변경을 판정하면 INCONCLUSIVE다. 산출물 없이 G1~G3만 보려면 정책에서 `tests.mode`와 `coverage.mode`를 `observe`로 둔다.

측정기 업그레이드 검사(spec 6.1):

```bash
node dist/cli.js fixtures --cccc /path/to/new/cccc
```

spec 3.3의 구문별 계산 규칙 픽스처(`test/fixtures/cccc-rules`)를 새 바이너리로 재생해 점수 차이를 모두 출력하고, 하나라도 다르면 1로 끝난다.

## Deploying the gate service

1. GitHub App을 만든다. 권한은 Checks: write, Contents: read, Pull requests: read, Issues: write(부채 이슈), Actions: read, Members: read(org)이고, 이벤트는 `pull_request`, `merge_group`, `issue_comment`를 구독한다.
2. 게이트 저장소의 commit을 조직 ruleset의 "Require workflows to pass before merging"으로 붙인다. 대상은 `templates/workflows/gate-untrusted-tests.yml`(이 저장소에서는 실행되지 않는 템플릿)이고, 그 저장소·경로·SHA를 정책 `provenance.trusted_workflows`에 넣는다.
3. 대상 저장소의 필수 체크는 `quality-gate` 하나만 두고, 예상 출처를 게이트 App으로 고정한다. merge queue를 켠다. 공식 판정은 `merge_group`이다.
4. 서비스를 실행한다. App 키는 이 프로세스에만 둔다.

```bash
NYORORI_APP_ID=123 NYORORI_PRIVATE_KEY_PATH=/secrets/app.pem NYORORI_WEBHOOK_SECRET=... \
NYORORI_POLICY=/etc/nyorori/policy.json NYORORI_CCCC=/opt/cccc/cccc NYORORI_WORKDIR=/var/lib/nyorori \
NYORORI_RUNNER_COMMIT=$(git rev-parse HEAD) node dist/cli.js serve --port 8080
```

서비스는 웹훅 서명(`X-Hub-Signature-256`)을 확인한 뒤 판정한다. B와 C 객체는 `NYORORI_WORKDIR/mirrors`의 bare mirror로 가져온다. 이때 토큰은 `GIT_CONFIG_*` 환경 변수로만 전달하고 argv나 remote 설정에는 남기지 않는다. 결과는 App이 만든 check run으로만 게시하며, 다른 App이나 PR workflow가 같은 이름으로 올린 체크는 읽지도 갱신하지도 않는다.

## PR comment commands

모든 명령은 새 댓글의 줄 맨 앞에 쓴다. 자세한 규칙은 `docs/operations.md` 3절.

| 명령 | 누가 | 바인딩 |
|---|---|---|
| `/gate-waive gate=… unit="…" metric=… ceiling=N reason="…"` | 누구나 (AI 루프 봇 제외) | 신청 |
| `/gate-waive-approve <id> blob=<C blob>` | `waiver_approvers` | 그 파일의 blob (단위 밖 변경은 이어짐) |
| `/simplification-review <VERDICT> sha=<PR head>` + `q1..q5: pass/fail` + 트리거별 `S<n>: 처분` | `simplification_reviewers` | `sha=` (patch-id 동일 rebase 또는 트리거 파일 무변경이면 이어짐) |
| `/gate-approve-tests key="<REASON>:<unit>" sha=<PR head> note="…"` | `gate_owners` | `sha=` (push마다 다시) |
| `/gate-override gate=… reason=… file="…" blob=<C blob> note="…"` 또는 `reason=NONDETERMINISM base=<B> candidate=<C>` | `gate_owners` | blob 또는 (B, C) |

- **수정된 댓글의 명령은 효력이 없다.** 쓰기 권한이 있으면 남의 댓글을 고칠 수 있기 때문이다. 게이트 요약에 "edited command ignored; post a new comment"로 표시된다. 명령을 지우거나 고치면 PR이 다시 평가된다.
- 인용(`>`와 그 연속 줄), 코드 블록(``` 와 ~~~, 들여쓰기 4칸), HTML 주석(`<!-- -->`) 안의 명령은 무시한다.
- 승인자는 PR 작성자, commit 작성자·committer·공동 작성자, AI 에이전트 호출자, 봇, (merge group이면) 그룹의 다른 PR 작성자가 아니어야 한다. 로그인에 연결되지 않은 commit 이메일이나 `Co-authored-by`가 있으면 **독립 승인자가 두 명** 필요하다. commit이 250개 이상인 PR은 독립성을 확인할 수 없어 승인을 받지 않는다.
- 게이트 요약은 현재 head SHA와 blob을 넣은 복사용 명령을 코드 블록 안에 보여 준다.

## Approvals, ledger and security limits

PR 댓글 명령(전체 문법은 [`docs/operations.md`](docs/operations.md) 3절):

```
/gate-waive gate=complexity unit="src/a.ts::run#function[0]" metric=cogc ceiling=18 reason="…"
/gate-waive-approve W1a2b3c4d5e blob=<그 파일의 C blob SHA>
/simplification-review NO_SIMPLIFICATION_NEEDED sha=<리뷰한 PR head SHA>
/gate-approve-tests key="TEST_REMOVED:test/a.test.ts::adds numbers" sha=<현재 PR head> note="…"
```

- **SHA 바인딩**: waiver 승인은 승인자가 본 파일 blob(`blob=`)에 묶인다. 이후 diff가 단위 범위를 건드리지 않으면 이어진다(ruling D15). 단순화 리뷰와 테스트 승인은 리뷰한 PR head(`sha=`)에 묶인다. 게이트 요약에 현재 SHA를 채운 복사용 명령이 나온다.
- **수정된 댓글**: `updated_at`이 `created_at`보다 2초 넘게 늦은 댓글의 명령은 무시한다. 쓰기 권한자는 남의 댓글을 고칠 수 있기 때문이다. 명령은 새 댓글로 단다.
- **두 승인자 규칙**: commit 작성자나 `Co-authored-by`의 신원을 로그인으로 확인할 수 없으면, 모든 승인(waiver, 단순화 리뷰, 테스트 승인, override)에 독립 승인자 두 명이 필요하다. PR commit이 250개 이상이면 승인을 받지 않는다.
- **산출물 zip 제한**: 아카이브 100 MiB, 항목 1,000개, 항목당 64 MiB, 읽는 항목 합계 512 MiB, 압축률 200배까지다. 이름이 허용 목록(`tests.C.json`, `coverage/coverage-final.json` 등)에 있는 항목만 읽는다. 위반하면 INCONCLUSIVE `UNTRUSTED_ARTIFACT`다.
- **waiver 원장**: 서비스는 판정을 게시할 때 (PR, head)별 판정을 `NYORORI_WORKDIR/verdicts`에 저장한다. PR이 병합되면(`pull_request` closed + merged) 그 head의 판정을 다시 읽어, 적용된 waiver를 `waivers.jsonl`에 한 줄씩 추가한다. 경로는 `NYORORI_LEDGER`로 바꿀 수 있고 기본값은 `NYORORI_WORKDIR/waivers.jsonl`이다. waiver마다 90일 기한의 `complexity-debt` 이슈도 연다. merge queue 판정이 있으면 그것을 PR 사전 확인보다 우선하고, 병합을 막는 판정이면 아무것도 기록하지 않는다. 같은 이벤트가 다시 와도 waiver id로 중복을 걸러서, 원장 줄과 이슈가 두 번 생기지 않는다. 분기별 예산(`waivers.per_quarter_budget`)은 이 원장으로 센다.

## Development

```bash
npm test                         # NYORORI_CCCC로 cccc 위치 지정 (기본 /home/user/moznion/cccc/target/release/cccc)
```

```bash
npm run typecheck
```

```bash
npm run lint
```

- `test/fixtures/cccc-rules`: spec 3.3 구문별 기대값(측정기 업그레이드 검사)
- `test/fixtures/manipulation`: spec 7.2 동작 보존 변환 17종과 `RESULTS.md`
- `test/e2e`: 실제 git 저장소와 실제 cccc로 spec 14 시나리오를 끝까지 실행
- `npm run gen:policy`: 빌드한 뒤 `dist/`의 스크립트로 스키마 기본값에서 `policy/default.policy.json`을 재생성

## Known limitations

- **측정할 수 없는 영역은 사람 몫이다.** 정직한 분할과 형식적 분할, 데이터 표와 클로저 표, 과잉 추상화는 트리거로 G6에 보낼 뿐 기계가 판정하지 않는다. S1은 정직한 리팩터링에도 발화한다.
- **신규 코드에는 S1·S9가 발화하지 않는다.** 두 트리거는 B에 집중된 원본이 있어야 비교할 수 있다. 처음부터 분기 은닉형으로 쓴 코드는 G2의 S9 선택자와 Function 생성자 차단에 의존한다.
- **cccc의 계산 특성**(논리 할당 무비용, 콜백 비가산, 이름 기반 재귀)은 고정해도 사라지지 않는다. 이를 G2와 트리거로 보완한다.
- **PR 코드를 실행해 얻은 증거(G4 테스트 결과, G5, G7)는 악의적인 PR이 위조할 수 있다**(spec 10.3). 이 게이트들은 최적화 압력을 막을 뿐이다.
- 측정 override된 파일에는 대체 측정기를 돌리지 않는다. 그 파일의 복잡도는 S6으로 필수가 된 단순화 리뷰에서 사람이 본다.
- waiver carry-over(ruling D15)는 승인 당시 blob이 서비스 mirror에 있어야 판단할 수 있다. 없으면 "변경됨"으로 보고 다시 승인받는다.
- 서비스는 issue comment가 게시된 시점의 head SHA를 "그 댓글로 처음 판정한 head"로 기록한다(`comment-heads.json`). 댓글과 push가 경합하면 승인이 stale로 처리된다(안전한 방향).
- `scripts/fetch-cccc.sh`의 릴리스 다운로드 경로와 워크플로 템플릿의 action SHA는 실제 환경에서 검증해야 한다.
