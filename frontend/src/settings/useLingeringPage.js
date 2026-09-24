import { useEffect, useState } from "react";

export function useLingeringPage(open, active, lingerMs = 400) {
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const visible = open && active;

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((current) => current + 1);
  }

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setMounted(false), lingerMs);
    return () => window.clearTimeout(timeoutId);
  }, [visible, lingerMs]);

  return { mounted: mounted || visible, session };
}
