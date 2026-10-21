# Spike: Vitest 런타임 mutant 전환

`npm i && npm run spike`

Vitest 5.0.5 Node API로 확인한 것:

- Vite 플러그인(`enforce: 'pre'`)의 `transform`에서 TS 원본에 schemata를 끼워 넣을 수 있다.
- `related` 옵션 + `getRelevantTestSpecifications()`로 바뀐 파일에 의존하는 테스트 파일만 고를 수 있다.
- `project.provide()` → setupFile의 `inject()`로, 인스턴스 하나에서 재실행마다 활성 mutant를 바꿀 수 있다. `isolate: false` + `pool: 'threads'`에서도 동작한다.

기대 출력:

```
related specs: [ 'test/math.test.ts' ]
mutant 0: SURVIVED   # 원본 (baseline)
mutant 1: SURVIVED   # >= → >  : 테스트가 경계값 18을 확인하지 않는다
mutant 2: KILLED     # >= → <
mutant 3: KILLED     # 조건 → true
```

mutant 1이 살아남은 것은 equivalent가 아니라 테스트가 약하다는 신호다.
