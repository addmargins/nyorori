# nyorori 운영 가이드

이 문서는 게이트를 운영하는 사람을 위한 것이다. 판정 규칙의 근거는 `docs/SPEC.md`(기획서 v0.9)에 있고, 여기서는 역할, 명령, 장애 대응, 도입 단계만 다룬다.

## 1. 신뢰 경계 요약

| 구성 요소 | 실행 위치 | PR 코드 실행 | 비밀 |
|---|---|---|---|
| G1 복잡도, G2 구조 lint, G3 의존성, 집계기 `quality-gate` | 게이트 서비스 (GitHub App 백엔드, `src/service`) | 하지 않음. git blob에서 직접 트리를 만든다 | App 비공개 키 (서비스에만) |
| G4 테스트·무결성, G5 변경 분기 커버리지, G7 변이 | Actions `templates/workflows/gate-untrusted-tests.yml` (조직 ruleset의 필수 workflow로 붙인다) | 함 | 없음 (`contents: read`, 토큰 비영속) |

- 필수 체크는 `quality-gate` 하나이며, 예상 출처를 게이트 App으로 고정한다. 출처를 "GitHub Actions"로 고정하면 PR의 workflow도 같은 이름의 체크를 성공으로 올릴 수 있다.
- 서비스는 같은 이름이라도 자기 App이 만들지 않은 체크를 읽지도 갱신하지도 않는다(`ownCheckRuns`).
- Actions 산출물은 `gate-result.json`의 내용이 아니라 **GitHub API에서 읽은 run 정보**(workflow 경로, workflow SHA, head SHA, event, run attempt)로 출처를 확인한다. 산출물 안의 `metadata.json`은 신뢰하지 않는다.
- `pull_request_target`은 쓰지 않는다.
- **테스트 증거 대기.** push 직후에는 필수 workflow가 아직 돌고 있어 G4·G5·G7의 산출물이 없다. 이때 서비스는 REPORT_MISSING을 게시하지 않고, G1~G3 결과를 체크 본문에 실어 `quality-gate`를 **in_progress**("waiting for test evidence (<workflow>)")로 두고 작업을 `waiting`으로 저널에 적는다(merge queue는 in_progress 체크를 기다리므로 PR이 큐에서 빠지지 않는다). App은 `workflow_run` 이벤트를 구독해야 하며, 신뢰 workflow의 완료 run이 대기 중인 head(pull_request면 PR head, merge_group이면 C)와 일치하면 평가를 재개한다. 다른 head·다른 workflow의 run은 무시한다. 웹훅을 놓쳐도 매 이벤트와 60초 타이머의 sweeper가 완료 run을 API에서 찾아 재개하고, `tests.evidence_wait_minutes`(기본 90)를 넘기면 `INCONCLUSIVE(REPORT_MISSING, "no evidence from <workflow> within N minutes")`를 게시한다. 대기 중 새 push가 오면 이전 대기는 새 대기로 대체된다. Actions 게이트가 모두 observe/degraded면 기다리지 않는다. run이 실패로 끝났지만 보고서가 있으면 그것은 대기가 아니라 `TESTS_FAILED`다. 대기 상태는 저널에 있으므로 재시작 후 `replayPendingJobs`가 다시 arm한다.

## 2. 역할 (기획서 16.1)

| 정책 키 | 역할 | 할 수 있는 일 |
|---|---|---|
| (정책 책임자, P 저장소 CODEOWNER) | 엔지니어링 리드 1인 | 임계값, 단계 전환, P 변경 최종 승인 |
| `review.gate_owners` | 플랫폼/DevEx 팀 | 측정 override, cccc 업그레이드, 장애 대응 |
| `review.simplification_reviewers` | 저장소별 선임 엔지니어 2인 이상 | G6 단순화 리뷰 승인 (목표 응답 영업일 1일) |
| `review.waiver_approvers` | 저장소 CODEOWNER 중 지정 | waiver 승인, 90일 부채 이슈 처리 |
| `review.bots`, `ai_loop.bot_accounts` | 봇 | 어떤 승인도 할 수 없다. AI 루프 봇은 waiver를 신청할 수도 없다 |

명단 항목은 로그인(`alice`) 또는 팀(`@org/team`)이다. 서비스가 팀 소속을 확인하지 못하면 그 팀은 아무에게도 권한을 주지 않는다(fail closed).

**승인자 독립성** (waiver, 단순화 리뷰, override 공통): 승인자는 PR 작성자, PR의 어떤 commit의 author·committer·`Co-authored-by` 공동 작성자, AI 에이전트를 호출·할당한 사람, 봇이 아니어야 한다. GitHub noreply 주소(`123+login@users.noreply.github.com`)와 확인된 이메일로도 대조한다. 웹 UI commit의 committer `web-flow`는 사람으로 보지 않는다.

## 3. PR 댓글 명령

