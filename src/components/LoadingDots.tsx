import { useEffect, useState } from "react";

const FRAMES = [".", "..", "..."];
const FRAME_MS = 400;

interface LoadingDotsProps {
  ariaLabel?: string;
}

/** Cycles through ".", "..", "..." to signal an in-progress refresh. */
export function LoadingDots({ ariaLabel = "Loading" }: LoadingDotsProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(
      () => setFrame((current) => (current + 1) % FRAMES.length),
      FRAME_MS
    );
    return () => window.clearInterval(interval);
  }, []);

  return (
    <span className="loading-dots" role="status" aria-label={ariaLabel}>
      {FRAMES[frame]}
    </span>
  );
}
