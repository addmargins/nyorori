# nyorori 운영 가이드

이 문서는 게이트를 운영하는 사람을 위한 것이다. 판정 규칙의 근거는 `docs/SPEC.md`(기획서 v0.9)에 있고, 여기서는 역할, 명령, 장애 대응, 도입 단계만 다룬다.

## 1. 신뢰 경계 요약

| 구성 요소 | 실행 위치 | PR 코드 실행 | 비밀 |
|---|---|---|---|
| G1 복잡도, G2 구조 lint, G3 의존성, 집계기 `quality-gate` | 게이트 서비스 (GitHub App 백엔드, `src/service`) | 하지 않음. git blob에서 직접 트리를 만든다 | App 비공개 키 (서비스에만) |
| G4 테스트·무결성, G5 변경 분기 커버리지, G7 변이 | Actions `gate-untrusted-tests.yml` | 함 | 없음 (`contents: read`, 토큰 비영속) |

- 필수 체크는 `quality-gate` 하나이며, 예상 출처를 게이트 App으로 고정한다. 출처를 "GitHub Actions"로 고정하면 PR의 workflow도 같은 이름의 체크를 성공으로 올릴 수 있다.
- 서비스는 같은 이름이라도 자기 App이 만들지 않은 체크를 읽지도 갱신하지도 않는다(`ownCheckRuns`).
- Actions 산출물은 `gate-result.json`의 내용이 아니라 **GitHub API에서 읽은 run 정보**(workflow 경로, workflow SHA, head SHA, event, run attempt)로 출처를 확인한다. 산출물 안의 `metadata.json`은 신뢰하지 않는다.
- `pull_request_target`은 쓰지 않는다.

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

명령은 줄 맨 앞에서만 인식한다. 인용(`>`)이나 코드 블록 안의 명령은 무시하므로, 남의 승인을 인용해도 다시 발급되지 않는다. 게이트가 PR 댓글에 보여 주는 "복사용 명령"은 코드 블록 안에 있어 그 자체로는 효력이 없다.

### 3.1 waiver (FAIL에 대한 위험 수용)

```
/gate-waive gate=complexity unit="src/a.ts::Parser>run#method[0]" metric=cogc ceiling=22 reason="명시적 상태 전이, 분할하면 더 읽기 어렵다" [expires=2026-12-31]
```

- `unit`은 게이트 결과의 단위 키를 그대로 복사한다. 와일드카드, 파일 단위, PR 단위 waiver는 없다.
- waiver 가능한 게이트: `complexity`, `lint-structure`, `deps`, `coverage`.
- waiver 불가: 모든 INCONCLUSIVE(측정 override 대상), G4 무결성(`TEST_REMOVED`, `TEST_FOCUS_OR_SKIP`, `TEST_NO_ASSERTION`, `TEST_CONFIG_WEAKENED`, `TESTS_FAILED`), 보호 경로(`PROTECTED_PATH_MODIFIED`, `POLICY_PATH_MODIFIED`), 우회 벡터(`DYNAMIC_CODE`, `BIDI_CONTROL`, `SUPPRESSION_ADDED`), 리뷰 결과.

승인:

```
/gate-waive-approve W1a2b3c4d5e blob=<그 파일의 C blob SHA>
```

- `blob`은 승인자가 본 코드의 blob이다. 게이트 요약이 현재 blob을 넣은 명령을 보여 준다. 파일이 바뀌면 waiver는 무효가 된다.
- 유효 조건: 승인자가 `waiver_approvers`이고 독립적이며 신청자 본인이 아님, blob 일치, 만료 전(승인 후 `waivers.max_days`일 또는 `expires` 중 이른 날), 단위 값 ≤ `ceiling`, PR당 예산(`waivers.per_pr_budget`) 안.
- 적용된 waiver는 S6 트리거를 낸다. 승인자가 `simplification_reviewers`에도 속하면 같은 승인으로 그 S6이 해제된다.
- 병합 후 `waivers.jsonl` 원장에 한 줄을 추가하고 90일 기한의 `complexity-debt` 이슈를 연다(`ledgerLine`, `debtIssue`). 병합된 값은 다음 PR의 기준 점수가 되므로, 원장 크기와 연령을 매주 본다.

