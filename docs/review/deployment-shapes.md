# 배포 형태 비교: GitHub App 서비스 vs Actions-only

질문: 게이트는 결정론적인데, PR 작성자가 `.github/`를 건드리지 않는다면 Action 하나로 같은 목표를 이룰 수 있지 않은가?
영감: [flinch](https://github.com/tools4imps/flinch) — Go 바이너리 하나를 평범한 CI 단계에서 `--since origin/main`으로 돌리고, 예외 선언(`mutants.md`)은 저장소 안에 두어 코드 리뷰로 다룬다.

검토 팀: 플랫폼 사실 검증(공식 문서 대조), 미니멀리스트 옹호(flinch 관점), 위협 모델 옹호(현재 설계), 운영·경제 분석, 중립 아키텍트(Actions-only 설계). 각 보고의 주장은 아래에서 플랫폼 사실로 걸렀다.

## 1. 플랫폼 사실 (공식 문서 확인)

| 사실 | 의미 |
|---|---|
| 같은 저장소 PR의 `pull_request`는 **PR 버전의 workflow 파일**을 실행하고, 조직 기본값이 permissive면 `GITHUB_TOKEN`에 `checks:write`가 있다 | flinch식 "저장소 안 workflow의 job 통과 필수"는 job을 `exit 0`으로 바꾸거나 체크를 직접 게시하면 뚫린다. Actions의 체크는 모두 "GitHub Actions" 앱 출처라 출처 고정으로 구분할 수 없다 |
| ruleset "Require workflows to pass"는 다른 저장소의 고정 ref/SHA에서 workflow를 가져와 `pull_request`·`merge_group`에서 실행하며 PR 쪽 필터를 무시한다. 조직 ruleset(Team/Enterprise) 기능이고 문서는 Enterprise Cloud 문서에만 있다 | 이 기능이 있으면 "PR이 workflow를 못 건드린다"가 가정이 아니라 보장이 된다. 현재 설계도 G4/G5 workflow에 이 기능을 이미 요구한다(10.1절) |
| 필수 workflow는 `issue_comment`로 돌지 않고, 댓글은 재실행을 일으키지 않는다 | 승인 뒤 즉시 재평가는 Actions-only에 없다 (수동 re-run 또는 보조 workflow) |
| `GITHUB_TOKEN`에는 조직 멤버 조회 권한이 없다 | 팀 기반 명단은 Actions-only에서 못 쓴다 |
| 필수 workflow는 대상 저장소 문맥에서 돌므로 비밀은 조직/저장소 비밀이어야 하고, 그 비밀은 같은 조직의 **일반** PR workflow도 참조할 수 있다(environment 보호 규칙이 없으면) | Actions-only의 필수 workflow는 비밀을 가질 수 없다고 보아야 한다 |
| GitHub-hosted job은 job마다 새 VM; 같은 run 안에서 다른 job이 `overwrite: true`로 아티팩트를 덮어쓸 수 있다 | 측정 job과 테스트 job의 분리는 성립하지만, 집계 job은 측정을 아티팩트로 받지 말고 직접 다시 계산해야 한다 |
| 필수 상태 체크의 "expected source"를 특정 App으로 고정할 수 있다 | App 설계만 체크 출처를 암호학적으로 가진다 |

## 2. 세 형태

| | 소박한 단일 job (flinch 그대로) | 강화된 Actions-only | 현재 App 서비스 |
|---|---|---|---|
| 측정 입력의 통제 | PR이 workflow·정책·측정기 설정·`.gitattributes`·선언 파일을 모두 통제 (시연: 정책 한 줄로 PASS, `.cccc.toml`로 0파일, UTF-16 체크아웃으로 0함수) | PR이 통제 못 함: ruleset 고정 workflow, 게이트 저장소의 정책·바이너리 핀, 체크아웃 없이 blob 측정 | 동일 |
| 신뢰 게이트(G1~G3)가 PR 코드와 분리 | 아니오 | 예 (별도 job, 새 VM) | 예 (별도 프로세스·호스트) |
| 체크 위조 | 가능 | ruleset이 workflow run 자체를 추적하므로 불가 (M 신뢰도) | 불가 (App 출처 고정) |
| 승인(waiver, 단순화 리뷰) | 저장소 파일 → PR 작성자(AI 루프 포함)가 직접 씀, 단위·blob 바인딩 없음, 예산 없음 | run 시점에 댓글을 읽어 기존 파서·독립성 규칙 그대로 적용. **못 하는 것:** 팀 명단(로그인 목록으로 대체), 승인 후 자동 재평가(re-run 또는 보조 workflow), 댓글-head 타임라인(명시적 `sha=`/`blob=`만) | 전부 |
| 원장·분기 예산·90일 부채 이슈 | 없음 | 이슈를 원장으로 사용(merge 시 기본 브랜치 workflow가 생성). 트리아지 권한자가 제목을 바꾸면 과소집계(안전한 방향) | 전부 |
| 상태(저널·판정 저장·중복 제거) | 불필요 | Actions run·`concurrency`·아티팩트가 대체 | 서비스가 보관 |
| 테스트 결과 위조 (10.3절, 범위 밖) | 동일 | 동일 | 동일 |
| 장애 반경 | PR 단위 | PR 단위 (Actions 장애는 세 형태 모두 막힘) | 서비스 장애 = 조직 전체 차단 (ruleset 우회뿐) |
| 키 보관 | 없음 | 없음 | App 키·webhook 비밀을 한 호스트가 보관하며 같은 호스트가 적대적 git 객체를 파싱 |
| 요금제 | 무관 | 조직 ruleset: Team/Enterprise | 같은 요구 (G4/G5 출처 고정에 필요) |
| 연간 추가 비용 (20 repo, 월 400 PR) | — | 약 $0.7~1만 (계산은 $150) | 약 $1.7~2.3만 (계산 $500~900, 나머지는 운영 인력·on-call) |
| 온보딩 | workflow 파일 1개 | ruleset 대상에 저장소 추가 (저장소에 파일 없음) | App 설치 + ruleset + 서비스 URL |
| 추가 구현 | 0 | 약 6인일 (`fetch`·`pr-context`·`provenance` 서브커맨드, merge 기록 workflow, 템플릿, 문서) | 완료 |

## 3. 판정

1. **측정과 판정(G1~G5)에 대해서는 사용자의 직관이 맞다.** ruleset 고정 workflow + 체크아웃 없는 blob 측정 + 별도 테스트 job이면 Actions만으로 현재 설계와 같은 보증을 얻는다. 현재 설계가 이미 같은 플랫폼 가정(필수 workflow)에 기대고 있으므로 새 가정이 늘지 않고, 오히려 App 키라는 치명 벡터(V2)와 파서 탈출 시 조직 전체 위조라는 폭발 반경이 사라진다.
2. **flinch 그대로의 단일 job은 nyorori의 위협 모델에 맞지 않는다.** flinch의 적수는 "테스트가 약한 코드"이고 nyorori의 적수는 "통과하려고 최적화하는 AI 루프"다. 후자는 workflow·정책·선언 파일을 고치는 쪽으로 움직이며, 이 셋이 모두 PR 손 안에 있으면 게이트는 조언에 그친다. flinch의 `@latest` 설치도 B/C 비교 게이트에는 맞지 않는다(3.4절·6.1절).
3. **App 서비스가 실제로 사는 것은 승인·원장·즉시성이다.** 팀 명단의 실시간 조회, 승인 댓글 즉시 재평가, 위조할 수 없는 원장과 분기 예산, App 출처 체크, 멀티 조직·GHES·폐쇄망. 이것들이 사양 7.6·11절의 요구이고, Actions-only에서는 각각 로그인 목록·수동 re-run·이슈 원장으로 **약화된 채** 대체된다. 가장 큰 잔여 위험은 "에이전트를 호출한 사람이 승인"과 "예산 없는 waiver 누적"이며, 로그인 목록 명단과 commit 참여자 조회(`GITHUB_TOKEN`으로 가능)로 전자는 대부분, 후자는 이슈 원장으로 부분적으로 막힌다.
4. **권고: CLI 하나, 배포 모드 둘.** 기본은 강화된 Actions-only(신뢰 모델이 하나 줄고 on-call이 없음). App 서비스는 다음 조건에서 선택: 자율 AI 루프가 하루 수백 push를 만들어 승인·예산을 기계적으로 세야 할 때, 감사 요건으로 위조 불가 원장이 필요할 때, GHES·폐쇄망·다조직일 때. 두 모드는 `authority` 값(`required-workflow` / `github-app`)으로 결과에 표시한다.

## 4. Actions-only 모드의 필수 조건

- 조직 ruleset "Require workflows to pass"로 게이트 저장소의 workflow를 SHA에 고정 (Team/Enterprise). 필수 상태 체크만 있는 요금제에서는 체크 위조가 되살아나므로 "조언 모드"로만 쓴다.
- 필수 workflow에는 **비밀이 없다.** 명단은 게이트 저장소의 정책 파일에 로그인으로 쓰고 CODEOWNERS로 보호한다.
- `verdict` job은 PR을 체크아웃하지 않고 bare mirror로 B/C를 받아 G1~G3을 **직접** 계산한다(측정 아티팩트를 믿지 않는다). 테스트 아티팩트는 같은 run·attempt·head에 묶어 검증한다.
- 승인은 저장소 파일이 아니라 댓글이다(기존 파서·독립성·`sha=`/`blob=` 바인딩 그대로). 승인 뒤 재평가는 re-run 또는 비필수 보조 workflow.
- 원장은 merge 시 기본 브랜치 workflow가 여는 `complexity-debt` 이슈. 과소집계 가능성을 문서화한다.
- GitHub-hosted runner만. self-hosted는 테스트 job이 호스트를 오염시킨다.

## 5. 이 검토에서 드러난 현재 설계의 결함 (수정 완료, 독립 검증)

| 결함 | 수정 | 검증 |
|---|---|---|
| 서비스가 `workflow_run` 완료를 구독하지 않아 push 직후 첫 평가가 INCONCLUSIVE(REPORT_MISSING)가 되고 merge queue에서 PR이 빠짐 | 증거가 아직 없고 신뢰 workflow가 대기·실행 중이면 체크를 **in_progress "waiting for test evidence"**로 두고 G1~G3 결과를 먼저 보여 준다. `workflow_run` 완료로 재평가, 마감(`tests.evidence_wait_minutes`, 기본 45분 = merge queue 60분 제한 아래) 뒤 INCONCLUSIVE, 재시작 시 저널에서 대기 복구, 신뢰 workflow가 여럿이면 모두 끝날 때까지 대기하고 run별 아티팩트를 병합 | 독립 검증자가 실제 git·파이프라인·워커·가짜 GitHub API로 재현: 첫 평가는 완료된 실패를 게시하지 않음, `workflow_run` → 최종 판정, 마감 → INCONCLUSIVE, 다른 head/저장소/경로/비신뢰 workflow 무시, 대기 중 push 시 stale 대기가 현재 head를 덮어쓰지 않음(실제 동시성), 중복 webhook+스위퍼 → 평가 1회, 재시작 후 마감 보존 |
| App 키가 적대적 git 객체·zip을 파싱하는 호스트에 있음 | `NYORORI_SIGNER=command`: 외부 KMS/HSM 명령이 서명 입력을 stdin으로 받아 서명만 돌려주므로 키가 프로세스에 들어오지 않음(허용 목록 env 전달, `NYORORI_*`·토큰·비밀은 이름을 적어도 전달 불가, 타임아웃). 워커는 `NYORORI_WORKER_COMMAND` 접두 명령(예: `docker run --network none`)으로 별도 컨테이너에서 실행 | JWT가 공개키로 검증됨, 명령 argv에 서명 입력이 섞이지 않음, 셸 미사용, env 차단, 접두 명령이 멈추면 TOOL_ERROR |
| (검증 중 발견) PR이 필수 workflow와 같은 경로의 workflow를 추가해 신뢰 reusable workflow를 호출하면 출처 검사를 통과할 수 있음 | run의 `workflow_url` 소유 저장소가 게이트 저장소여야 하고(없으면 UNTRUSTED_ARTIFACT, fail closed), 후보 트리가 신뢰 경로의 파일을 정의하면 증거를 거부 | 두 형태 모두 재현에서 거부됨 |

운영 주의: 신뢰 workflow가 둘 이상이면 아티팩트 병합이 서비스 프로세스에서 zip을 읽는다(한도는 있으나 워커 밖). 도입 저장소가 신뢰 경로에 자기 파일을 두면 증거가 영구히 거부된다(의도된 엄격함). 만료 뒤 늦게 온 `workflow_run`은 한 번만 재평가된다.

## 6. 사양에서 고칠 곳 (Actions-only 모드를 공식화할 때)

4.1(실행 위치 열), 4.2/9.1(체크=workflow run), 6.2, 7.6(승인 재평가 시점), 10.1(App 전제), 10.2 V1/V2, 11.1(명단·원장), 12.1, 13.4(`degraded`는 게이트 저장소 정책 PR), 16(공수·역할), README 배포 절.
