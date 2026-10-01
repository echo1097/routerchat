import { useCallback, useState } from "react";
import { providerApi } from "./providerApi.js";

export function useModels() {
  const [models, setModels] = useState([]);

  const fetchModels = useCallback(async () => {
    try {
      const loaded = await providerApi.listModels();
      setModels(loaded);
      return loaded;
    } catch (error) {
      setModels([]);
      throw error;
    }
  }, []);

  return { models, fetchModels };
}