### 3.2 측정 override (INCONCLUSIVE에 대한 조치)

```
/gate-override gate=complexity reason=PARSE_ERROR_CANDIDATE file="src/a.ts" blob=<C blob SHA> note="oxc가 아직 `accessor`를 지원하지 않음"
```

- `gate_owners`만, 작성자가 아닌 사람만 걸 수 있다.
- 대상 사유: `MEASURER_MISMATCH`, `SCHEMA`, `INVARIANT_VIOLATION`, `NONDETERMINISM`, 그리고 `parser_lag_allowlist`에 있는 문법의 `PARSE_ERROR_CANDIDATE`.
- 작성자가 고칠 원인(구문 오류, 1000단계 초과 중첩, 비 UTF-8, 설정 없는 JSX-in-`.js`)은 override 대상이 아니다. 허용하면 일부러 심어 파일을 영구히 측정 밖으로 빼는 경로가 된다.
- 파일 경로가 없는 전역 측정 실패(예: 바이너리 해시 불일치)는 override하지 않는다. 측정기를 고친다.
- 효과: 그 파일을 `MEASUREMENT_OVERRIDE`로 unmeasured 처리하고, 관측용 대체 측정 대상으로 넘기고, S6으로 단순화 리뷰를 필수로 만든다. **FAIL을 PASS로 바꾸지 않는다.**

### 3.3 단순화 리뷰 (G6)

```
/simplification-review REQUIRED
q1: pass
q2: fail src/billing/plan.ts:42 processPart2는 지역 변수 5개를 끌고 다니는 단일 호출 helper
q3: pass
q4: pass
q5: pass
```

- 판정: `NO_SIMPLIFICATION_NEEDED`, `SUGGESTED`(차단 안 함), `REQUIRED`(차단).
- 각 문항은 `pass`/`fail`로 답한다. 질문의 긍정·부정 표현에 따라 의미가 뒤집히지 않게 하기 위해서다. `fail`에는 `file:line` 근거가 반드시 있어야 한다.
  1. 같은 동작을 훨씬 적은 개념이나 행으로 쓸 수 없다.
  2. 새 helper·모듈·매개변수·옵션 객체·제네릭은 두 곳 이상에서 쓰이거나 이름 붙일 수 있는 도메인 개념이다.
  3. 추측성 일반화, 죽은 코드, 중복 로직, 불가능한 일에 대한 방어 코드가 없다.
  4. 중첩된 제어 흐름을 더 평평하게 만들 여지가 없다.
  5. 독자가 다른 새 정의를 두 번 넘게 따라가지 않고 각 변경 함수를 이해할 수 있다.
- `REQUIRED`는 q1~q4 중 하나 이상 `fail`일 때만, `NO_SIMPLIFICATION_NEEDED`는 q1~q4가 모두 `pass`일 때만 유효하다.
- 같은 리뷰어의 나중 댓글이 이전 것을 대체한다. 유효한 `REQUIRED`가 하나라도 있으면 다른 승인이 있어도 차단한다.
- 승인은 댓글을 단 시점의 head SHA에 묶인다. 새 push 뒤에는 (a) patch-id가 같은 rebase이거나 (b) 새 commit이 트리거된 파일을 하나도 건드리지 않았을 때만 이어진다. 파일이 없는 트리거(예: 모듈 구조 S3)는 rebase에서만 이어진다.
- LLM 리뷰어의 판정은 v1에서 기록만 한다.

## 4. 판정 상태와 체크 표현

| 상태 | 체크 결론 | 제목 |
|---|---|---|
| PASS | success | `PASS` |
| NOT_APPLICABLE | success | `N/A` |
| ACCEPTED_WITH_WAIVER | success | `PASS with waiver: …` |
| FAIL | failure | 첫 위반 |
| INCONCLUSIVE | **failure** | `INCONCLUSIVE: <사유>` |

