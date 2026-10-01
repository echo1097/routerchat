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

  const activeProvider = useMemo(() => {
    const provider = providers.find((item) => item.id === activeProviderId) || DEFAULT_PROVIDER;
    const capabilities = { ...DEFAULT_PROVIDER.capabilities, ...(provider.capabilities || {}) };
    const transcriptionProvider = providers.find((item) => item.capabilities?.transcription);

    return {
      ...provider,
      capabilities,
      transcriptionAvailable: capabilities.transcription || Boolean(transcriptionProvider?.hasKey),
    };
  }, [providers, activeProviderId]);

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
    applyProviders(await providerApi.setActiveProvider(providerId));
    setKeyStatus(await providerApi.getKeyStatus());
  }, [applyProviders]);

  return {
    providers,
    activeProvider,
    capabilities: activeProvider.capabilities,
    keyStatus,
    loadKeyStatus,
    saveKey,
    switchProvider,
  };
}
