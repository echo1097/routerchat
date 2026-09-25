import { useEffect, useState } from "react";

export function useMediaQuery(queryText) {
  const [matches, setMatches] = useState(() => window.matchMedia(queryText).matches);

  useEffect(() => {
    const query = window.matchMedia(queryText);
    setMatches(query.matches);

    function handleChange(event) {
      setMatches(event.matches);
    }

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, [queryText]);

  return matches;
}
