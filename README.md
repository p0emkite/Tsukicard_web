# Tsukicard Web

브라우저에서 카드 이미지를 생성하는 GitHub Pages용 웹앱입니다.

## 현재 구현
- 오팔 / 코랄 / 골드 / 실버 / TB / 올스타 / 설날
- 피사체 이미지 업로드
- X/Y 위치, 확대/축소
- 외부 광선
- 시즌 / 등번호+이름 / 포지션 텍스트
- 텍스트 위치·크기·색상 조정
- 미리보기 드래그 / 마우스 휠
- PNG 다운로드
- Excel 일괄 생성 → ZIP
- 선택적 AI 누끼

Python/Pillow 렌더링은 Pyodide를 통해 사용자 브라우저 안에서 실행됩니다.

## 아직 추가해야 하는 바이너리 자산
아래 경로의 PNG 및 XLSX는 별도로 업로드해야 합니다.

- `assets/backgrounds/`
- `assets/frames/`
- `assets/team_logos/`
- `samples/츠키카드_일괄생성_샘플.xlsx`

## 폰트
웹앱이 정상 렌더링하려면 본인이 보유한 기존 제작기의 아래 파일을 직접 `assets/fonts/`에 추가해야 합니다.

- `VITRO_INSPIRE.otf`
- `Freesentation-8ExtraBold.ttf`

## GitHub Pages
모든 자산 업로드 후:

1. Settings
2. Pages
3. Build and deployment → Deploy from a branch
4. Branch: `main`
5. Folder: `/(root)`
6. Save

사이트 주소는 일반적으로 아래 형태입니다.

`https://p0emkite.github.io/Tsukicard_web/`
