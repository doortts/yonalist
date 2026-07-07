# src/components/ui

Base UI(`@base-ui/react`) 프리미티브를 감싸는 얇은 래퍼와 그 전용 CSS를 두는 곳.

규칙:

- 임포트는 서브패스로: `import { Dialog } from "@base-ui/react/dialog"`.
- 비주얼은 기존 [src/styles.css](../../styles.css)의 클래스명을 Base UI 파트의 `className`에 그대로 부여해 유지한다.
- Base UI 고유 상태(`data-open`, `data-starting-style` 등)에 필요한 추가 스타일만 이 디렉토리의 `<name>.css`에 작성하고, 해당 래퍼 파일에서 `import "./<name>.css"` 한다.
- 전역 styles.css는 이 디렉토리 작업에서 수정하지 않는다.
