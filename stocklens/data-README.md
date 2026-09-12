# stocklens/data — GitHub 이 채워 두는 시세 창고

이 폴더는 **사람이 손대지 않습니다.** `.github/workflows/stocklens-data.yml` 이
2시간마다 `tools/fetch-data.mjs` 를 돌려서 채웁니다.

| 파일 | 무엇 |
|---|---|
| `prices.json` | 모든 종목의 시세·전일종가 (매번 갱신) |
| `fund/<코드>.json` | 투자지표·연간재무·일봉·뉴스 (내용이 바뀔 때만 다시 씀) |
| `index.json` | 담긴 종목 목록과 갱신 시각 |

앱은 이 파일들을 **같은 주소에서** 읽기 때문에 브라우저 보안(CORS)에 걸리지 않고,
공개 중계가 전부 막혀 있어도 시세·재무·점수가 나옵니다.
실시간 시세가 필요하면 그 위에 덧씌웁니다.

받아 둘 종목은 `stocklens/watchlist.json` 에 있습니다.
