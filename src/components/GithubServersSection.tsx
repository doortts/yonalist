import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import {
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  Trash2
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import "./ui/form-controls.css";

interface GithubServersSectionProps {
  servers: UseGithubServersResult;
  auth: UseGithubAuthResult;
}

interface EditorState {
  mode: "add" | "edit";
  url: string;
  alias: string;
  usePersonalToken: boolean;
  personalToken: string;
}

function validateUrl(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) {
    return "URL을 입력하세요.";
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return "http:// 또는 https:// 로 시작해야 합니다.";
  }
  try {
    const parsed = new URL(value);
    if (!parsed.host) {
      return "유효한 URL이 아닙니다.";
    }
  } catch {
    return "유효한 URL이 아닙니다.";
  }
  return null;
}

export function GithubServersSection({ servers, auth }: GithubServersSectionProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const selectedUsesToken = servers.usesToken(servers.selectedUrl);

  function openAdd() {
    setEditor({
      mode: "add",
      url: "",
      alias: "",
      usePersonalToken: false,
      personalToken: ""
    });
    setFormError(null);
    setShowToken(false);
  }

  function openEdit(url: string) {
    setEditor({
      mode: "edit",
      url,
      alias: servers.state.aliases[url] ?? "",
      usePersonalToken: servers.usesToken(url),
      personalToken: servers.tokenOf(url) ?? ""
    });
    setFormError(null);
    setShowToken(false);
  }

  function submitEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor) {
      return;
    }

    if (editor.mode === "add") {
      const urlError = validateUrl(editor.url);
      if (urlError) {
        setFormError(urlError);
        return;
      }
    }
    if (editor.usePersonalToken && !editor.personalToken.trim()) {
      setFormError("토큰을 입력하세요.");
      return;
    }

    servers.upsert({
      url: editor.url,
      alias: editor.alias,
      personalToken: editor.usePersonalToken ? editor.personalToken : ""
    });
    setStatusMessage(
      editor.mode === "add"
        ? "서버를 추가했습니다."
        : "저장했습니다. 변경된 서버는 다시 로그인하세요."
    );
    setEditor(null);
    setFormError(null);
  }

  function handleSelect(url: string) {
    if (url === servers.selectedUrl) {
      return;
    }
    servers.select(url);
    setStatusMessage("서버를 변경했습니다. 새 서버로 다시 로그인하세요.");
  }

  function handleRemove(url: string) {
    if (!window.confirm(`${servers.labelOf(url)}\n\n이 URL을 목록에서 삭제할까요?`)) {
      return;
    }
    servers.remove(url);
    setStatusMessage("URL을 삭제했습니다.");
  }

  function handleReset() {
    if (
      !window.confirm(
        "추가한 URL, 별칭, 저장된 토큰이 모두 삭제되고 기본 목록으로 돌아갑니다. 계속할까요?"
      )
    ) {
      return;
    }
    servers.reset();
    setEditor(null);
    setStatusMessage("기본값으로 되돌렸습니다.");
  }

  return (
    <section className="settings-section" aria-label="GitHub servers">
      <div className="settings-section-title">
        <Server size={18} />
        <h3>GitHub 서버</h3>
      </div>

      <RadioGroup
        className="server-list"
        aria-label="GitHub server"
        value={servers.selectedUrl}
        onValueChange={(url) => handleSelect(url as string)}
      >
        {servers.urls.map((url) => (
          <div
            key={url}
            className={
              url === servers.selectedUrl ? "server-row selected" : "server-row"
            }
          >
            <Radio.Root
              value={url}
              render={<label />}
              className="server-radio"
              aria-label={servers.labelOf(url)}
            >
              <span className="ui-radio" aria-hidden="true">
                <Radio.Indicator className="ui-radio-indicator" />
              </span>
              <span className="server-label">
                <span className="server-alias">
                  {servers.state.aliases[url] ?? url}
                </span>
                {servers.state.aliases[url] && (
                  <span className="server-url">{url}</span>
                )}
              </span>
            </Radio.Root>
            {servers.usesToken(url) && <span className="chip">개인 토큰</span>}
            <button
              type="button"
              className="icon-button server-action"
              aria-label={`Edit ${url}`}
              title="편집"
              onClick={() => openEdit(url)}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              className="icon-button server-action"
              aria-label={`Remove ${url}`}
              title="삭제"
              onClick={() => handleRemove(url)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </RadioGroup>

      <div className="server-list-actions">
        <button type="button" className="text-button" onClick={openAdd}>
          <Plus size={15} />
          URL 추가
        </button>
        <button type="button" className="text-button" onClick={handleReset}>
          <RotateCcw size={14} />
          기본값으로 초기화
        </button>
      </div>

      {editor && (
        <form
          className="server-editor"
          aria-label={editor.mode === "add" ? "Add server" : "Edit server"}
          onSubmit={submitEditor}
        >
          {editor.mode === "add" ? (
            <label>
              API Base URL
              <input
                aria-label="API Base URL"
                placeholder="https://your-ghe-host/api/v3"
                value={editor.url}
                onChange={(event) =>
                  setEditor({ ...editor, url: event.target.value })
                }
              />
            </label>
          ) : (
            <p className="server-editor-url">{editor.url}</p>
          )}
          <label>
            별칭 (선택)
            <input
              aria-label="별칭"
              placeholder="예: 사내 GitHub Enterprise"
              value={editor.alias}
              onChange={(event) =>
                setEditor({ ...editor, alias: event.target.value })
              }
            />
          </label>

          <div className="server-auth-method">
            <span>인증 방식</span>
            <ToggleGroup
              className="segmented"
              aria-label="인증 방식"
              value={[editor.usePersonalToken ? "token" : "oauth"]}
              onValueChange={(groupValue) => {
                const next = groupValue[0];
                if (!next) {
                  // Preserve radio-like behavior: keep the current choice
                  // rather than allowing an empty (deselected) state.
                  return;
                }
                setEditor({ ...editor, usePersonalToken: next === "token" });
              }}
            >
              <Toggle value="oauth" className="segment" aria-label="OAuth">
                OAuth
              </Toggle>
              <Toggle value="token" className="segment" aria-label="개인 토큰">
                개인 토큰
              </Toggle>
            </ToggleGroup>
          </div>

          {editor.usePersonalToken && (
            <>
              <label>
                Personal Access Token
                <span className="token-input">
                  <input
                    aria-label="Personal Access Token"
                    type={showToken ? "text" : "password"}
                    autoComplete="off"
                    placeholder="GHE 에서 발급한 토큰"
                    value={editor.personalToken}
                    onChange={(event) =>
                      setEditor({ ...editor, personalToken: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="icon-button server-action"
                    aria-label={showToken ? "토큰 숨기기" : "토큰 표시"}
                    onClick={() => setShowToken((current) => !current)}
                  >
                    {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </span>
              </label>
              <p className="server-editor-help">
                해당 GHE 의 Settings → Developer settings → Personal access
                tokens 에서 발급하세요. 권한(scope): repo, notifications,
                read:org. 토큰은 이 기기에만 저장됩니다.
              </p>
            </>
          )}

          {formError && <p className="notifications-error">{formError}</p>}

          <div className="server-editor-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEditor(null)}
            >
              취소
            </button>
            <button type="submit" className="primary-button">
              {editor.mode === "add" ? "추가" : "저장"}
            </button>
          </div>
        </form>
      )}

      <div className="server-login-row">
        {auth.signedIn ? (
          <>
            <span className="server-login-status">
              {auth.authMethod === "personal_token"
                ? "개인 토큰으로 인증됨"
                : "OAuth 로그인됨"}
            </span>
            {auth.authMethod === "oauth" && (
              <button
                type="button"
                className="secondary-button"
                onClick={auth.logout}
              >
                <LogOut size={15} />
                로그아웃
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={auth.loggingIn}
            onClick={() => void auth.login()}
          >
            {selectedUsesToken ? <KeyRound size={15} /> : <LogIn size={15} />}
            {auth.loggingIn
              ? "로그인 중..."
              : selectedUsesToken
                ? "개인 토큰으로 로그인"
                : "Login to Github"}
          </button>
        )}
      </div>

      {auth.error && <p className="notifications-error">{auth.error}</p>}
      {statusMessage && <p className="server-status-message">{statusMessage}</p>}
    </section>
  );
}
