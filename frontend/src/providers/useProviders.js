import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_PROVIDER, providerApi } from "./providerApi.js";

export function useProviders({ onError } = {}) {
  const [providers, setProviders] = useState([DEFAULT_PROVIDER]);
  const [activeProviderId, setActiveProviderId] = useState(DEFAULT_PROVIDER.id);
  const [keyStatus, setKeyStatus] = useState({ has_key: false });

  useEffect(() => {
    let cancelled = false;

    providerApi.listProviders()
      .then((payload) => {
        if (cancelled || !payload.providers.length) return;
        setProviders(payload.providers);
        setActiveProviderId(payload.active || payload.providers[0].id);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const activeProvider = useMemo(() => {
    const provider = providers.find((item) => item.id === activeProviderId) || DEFAULT_PROVIDER;
    return {
      ...provider,
      capabilities: { ...DEFAULT_PROVIDER.capabilities, ...(provider.capabilities || {}) },
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
    const payload = await providerApi.saveKey(apiKey);
    setKeyStatus(payload);
    return payload;
  }, []);

  return {
    providers,
    activeProvider,
    capabilities: activeProvider.capabilities,
    keyStatus,
    loadKeyStatus,
    saveKey,
  };
}
