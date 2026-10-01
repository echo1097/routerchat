import { useCallback, useRef, useState } from "react";
import { providerApi } from "./providerApi.js";

export function useModels() {
  const [models, setModels] = useState([]);
  const latestRequestRef = useRef(0);

  const fetchModels = useCallback(async (providerId) => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;

    try {
      const loaded = await providerApi.listModels(providerId);
      if (requestId !== latestRequestRef.current) return null;

      setModels(loaded);
      return loaded;
    } catch (error) {
      if (requestId !== latestRequestRef.current) return null;

      setModels([]);
      throw error;
    }
  }, []);

  return { models, fetchModels };
}