`neutral`과 `skipped`는 쓰지 않는다. GitHub가 필수 체크에서 둘을 통과로 취급하기 때문이다. 관측 모드 하위 체크(`gate/<id>`)는 정보용이라 success로 남기고 제목 앞에 `[observe]`를 붙인다.

집계기 규칙:

- 게이트의 모드는 산출물이 아니라 정책 P에서 읽는다.
- enforce 모드 게이트가 보고하지 않으면 `INCONCLUSIVE(REPORT_MISSING)`. 실행되지 않은 게이트는 통과가 아니다. 문서만 바뀐 PR도 모든 게이트가 N/A를 보고해야 한다.
- 이번 실행의 B·C·P·runner와 다른 결과는 `FINGERPRINT_MISMATCH`.
- 결과가 주장하는 상태는 그 내용에서 다시 계산한 상태보다 관대할 수 없다(위반이 있는데 PASS라고 주장하면 FAIL).
- 관측 모드 게이트는 그 트리거까지 포함해 집계에서 빠진다.

## 5. 장애 대응 (기획서 13.4)

**판단 기준**: 1시간 동안 FAIL 또는 INCONCLUSIVE 비율이 직전 4주 평균의 3배를 넘거나, `quality-gate`가 15분 넘게 보고되지 않으면 장애다.

**완화**

1. `gate-owners` 2인이 P에서 해당 하위 게이트의 `mode`를 `enforce` → `observe`로 바꾸는 commit을 병합한다. 저장소 설정과 필수 체크는 건드리지 않는다.
2. 집계기는 다음 실행부터 그 게이트를 집계에서 뺀다(트리거 포함). 이미 실패한 PR은 `/simplification-review` 등 아무 명령 댓글이나 새 push로 재평가된다.
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
| P1 shadow | 3~4주 | `tests.mode=enforce`(S7 라우팅 포함), `review.mode=enforce`, `deps.mode=enforce`(`block_forbidden_edges=false`, 새 순환만), `lint.mode=enforce`(Function 생성자 계열만 — 아래 참고), 나머지 `observe` | 정책 책임자가 임계값·범위·waiver 방식 승인 |
| P2 enforce | P1 검토 후 | + `complexity.mode=enforce`, `lint.mode=enforce`(전체), `deps.block_forbidden_edges=true` | 마찰 지표가 목표 범위 |
| P3 | +4주 | + `coverage.mode=enforce` (보정 기준 충족 시) | |

P1에서 G6가 enforce여도 관측 모드 게이트(G1 등)의 트리거는 라우팅되지 않는다. 그래서 P1에는 S7(enforce인 G4가 낸 트리거)만 사람 리뷰를 강제한다.

주간 지표: 게이트 FAIL·트리거와 사람 단순화 요청의 정밀도·재현율(핵심), PR당 FAIL 비율(≤ 10%), waiver 비율(≤ 3%, 5% 초과 시 임계값 재검토), INCONCLUSIVE 비율(< 1%), G6 승인 대기 시간, AI 루프 2회 안 수렴률(≥ 80%), waiver 원장 크기·연령. 평균·합계 복잡도는 KPI가 아니다.

## 7. AI 수정 루프

- 루프는 `ai_loop.bot_accounts`에 등록된 봇 계정으로 식별한다. PR 본문의 자기 신고는 쓰지 않는다.
- 루프의 diff가 보호 경로(`tests.protected_paths` + 게이트·도구 설정, `.github/**`, 스냅샷, waiver 원장), 테스트 스크립트(`package.json`의 `scripts.test*`, `jest`/`vitest`/`c8`/`nyc` 키), 억제 주석 추가, 측정 확장자 밖이나 제외 경로로의 이동을 건드리면 `policy-integrity` 행이 `POLICY_PATH_MODIFIED`로 실패한다. 루프는 waiver를 신청할 수 없다.
- 자동 재시도는 `ai_loop.max_retries`회(기본 2)까지다. 위반 집합이 그대로이거나, 수정 후 S1·S9가 새로 발화하거나, 금지 변경이 생기면 즉시 사람에게 넘긴다.
- 모든 재시도는 같은 병합 기준 B에 대해 측정한다.
