import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_PROVIDER, providerApi } from "./providerApi.js";

export function useProviders({ onError } = {}) {
  const [providers, setProviders] = useState([DEFAULT_PROVIDER]);
  const [activeProviderId, setActiveProviderId] = useState(DEFAULT_PROVIDER.id);
  const [keyStatus, setKeyStatus] = useState({ has_key: false });

  const applyProviders = useCallback((payload) => {
    if (!payload.providers.length) return;
    setProviders(payload.providers);
    setActiveProviderId(payload.active || payload.providers[0].id);
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      applyProviders(await providerApi.listProviders());
    } catch {
      return;
    }
  }, [applyProviders]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const providerFor = useCallback((providerId) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return null;

    const capabilities = { ...DEFAULT_PROVIDER.capabilities, ...(provider.capabilities || {}) };
    const transcriptionProvider = providers.find((item) => item.capabilities?.transcription);

    return {
      ...provider,
      capabilities,
      transcriptionAvailable: capabilities.transcription || Boolean(transcriptionProvider?.hasKey),
    };
  }, [providers]);

  const activeProvider = useMemo(
    () => providerFor(activeProviderId) || { ...DEFAULT_PROVIDER, transcriptionAvailable: true },
    [providerFor, activeProviderId],
  );

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(await providerApi.getKeyStatus());
    } catch (error) {
      onError?.(error);
    }
  }, []);

  const saveKey = useCallback(async (apiKey) => {
    const payload = await providerApi.saveKey(activeProviderId, apiKey);
    setKeyStatus(payload);
    await loadProviders();
    return payload;
  }, [activeProviderId, loadProviders]);

  const switchProvider = useCallback(async (providerId) => {
    const payload = await providerApi.setActiveProvider(providerId);
    applyProviders(payload);
    setKeyStatus(await providerApi.getKeyStatus());

    return payload.providers.find((item) => item.id === payload.active);
  }, [applyProviders]);

  return {
    providers,
    activeProvider,
    providerFor,
    capabilities: activeProvider.capabilities,
    keyStatus,
    loadKeyStatus,
    saveKey,
    switchProvider,
  };
}
