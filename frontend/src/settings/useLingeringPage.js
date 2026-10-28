import { useEffect, useState } from "react";

export function useLingeringPage(open, active, lingerMs = 400) {
  const [visited, setVisited] = useState(false);
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((current) => current + 1);
  }

  useEffect(() => {
    if (open && active) {
      setVisited(true);
      return undefined;
    }

    if (open) return undefined;

    const timeoutId = window.setTimeout(() => setVisited(false), lingerMs);
    return () => window.clearTimeout(timeoutId);
  }, [open, active, lingerMs]);

  return { mounted: visited || (open && active), session };
}