명령은 GitHub가 렌더링한 화면에서 보이는 일반 문단의 줄 맨 앞에서만 인식한다. 인용(`>`와 그 lazy 연속 줄), 코드 블록(``` 와 ~~~ 펜스, info string 포함, 같은 문자로 같은 길이 이상일 때만 닫힘; 빈 줄 뒤 4칸 들여쓰기), HTML 주석(`<!-- -->`, 닫히지 않으면 끝까지) 안의 명령은 무시한다. 그래서 남의 승인을 인용해도 다시 발급되지 않고, 보이지 않는 명령도 없다. 게이트가 PR 댓글에 보여 주는 "복사용 명령"은 코드 블록 안에 있어 그 자체로는 효력이 없다.

**수정된 댓글.** 쓰기 권한이 있는 사람은 다른 사람의 댓글을 수정할 수 있다. 그래서 `updated_at`이 `created_at`보다 2초 넘게 늦은 댓글의 명령은 모두 무시하고, 게이트 요약에 "edited command ignored; post a new comment"로 표시한다. 명령을 고치려면 새 댓글을 단다. 댓글을 수정하거나 지워서 명령이 사라지면(`changes.body.from`) PR을 다시 평가하므로, 승인 철회가 바로 반영된다.

**독립성을 확인할 수 없을 때.** 로그인에 연결되지 않은 commit 작성자·committer 이메일, 또는 GitHub noreply가 아니고 연결된 commit 이메일도 아닌 `Co-authored-by`가 하나라도 있으면, 그 사람이 승인자일 수 있으므로 waiver, 단순화 리뷰, 테스트 승인, override 모두 **독립 승인자 두 명**이 필요하다. GitHub는 PR commit을 250개까지만 나열하므로, 250개 이상이면 승인을 아예 받지 않는다(PR을 나누거나 squash). merge group에서는 그룹에 든 모든 PR의 작성자와 commit을 합쳐 판단한다.

### 3.1 waiver (FAIL에 대한 위험 수용)

```
/gate-waive gate=complexity unit="src/a.ts::Parser>run#method[0]" metric=cogc ceiling=22 reason="명시적 상태 전이, 분할하면 더 읽기 어렵다" [expires=2026-12-31]
```

- `unit`은 게이트 결과의 단위 키를 그대로 복사한다. 와일드카드, 파일 단위, PR 단위 waiver는 없다.
- 분기 예산: `waivers.per_quarter_budget`은 서비스의 원장(`FileLedgerStore`, `waivers.jsonl`)에서 이번 UTC 분기에 기록된 waiver 수를 세어 적용한다. 읽을 수 없는 줄은 사용한 것으로 센다.
- waiver 가능한 게이트: `complexity`, `lint-structure`, `deps`, `coverage`, `tests`(`TESTS_FAILED_ON_BASE`만).
- waiver 불가 (판정 D14): 모든 INCONCLUSIVE(측정 override 대상), G4 무결성(`TEST_REMOVED`, `TEST_FOCUS_OR_SKIP`, `TEST_CONFIG_WEAKENED` — 3.4절 테스트 승인 대상), `TESTS_FAILED`, 보호 경로(`PROTECTED_PATH_MODIFIED`, `POLICY_PATH_MODIFIED`), 우회 벡터(`DYNAMIC_CODE`, `BIDI_CONTROL`, `SUPPRESSION_ADDED`), 리뷰 결과.
- waiver 가능한 변형: `tests` 게이트에서는 `TESTS_FAILED_ON_BASE`(B에서도 실패하던 테스트, `details.base_broken`이 붙은 `TESTS_FAILED` 포함)와 `TEST_NO_ASSERTION`, `lint-structure`에서는 `@ts-ignore` 같은 waiver 가능한 억제(`SUPPRESSION_ADDED_WAIVABLE` 또는 `details.waivable`)다.
- 수치가 없는 위반(실패한 테스트, 억제 주석)은 `metric=<사유 코드> ceiling=0`으로 신청한다. 예: `metric=TESTS_FAILED_ON_BASE ceiling=0`.

승인:

```
/gate-waive-approve W1a2b3c4d5e blob=<그 파일의 C blob SHA>
```

- `blob`은 승인자가 본 코드의 blob이다. 게이트 요약이 현재 blob을 넣은 명령을 보여 준다(줄 끝 `# 단위` 주석은 복사해도 무시된다). 파일이 바뀌어도 바뀐 hunk가 그 단위의 범위 밖이면 waiver는 이어진다(판정 D15). 단위 범위 안이 바뀌었거나 판단할 수 없으면 무효다.
- 유효 조건: 승인자가 `waiver_approvers`이고 독립적이며 신청자 본인이 아님, blob 일치, 만료 전(승인 후 `waivers.max_days`일 또는 `expires` 중 이른 날), 단위 값 ≤ `ceiling`, PR당 예산(`waivers.per_pr_budget`) 안.
- 적용된 waiver는 S6 트리거를 낸다. 승인자가 `simplification_reviewers`에도 속하면 같은 승인으로 그 S6이 해제된다.
- 병합 후 `waivers.jsonl` 원장에 한 줄을 추가하고 90일 기한의 `complexity-debt` 이슈를 연다(`ledgerLine`, `debtIssue`). 병합된 값은 다음 PR의 기준 점수가 되므로, 원장 크기와 연령을 매주 본다.

### 3.2 측정 override (INCONCLUSIVE에 대한 조치)

실행 단위 override (파일 없는 `NONDETERMINISM`만):

```
/gate-override gate=complexity reason=NONDETERMINISM base=<B> candidate=<C> note="runner 교체 중 -j1 재측정 불일치"
```

이번 (B, C) 실행에만 묶인다. 그 INCONCLUSIVE를 걷어내되 "재측정 필요" 메모를 남기고 S6으로 단순화 리뷰를 필수로 만든다. 파일 없는 override는 `NONDETERMINISM`만 가능하다. `MEASURER_MISMATCH`와 `SCHEMA`는 측정기 실행 전체에 대한 문제라 override 대상이 아니며, 게이트 담당자가 P(바이너리 고정, 업그레이드)에서 고친다.

파일 단위 override:

```
/gate-override gate=complexity reason=PARSE_ERROR_CANDIDATE file="src/a.ts" blob=<C blob SHA> note="oxc가 아직 `accessor`를 지원하지 않음"
```

- `gate_owners`만, 작성자가 아닌 사람만 걸 수 있다.
- 대상 사유: `INVARIANT_VIOLATION`, `NONDETERMINISM`, 그리고 `parser_lag_allowlist`에 있는 문법의 `PARSE_ERROR_CANDIDATE`.
- 작성자가 고칠 원인(구문 오류, 1000단계 초과 중첩, 비 UTF-8, 설정 없는 JSX-in-`.js`)은 override 대상이 아니다. 허용하면 일부러 심어 파일을 영구히 측정 밖으로 빼는 경로가 된다. 예외는 `parser_lag_allowlist`에 있는 문법의 파싱 오류뿐이다(측정기는 지연과 실제 구문 오류를 구별하지 못하므로 목록이 결정한다).
- 파일 경로가 없는 전역 측정 실패(예: 바이너리 해시 불일치)는 override하지 않는다. 측정기를 고친다.
- 효과: 그 파일을 `MEASUREMENT_OVERRIDE`로 unmeasured 처리하고, S6으로 단순화 리뷰를 필수로 만든다. 그 파일의 복잡도는 리뷰어가 직접 본다(대체 측정기는 돌리지 않는다). **FAIL을 PASS로 바꾸지 않는다.**

### 3.3 단순화 리뷰 (G6)

```
/simplification-review REQUIRED sha=<리뷰한 PR head의 40자리 SHA>
q1: pass
q2: fail src/billing/plan.ts:42 processPart2는 지역 변수 5개를 끌고 다니는 단일 호출 helper
q3: pass
q4: pass
q5: pass
```

- 판정: `NO_SIMPLIFICATION_NEEDED`, `SUGGESTED`(차단 안 함), `REQUIRED`(차단).
- 승인(`NO_SIMPLIFICATION_NEEDED`, `SUGGESTED`)에는 발화한 라우팅 트리거마다 한 줄 처분이 있어야 한다(판정 D13). 예: `S1: helper마다 이름 있는 가격 규칙이다`. 빠진 트리거가 있으면 승인으로 세지 않는다. 승인 뒤 새로 발화한 트리거는 그 승인으로 덮이지 않는다.
- 각 문항은 `pass`/`fail`로 답한다. 질문의 긍정·부정 표현에 따라 의미가 뒤집히지 않게 하기 위해서다. `fail`에는 `file:line` 근거가 반드시 있어야 한다.
  1. 같은 동작을 훨씬 적은 개념이나 행으로 쓸 수 없다.
  2. 새 helper·모듈·매개변수·옵션 객체·제네릭은 두 곳 이상에서 쓰이거나 이름 붙일 수 있는 도메인 개념이다.
  3. 추측성 일반화, 죽은 코드, 중복 로직, 불가능한 일에 대한 방어 코드가 없다.
  4. 중첩된 제어 흐름을 더 평평하게 만들 여지가 없다.
  5. 독자가 다른 새 정의를 두 번 넘게 따라가지 않고 각 변경 함수를 이해할 수 있다.
- `REQUIRED`는 q1~q4 중 하나 이상 `fail`일 때만, `NO_SIMPLIFICATION_NEEDED`는 q1~q4가 모두 `pass`일 때만 유효하다.
- 같은 리뷰어의 나중 댓글이 이전 것을 대체한다. 유효한 `REQUIRED`가 하나라도 있으면 다른 승인이 있어도 차단한다.
- 명령에는 리뷰한 head를 `sha=`로 적어야 한다. 승인은 그 SHA에 묶인다(게이트 요약이 현재 head SHA와 발화한 트리거 줄을 채운 복사용 명령을 보여 준다). 새 push 뒤에는 (a) patch-id가 같은 rebase이거나 (b) 새 commit이 트리거된 파일을 하나도 건드리지 않았을 때만 이어진다. 파일이 없는 트리거(예: 모듈 구조 S3)는 rebase에서만 이어진다.
- LLM 리뷰어의 판정은 v1에서 기록만 한다.

### 3.4 테스트 승인 (G4 무결성)

```
/gate-approve-tests key="TEST_REMOVED:test/a.test.ts::adds numbers" sha=<현재 PR head> note="b.test.ts로 옮김"
```

- `TEST_REMOVED`, `TEST_CONFIG_WEAKENED`만 대상이다. `key`는 게이트 결과가 위반마다 보여 주는 값이다.
- `gate_owners`이고 독립적인 사람만 할 수 있다. `sha=`가 평가 중인 head와 같을 때만 유효하며, 새 push 뒤에는 다시 승인한다.
- waiver가 아니라 승인으로 기록되며(`waivers_applied`의 `metric: "test-approval"`), waiver 예산을 쓰지 않는다.

## 4. 판정 상태와 체크 표현

| 상태 | 체크 결론 | 제목 |
|---|---|---|
| PASS | success | `PASS` |
| NOT_APPLICABLE | success | `N/A` |
| ACCEPTED_WITH_WAIVER | success | `PASS with waiver: …` (적용된 waiver·테스트 승인 항목을 몇 개 나열) |
| FAIL | failure | 첫 위반 |
| INCONCLUSIVE | **failure** | `INCONCLUSIVE: <사유>` |

`neutral`과 `skipped`는 쓰지 않는다. GitHub가 필수 체크에서 둘을 통과로 취급하기 때문이다. 관측 모드 하위 체크(`gate/<id>`)는 정보용이라 success로 남기고 제목 앞에 `[observe]`를 붙인다.

집계기 규칙:

- 게이트의 모드는 산출물이 아니라 정책 P에서 읽는다.
- enforce 모드 게이트가 보고하지 않으면 `INCONCLUSIVE(REPORT_MISSING)`. 실행되지 않은 게이트는 통과가 아니다. 문서만 바뀐 PR도 모든 게이트가 N/A를 보고해야 한다.
- 이번 실행의 B·C·P·runner와 다른 결과는 `FINGERPRINT_MISMATCH`.
- 결과가 주장하는 상태는 그 내용에서 다시 계산한 상태보다 관대할 수 없다(위반이 있는데 PASS라고 주장하면 FAIL).
- 관측 모드 게이트는 집계에서 빠진다. 트리거도 빠지지만 S6, S11은 예외로 항상 라우팅된다(판정 D16: 측정 탈출은 shadow에서도 사람에게 가야 한다).
- `degraded` 모드 게이트는 차단하지 않는다. 대신 그 게이트의 열린 FAIL, INCONCLUSIVE, 라우팅 트리거가 단순화 리뷰를 필수로 만든다(증거 `degraded gate <id>: <사유>`). 보고하지 않아도 리뷰가 필수다.
- `waivedBy`는 서비스가 적용한 waiver(또는 테스트 승인)만 믿는다. Actions 산출물의 `waivedBy`, `waivers_applied`에 없는 id, waiver 불가 사유에 붙은 `waivedBy`는 버린다.
- pull_request 증거: run의 head는 PR head여야 하고, run이 실제로 검사한 test merge(메타데이터의 `candidate_sha`)가 C여야 한다. merge_group은 run head가 C여야 한다.
- Actions 산출물은 run의 event가 평가 종류(pull_request / merge_group)와 같아야 하고, run의 conclusion이 `success`가 아니면 실패의 증거로는 쓰되 통과의 증거로는 쓰지 않는다. 압축 파일은 다운로드 100 MB, 항목 1,000개, 풀린 크기 합 512 MB, 항목당 64 MB와 압축비 200배로 제한하고, 겹치거나 범위를 벗어난 헤더를 거부하며, 필요한 항목만 푼다. 위반은 `INCONCLUSIVE(UNTRUSTED_ARTIFACT)`다.
- 웹훅은 delivery id와 서명된 본문의 sha256 양쪽으로 중복을 거르고, `X-GitHub-Event`가 본문 모양과 맞지 않으면 400으로 거부한다(이벤트 헤더는 서명 밖에 있다).
- 같은 PR의 평가는 한 번에 하나씩 돌고, 이벤트가 도착할 때마다 세대 번호를 받는다. 더 새 세대가 시작된 평가는 결과를 게시하지 않는다.
- 체크 실행은 `external_id = <B>:<C>:<P revision>`로 구분한다. 같은 head에 대한 동시 평가가 서로의 체크를 덮어쓰지 않으며, 평가가 끝났을 때 B/C가 더 이상 현재가 아니면 자기 체크를 `SUPERSEDED`(failure)로 닫는다.

## 4a. 운영 환경 요구사항

### OS 격리

게이트 서비스는 PR 코드를 실행하지 않지만, PR이 통제하는 입력(git blob, Actions 산출물, 댓글 본문)을 파서와 cccc에 먹인다. 분석 작업이 별도 자식 프로세스로 돌더라도 그것은 **프로세스 경계이지 샌드박스가 아니다** (같은 UID, 같은 파일시스템, 같은 네트워크). 운영에서는 다음을 추가한다.

- 서비스 전체를 전용 사용자 또는 컨테이너로 돌린다. App 비공개 키와 webhook 시크릿을 읽을 수 있는 것은 그 사용자뿐이다.
- 분석 자식(cccc, ESLint, dependency-cruiser)은 다시 별도 사용자/네임스페이스로 돌리고 네트워크를 차단한다(예: `unshare -n` 또는 네트워크 없는 컨테이너). 분석은 네트워크가 필요 없다. 필요한 것은 bare mirror와 측정기 바이너리뿐이다.
- cgroup으로 메모리(분석 자식 1 GiB 정도)와 CPU를 제한하고, 벽시계 제한(정책 `measurer.timeout_ms`, 기본 120 s)을 넘기면 프로세스 그룹째 죽인다.
- `NYORORI_WORKDIR`은 서비스 사용자만 읽고 쓰며(0700), 측정기 바이너리와 정책 파일은 읽기 전용 마운트에 둔다. 정책·측정기·작업 디렉터리는 대상 저장소 경로 안에 두지 않는다.

### 시크릿과 교체

| 시크릿 | 위치 | 교체 |
|---|---|---|
| App 비공개 키 | `NYORORI_SIGNER=command`(권장): 키는 KMS/HSM에 두고 `NYORORI_SIGNER_COMMAND`(argv JSON 배열)가 stdin의 JWT 서명 입력에 RS256 서명을 해 base64url로 stdout에 낸다. 이 프로세스(적대적 git 객체·zip을 파싱하는 곳)에는 키가 들어오지 않는다. `NYORORI_SIGNER=file` + `NYORORI_PRIVATE_KEY_PATH`: 서비스 프로세스만 읽는 파일(0400). 어느 쪽이든 Actions 시크릿에는 절대 두지 않는다(spec 10.1) | command: KMS에서 키를 교체하고 App에 새 공개키를 등록한다(재시작 불필요). file: GitHub App 설정에서 새 키를 만들고 파일을 바꾼 뒤 재시작. 옛 키는 새 키로 발급된 체크가 보인 뒤 삭제 |
| webhook 시크릿 (`NYORORI_WEBHOOK_SECRET`) | 환경 변수 또는 0400 파일 | GitHub App의 webhook 시크릿을 바꾸고 재시작. 서명이 맞지 않는 배달은 401로 거부되므로 교체 중 몇 건은 GitHub에서 재전송한다 |
| 설치 토큰 | 메모리에만. 저장소 하나와 사용 권한(checks: write, contents: read, pull_requests: read, issues: write, actions: read, members: read)으로 범위를 좁혀 발급 | 1시간 만료, 5분 전 재발급. 디스크에 쓰지 않는다 |

App에 위 권한 중 하나라도 없으면 토큰 발급 자체가 거부된다. 서비스가 반쯤의 권한으로 도는 것보다 낫다.

### `NYORORI_WORKDIR`의 크기와 보존

| 하위 경로 | 내용 | 크기 상한·보존 |
|---|---|---|
| `mirrors/<owner>/<repo>.git` | bare mirror(B, C, 승인이 가리킨 head) | 저장소당 수백 MB까지 자란다. 주 1회 `git -C … gc --prune=now`; 60일 넘게 평가가 없던 mirror는 삭제(다음 평가가 다시 만든다) |
| `runs/` | 평가별 산출물(manifest, cccc 원본 JSON, gate-result) | 평가당 수 MB. 14일 보존 후 삭제; 분쟁 중인 PR의 것은 이슈에 첨부해 둔다 |
| `verdicts/` | 게시된 판정(병합 시 waiver 기록용) | PR·head당 수 KB. 병합되거나 닫힌 PR은 90일 후 삭제 |
| `comment-heads.json` | PR별 관측한 head 타임라인 | 작음. 닫힌 PR 항목은 90일 후 제거 |
| `jobs/<owner>/<repo>/<delivery>.json` | 작업 저널(queued/running/done/superseded/failed) | `JobJournal.prune(30일, 저장소당 1000개)`를 시작 시와 하루 한 번 호출 |
| `deliveries.log` | 본 배달 id와 본문 sha256 | 10,000개로 자동 압축 |
| `waivers.jsonl`, `debt-issues.json` | waiver 원장, 열린 부채 이슈 | 삭제하지 않는다(감사 기록). 백업 대상 |

가지치기 규칙: 디스크 사용량이 할당량의 80%를 넘으면 `runs/` → 오래된 mirror → 종료된 작업 저널 순으로 지운다. 원장과 판정은 지우지 않는다. 디스크가 가득 차면 평가가 INCONCLUSIVE(TOOL_ERROR)로 실패하므로, 80%에서 경보를 울린다.

### 상태 확인과 모니터링

- `GET /healthz`: 리스너가 살아 있고 저널·작업 디렉터리에 쓸 수 있음을 뜻한다. App 연결, mirror 신선도, 측정기 상태는 증명하지 않는다.
- 로그(stderr, JSON 한 줄씩)에서 볼 지표: `evaluated`(상태별 비율 — 13.4의 장애 기준), `evaluation failed`, `artifact rejected`/`artifact not bound to its run`, `journal write failed`, `replaying job`.
- 경보 조건: 15분 넘게 `quality-gate`가 in_progress인 PR(평가 실패 후 게시 실패), 1시간 동안 INCONCLUSIVE 비율이 직전 4주 평균의 3배, 디스크 80%, 저널의 `failed` 증가.
- 재시작 시 `replayPendingJobs`가 queued/running 작업을 다시 보내고 `waiting` 작업을 다시 arm한다. 재생된 작업은 GitHub에서 모든 상태를 다시 읽으므로, 오래된 것은 SUPERSEDED로 끝난다.
- 대기 지표: 저널의 `waiting` 수, 평균 대기 시간, 기한 초과로 REPORT_MISSING이 된 수(`sweepWaiting`의 `expired`). 기한 초과가 반복되면 필수 workflow가 돌지 않거나 `workflow_run` 구독이 빠진 것이다.

### 검증 경계 (테스트가 증명하지 않는 것)

- **실제 GitHub 왕복이 없다.** 서비스 테스트는 가짜 클라이언트와 가짜 fetch로 App JWT, 토큰 범위, 체크 실행, 산출물 바인딩, 재생, 중복 배달을 검사한다. App 설치, 권한 부여, ruleset의 필수 체크·필수 workflow, merge queue 동작은 운영 조직에서 따로 확인해야 한다.
- **200개 PR 재생을 실제로 돌리지 않았다.** `nyorori replay`는 있지만 실제 조직 이력에 대한 보정(13.2)은 P0/P1에서 한다.
- **cccc는 로컬 빌드다.** 테스트는 소스에서 빌드한 v1.8.5 바이너리를 쓴다. attestation을 검증한 릴리스 자산과 그 sha256 고정은 설치 시점의 절차이며, 기본 정책은 핀이 비어 있으면 INCONCLUSIVE(MEASURER_MISMATCH)로 막는다.
- **OS 격리는 코드로 보장되지 않는다.** 위 OS 격리 절은 배포자가 구성한다.
- **shadow 판정(`would_block`, `shadow`)은 기록일 뿐이다.** observe/degraded 게이트를 모두 enforce로 본 가상 판정이며, 임계값이 맞는지는 13.2의 리뷰어 일치도로만 알 수 있다.

## 4b. 키 보관과 워커 격리

`docs/review/deployment-shapes.md` §5가 지적한 결함: App 비공개 키와 적대적 객체(후보 트리, ESLint·Prettier·TypeScript 파싱, cccc, 산출물 zip)가 한 프로세스·한 호스트에 있으면 파서의 결함 하나가 키 유출이 된다. 두 축으로 분리한다.

### 키: 서비스 호스트에 비공개 키를 두지 않는다

App JWT 서명은 `NYORORI_SIGNER`로 고른다.

| 값 | 의미 |
|---|---|
| `file` (기본) | `NYORORI_PRIVATE_KEY_PATH`의 PEM으로 프로세스 안에서 서명한다. 개발·시범용 |
| `command` | 서명할 바이트를 stdin으로 받아 서명(base64url 또는 raw)을 stdout으로 내는 외부 명령에 위임한다. 키는 KMS/HSM에만 있고 서비스 호스트는 **비공개 키를 갖지 않는다** |

KMS 예 (AWS KMS, RSA 2048 키의 `RSASSA_PKCS1_V1_5_SHA_256`):

```bash
NYORORI_SIGNER=command \
NYORORI_SIGNER_COMMAND='["sh","-c","aws kms sign --key-id alias/nyorori-app --signing-algorithm RSASSA_PKCS1_V1_5_SHA_256 --message-type RAW --message fileb:///dev/stdin --output text --query Signature"]' \
node dist/cli.js serve
```

서명 명령은 `NYORORI_SIGNER_COMMAND`(JSON argv)로 지정하며, 서비스는 JWT의 서명 입력(`header.payload`)만 넘기고 결과를 그대로 붙인다. 명령의 환경은 서비스가 정리해서 넘기므로(필요한 클라우드 자격 증명만 `NYORORI_SIGNER_ENV`로 통과), 명령이 설치 토큰이나 웹훅 비밀을 볼 수 없다. KMS 키 정책으로 "이 서비스 역할만 sign 가능"을 두면 호스트가 뚫려도 공격자는 JWT를 **그 자리에서만** 만들 수 있고 키를 가져가지 못한다. 설치 토큰은 1시간짜리이며 저장소 범위로 좁힌다.

### 워커: 분석은 다른 프로세스, 가능하면 다른 컨테이너에서

`runGatesIsolated()`는 분석을 분리된 자식 프로세스(`dist/pipeline/worker.js`)에서 돌린다(stdin JSON → stdout JSON, 환경 변수는 `PATH`·임시 `HOME`·로케일만, V8 힙 1 GiB, 벽시계 300초, 응답 64 MiB). 이것은 **자원 경계이지 OS 샌드박스가 아니다.** 운영에서는 `NYORORI_WORKER_COMMAND`(JSON argv 접두사)로 워커를 컨테이너나 샌드박스 안에 띄운다.

```bash
NYORORI_WORKER_COMMAND='["docker","run","--rm","-i","--init","--network","none","--memory","1g","--pids-limit","256","--read-only","--tmpfs","/tmp","-v","/var/lib/nyorori/mirrors:/var/lib/nyorori/mirrors:ro","-v","/var/lib/nyorori/runs:/var/lib/nyorori/runs","-v","/var/lib/nyorori/artifacts:/var/lib/nyorori/artifacts:ro","-v","/opt/cccc:/opt/cccc:ro","nyorori-worker:1.8.5"]' \
NYORORI_WORKER_MODULE=/app/dist/pipeline/worker.js \
node dist/cli.js serve
```

워커는 `<접두사> node --max-old-space-size=1024 <worker module>`로 시작되며 같은 프로토콜을 쓴다. 요청 JSON에는 워커가 읽고 쓰는 호스트 경로가 들어 있으므로 접두사가 **같은 경로**에 bind-mount해야 한다.

| 요청 필드 | 내용 | 마운트 |
|---|---|---|
| `repoDir` | 저장소 bare mirror (`NYORORI_WORKDIR/mirrors/...`) | 읽기 전용 |
| `workDir` | 임시 트리 (`NYORORI_WORKDIR/runs`) | 읽기·쓰기 |
| `ccccBinary` | 고정 측정기 | 읽기 전용 |
| `artifactZip.path` | required workflow 산출물 zip (`NYORORI_WORKDIR/artifacts`) | 읽기 전용 |

그 밖의 호스트 파일은 필요 없다. 이미지에는 Node 22, `dist/`, `node_modules/`, git만 있으면 되고 네트워크는 끊는다(`--network none`). 벽시계 초과 시 서비스는 접두사 프로세스 그룹을 `SIGKILL`하므로 접두사가 그것을 컨테이너까지 전달해야 한다(`docker run --rm --init`, 또는 `timeout 300` 래핑). 접두사에는 컨테이너 도구가 필요한 변수(`DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `CONTAINERS_CONF`, `XDG_RUNTIME_DIR`, `TMPDIR`)만 더 넘긴다. 접두사가 없으면 같은 호스트의 자식 프로세스로 돈다(개발용).

이 두 축을 모두 적용하면 서비스 호스트에는 비공개 키가 없고, 적대적 바이트를 여는 프로세스에는 설치 토큰도 웹훅 비밀도 없다.

## 5. 장애 대응 (기획서 13.4)

**판단 기준**: 1시간 동안 FAIL 또는 INCONCLUSIVE 비율이 직전 4주 평균의 3배를 넘거나, `quality-gate`가 15분 넘게 보고되지 않으면 장애다.

**완화**

1. `gate-owners` 2인이 P에서 해당 하위 게이트의 `mode`를 `enforce` → `degraded`로 바꾸는 commit을 병합한다. 저장소 설정과 필수 체크는 건드리지 않는다. (`observe`로 내리면 FAIL과 트리거가 사라지므로 장애 대응에는 `degraded`를 쓴다.)
2. 집계기는 다음 실행부터 그 게이트로 차단하지 않고, 그 게이트가 막았을 것을 단순화 리뷰로 보낸다. 이미 실패한 PR은 게이트 명령 댓글이나 새 push로 재평가된다.
3. 집계기 자체 장애면 조직 ruleset의 관리자 우회만 쓴다. GitHub 감사 로그에 남고 매주 사용 내역을 보고한다. 필수 체크를 해제하지 않으며, 긴급 병합을 정상 PASS로 위조하지 않는다.

**복구**

1. 수정 후 수용 픽스처 전체(`npm test`)와 최근 병합 PR 약 200개 재생을 통과시킨다.
2. P의 `mode`를 `enforce`로 되돌린다.
3. 장애 기간에 병합된 PR을 사후에 다시 측정하고 결과를 게이트 저장소 이슈로 남긴다.

**측정기 업그레이드**도 P 변경이다: 계산 규칙 픽스처 전체 실행과 차이 기록 → 최근 약 200개 PR을 새 바이너리로 B·C 재측정해 판정 차이 비교 → `measurer.cccc_version`, `measurer.cccc_sha256` 갱신. 바이너리는 `gh attestation verify`와 `gh release verify-asset`로 검증한 릴리스 자산을 조직 저장소에 미러링해 쓴다.

## 6. 도입 단계 (기획서 13.1)

| 단계 | 기간 | 정책 설정 | 완료 조건 |
|---|---|---|---|
| P0 측정 계약 | 1~2주 | 모든 게이트 `observe` | 픽스처 전부 통과, 분석 실패가 PASS로 오인되지 않음, 실행 경계 확인 |
| P1 shadow | 3~4주 | `tests.mode=enforce`(S7 라우팅 포함), `review.mode=enforce`, `deps.mode=enforce`(`block_forbidden_edges=false`, 새 순환만), `lint.mode=enforce`(`lint.enforced_rules`에 동적 코드(Function 생성자 계열) 규칙만 지정), 나머지 `observe` | 정책 책임자가 임계값·범위·waiver 방식 승인 |
| P2 enforce | P1 검토 후 | + `complexity.mode=enforce`, `lint.mode=enforce`(전체), `deps.block_forbidden_edges=true` | 마찰 지표가 목표 범위 |
| P3 | +4주 | + `coverage.mode=enforce` (보정 기준 충족 시) | |

P1에서 G6가 enforce여도 관측 모드 게이트(G1 등)의 트리거는 라우팅되지 않는다. 그래서 P1에는 S7(enforce인 G4가 낸 트리거)만 사람 리뷰를 강제한다.

주간 지표: 게이트 FAIL·트리거와 사람 단순화 요청의 정밀도·재현율(핵심), PR당 FAIL 비율(≤ 10%), waiver 비율(≤ 3%, 5% 초과 시 임계값 재검토), INCONCLUSIVE 비율(< 1%), G6 승인 대기 시간, AI 루프 2회 안 수렴률(≥ 80%), waiver 원장 크기·연령. 평균·합계 복잡도는 KPI가 아니다.

## 7. AI 수정 루프

- 루프는 `ai_loop.bot_accounts`에 등록된 봇 계정으로 식별한다. PR 본문의 자기 신고는 쓰지 않는다.
- 루프의 diff가 보호 경로(`tests.protected_paths` + 게이트·도구 설정, `.github/**`, 스냅샷, waiver 원장), 테스트 스크립트(`package.json`의 `scripts.test*`, `jest`/`vitest`/`c8`/`nyc` 키), 억제 주석 추가, 측정 확장자 밖이나 제외 경로로의 이동을 건드리면 `policy-integrity` 행이 `POLICY_PATH_MODIFIED`로 실패한다. 루프는 waiver를 신청할 수 없다.
- 자동 재시도는 `ai_loop.max_retries`회(기본 2)까지다. 위반 집합이 그대로이거나, 수정 후 라우팅 트리거가 하나라도 새로 발화하거나(S1·S9만이 아니다), 금지 변경이 생기면 즉시 사람에게 넘긴다.
- 다음 경우에도 즉시 넘긴다: 어느 게이트든 INCONCLUSIVE(측정 문제는 사람 몫), 첫 시도와 B·정책 revision·측정기 fingerprint가 달라진 경우(spec 12.3 "같은 B"). `gate-feedback.json`의 `stop_if`에 같은 목록이, `forbidden_changes`에 12.2 금지 목록이, `attempts_remaining`은 `decideRetry` 결과에 들어 있다.
- nyorori는 재시도 루프를 직접 돌리지 않는다. `decideRetry`(`src/ailoop`)는 AI 수정 루프를 돌리는 쪽이 매 시도 뒤 호출하는 라이브러리 함수이고, 게이트는 판정과 `gate-feedback.json`만 만든다.
- 모든 재시도는 같은 병합 기준 B에 대해 측정한다.

## 8. 재생 (기획서 6.1 업그레이드 검사, 13.4 복구)

5절의 업그레이드·복구 절차에서 "최근 병합 PR 약 200개 재생"은 `nyorori replay`로 한다. `scripts/build-replay-pairs.sh -R owner/repo -C <clone> -n 200 -o <저장소 밖>/pairs.json`으로 데이터셋을 만든 뒤, 업그레이드면 `--policy <현재 P> --compare-policy <새 측정기의 sha256·버전을 넣은 P> --compare-cccc <새 바이너리>`로, 복구면 `--policy <수정된 P>`만으로 실행한다. 종료 코드 0(차이 없음)이면 P 변경을 병합하고, 1이면 `replay-summary.md`의 차이 목록 전부를 P 변경 설명에 적어 정책 책임자가 승인한 뒤 병합하며, 2(실행 오류 또는 G1~G3 INCONCLUSIVE)는 측정 계약이 깨진 것이므로 병합하지 않는다. 산출물 없이 재생할 때는 G4·G5·G7을 `observe`로 둔 P를 쓰거나 쌍마다 `artifacts`를 지정한다. 같은 보고서의 마찰 지표(PR당 FAIL·INCONCLUSIVE·waiver·G6 필요 비율)는 6절 주간 지표의 재생 버전이다. 사용법은 README의 "Replay (upgrade check)"에 있다.
