import { NotebookPen } from "lucide-react";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import { GithubServersSection } from "./GithubServersSection";
import { TitleBar } from "./TitleBar";

export interface LoginPageProps {
  servers: UseGithubServersResult;
  auth: UseGithubAuthResult;
  checking: boolean;
  error: string | null;
  onSkip: () => void;
  onOpenNotes?: () => void;
}

/**
 * Start page shown until authentication succeeds: pick a GitHub host and
 * sign in (OAuth or personal token), mirroring the Flutter login screen.
 */
export function LoginPage({
  servers,
  auth,
  checking,
  error,
  onSkip,
  onOpenNotes
}: LoginPageProps) {
  return (
    <main className="login-shell" aria-label="GitHub login">
      <TitleBar />
      <div className="login-card">
        <div className="login-card-header">
          <p className="eyebrow">Yonalist</p>
          <h1>GitHub 로그인</h1>
          <p className="login-copy">
            {checking
              ? "저장된 인증 정보를 확인하는 중..."
              : "사용할 GitHub 서버를 선택하고 로그인하세요."}
          </p>
        </div>
        {!checking && (
          <>
            {error && <p className="notifications-error login-error">{error}</p>}
            <GithubServersSection servers={servers} auth={auth} />
            {onOpenNotes && (
              <button type="button" className="text-button" onClick={onOpenNotes}>
                <NotebookPen size={16} aria-hidden="true" />
                <span>Notes</span>
              </button>
            )}
            <button type="button" className="text-button login-skip" onClick={onSkip}>
              나중에 하기 — 샘플 데이터로 둘러보기
            </button>
          </>
        )}
      </div>
    </main>
  );
}
