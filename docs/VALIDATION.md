# 검증 결과

검증일: 2026-10-29 (Asia/Seoul). 이 문서는 현재 클라우드 인스턴스에서 실행한 결과를 기록합니다. 조직의 운영 배포 승인이나 새로운 환경에서의 복원 검증을 의미하지 않습니다.

## 실행 결과

| 검사                                                                   | 결과                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Frozen lockfile 설치 `npm ci --ignore-scripts --cache /workspace/.npm` | 성공                                                                                                           |
| `NYORORI_REAL_CCCC=/workspace/tools/cccc/1.8.5/cccc npm run check`     | 타입 검사·빌드 성공, **235 passed / 0 failed / 0 skipped / 0 cancelled / 0 todo**                              |
| `npm run format:check`                                                 | 통과                                                                                                           |
| `npm audit --audit-level=high --cache /workspace/.npm`                 | 알려진 취약점 0개                                                                                              |
| `bash -n scripts/install-cccc.sh`                                      | 셸 구문 검사 통과                                                                                              |
| 실제 cccc CLI 데모                                                     | 신규 CogC 21, 한도 15 → G1 FAIL; 테스트 증거 누락 → G4 INCONCLUSIVE; P0 shadow 집계와 `would_block: true` 보존 |
| 로컬 문서 링크                                                         | 끊어진 상대 링크 없음                                                                                          |

전체 검사 로그는 현재 인스턴스의 `/tmp/nyorori-final-check.log`에 있습니다. 데모 산출물은 `/tmp/nyorori-demo-OGGwKI/report`에 생성했습니다. 임시 경로는 영구 배포 산출물이 아닙니다.

## 측정 조건

- Node.js 24.19.0, npm 11.9.0, TypeScript 6.0.3.
- ESLint 10.13.0 및 TypeScript ESLint 8.72.1. 정확한 의존성·무결성은 `package-lock.json`에 고정되어 있습니다.
- Linux x86_64 cccc **1.8.5**, 바이너리 SHA256: `6f8b1b457526743f908da513d1f2ba9db4091ff4c3a185ce3840725bb595a819`.
- 공식 GitHub 릴리스 archive와 공식 SHA256 파일을 TLS 검증을 유지해 내려받고 archive 체크섬을 대조했습니다. 매 실행에서도 바이너리 해시·버전을 검사하고 해시를 확인한 사본만 실행했습니다.
- 실제 측정기 corpus는 16개 JS/TS 입력을 통해 CogC 경계, 중첩·residue·논리 연산·optional chaining·논리 할당·switch·재귀·선언·JSX 및 j1/j4 일치를 확인합니다. 가짜 측정기를 사용하는 출력 프로토콜 공격 테스트와 구분합니다.
- 측정 fingerprint에는 실행 코드, lockfile 및 실제 Node/플랫폼 정보가 반영됩니다.

## 검증한 경계

Git blob 기반 B/C와 확장자·모드·인코딩·크기·case collision·LFS, cccc의 누락/잘못된 JSON/stderr/parse error/hash/timeout/비결정성, 변경 단위·중첩·residue와 부채 대응, G2 구조 우회와 G3 순환·금지 간선·미지원 resolver를 검사했습니다.

서명된 증거의 저장소/B/C/P/M 재생 공격, 0개·실패·소실·skip/focus 테스트, 변경 분기와 함수 미실행, 독립 리뷰·waiver의 head/blob/ceiling/만료 범위 및 AI 수정 중단 계약을 검사했습니다.

서버는 서명된 webhook, 허용 저장소·설치 ID, 영속 큐·중복·재시작·보존량·재시도 및 App 체크 결론을 검증합니다. 실제 bare Git mirror와 실제 cccc를 별도 worker에서 실행하고, 증거 누락 실패와 서명된 fixture 증거 후 재시도 성공도 확인했습니다. 여기서 GitHub 체크 전송은 로컬 대역이고 서명 증거는 테스트 fixture입니다.

attestor는 모의 GitHub API를 사용해 B/C workflow 내용 해시, reusable SHA, run/attempt/event, artifact digest·시점·만료, ZIP 경로·크기·CRC, 권한 필드 주입 및 redirect 토큰 누출 방지를 검사했습니다. 실제 조직의 과거 PR 200개를 재생한 것은 아닙니다.

## 수행하지 않은 운영 검증

- **릴리스 attestation·release verify-asset:** 현재 인스턴스의 구형 `gh`와 `api.github.com` 네트워크 제한 때문에 실행 검증하지 않았습니다. 프로덕션 설치기는 이 검증을 생략하지 않으며, 지원 도구·접근이 없으면 중단합니다.
- **실제 GitHub 왕복:** App 설치·권한·ruleset·merge queue·실제 workflow artifact 수집을 운영 조직에서 검증하지 않았습니다. API 테스트의 성공을 실제 배포 성공으로 표현하지 않습니다.
- **OS 보안 격리:** 같은 UID의 별도 Node 프로세스는 메모리·시간·환경 변수 경계입니다. 운영에서는 별도 사용자/컨테이너·cgroup·마운트·네트워크 제한을 추가해야 합니다.
- **승인 권한 수집:** 자동 팀·commit 참여자·에이전트 호출자 수집은 제공하지 않습니다. 기본 attestor는 모든 승인 권한을 비활성화하고, 별도 인증된 운영 제어면의 현재 head·정책에 묶인 authority registry만 선택적으로 받아 검증합니다.
- **조직 보정과 운영 연동:** shadow 임계값 보정, 정책 책임자 승인, 분기 waiver 예산·감사 원장·90일 이슈 및 LLM 관측 연동은 실제 운영 자료와 추가 조직 설정이 필요합니다. 자동 fallback rolling 기준은 직전 최대 5개 first-parent commit이며, 초안의 파일별 5회 병합/30일 기준은 명시적 `--rolling-base`로 공급해야 합니다.
- **CI 실행과 환경 게시:** GitHub CI 구성은 추가했지만 원격 CI 실행·환경 게시·새 task 복원은 수행하지 않았습니다. 환경 초안에는 검증된 `install_script`와 `start_skill`만 저장했습니다.

[배포 지침](DEPLOYMENT.md), [증거 계약](EVIDENCE.md), [설계 결정](DECISIONS.md)에 필요한 설정과 지원 범위를 기록했습니다.
