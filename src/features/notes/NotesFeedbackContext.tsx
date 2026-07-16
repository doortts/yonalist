import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export type NotesFeedback = Readonly<{
  kind: "status" | "error";
  message: string;
}>;

type PublishedNotesFeedback = NotesFeedback & Readonly<{ eventId: number }>;

interface NotesFeedbackValue {
  publish(feedback: NotesFeedback): void;
  clear(): void;
  feedback: PublishedNotesFeedback | null;
}

const emptyNotesFeedback: NotesFeedbackValue = {
  publish: () => undefined,
  clear: () => undefined,
  feedback: null
};

const NotesFeedbackContext =
  createContext<NotesFeedbackValue>(emptyNotesFeedback);

export function NotesFeedbackProvider({
  active,
  children
}: PropsWithChildren<{ active: boolean }>) {
  const [feedback, setFeedback] = useState<PublishedNotesFeedback | null>(null);
  const nextEventIdRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const publish = useCallback((next: NotesFeedback) => {
    if (activeRef.current) {
      setFeedback({ ...next, eventId: ++nextEventIdRef.current });
    }
  }, []);
  const clear = useCallback(() => setFeedback(null), []);

  useEffect(() => {
    if (!active) clear();
  }, [active, clear]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(clear, 6000);
    return () => window.clearTimeout(timeout);
  }, [clear, feedback]);

  const value = useMemo(
    () => ({ publish, clear, feedback }),
    [clear, feedback, publish]
  );

  return (
    <NotesFeedbackContext.Provider value={value}>
      {children}
    </NotesFeedbackContext.Provider>
  );
}

export function useNotesFeedback(): NotesFeedbackValue {
  return useContext(NotesFeedbackContext);
}

export function NotesStatusBarMessage() {
  const { feedback } = useNotesFeedback();
  if (!feedback) return null;
  return (
    <span
      key={feedback.eventId}
      className="statusbar-message"
      role={feedback.kind === "error" ? "alert" : "status"}
      data-kind={feedback.kind}
    >
      {feedback.message}
    </span>
  );
}
