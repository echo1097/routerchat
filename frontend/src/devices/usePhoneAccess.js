import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelPairing,
  loadDevices,
  removeDevice,
  setPhoneAccess,
  startPairing,
} from "./devicesApi.js";

const pollTime = 2000;

export function usePhoneAccess(onNotify) {
  const [status, setStatus] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const deviceCount = useRef(0);

  const run = useCallback(async (action) => {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      onNotify?.(error.message || "Phone access could not be changed");
      return null;
    } finally {
      setBusy(false);
    }
  }, [onNotify]);

  useEffect(() => {
    let cancelled = false;

    loadDevices()
      .then((loaded) => {
        if (!cancelled) setStatus(loaded);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pairing) return undefined;

    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(async () => {
      try {
        const latest = await loadDevices();
        setStatus(latest);

        if (latest.devices.length > deviceCount.current) {
          setPairing(null);
          onNotify?.("Phone paired");
        } else if (!latest.pairingActive) {
          setPairing(null);
        }
      } catch {
        setPairing(null);
      }
    }, pollTime);

    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [pairing, onNotify]);

  async function toggle(enabled) {
    const updated = await run(() => setPhoneAccess(enabled));
    if (!updated) return;

    setStatus(updated);
    if (!enabled) setPairing(null);
  }

  async function beginPairing() {
    const started = await run(startPairing);
    if (!started) return;

    deviceCount.current = status?.devices.length || 0;
    setNow(Date.now());
    setPairing({
      code: started.code,
      link: started.link,
      expiresAt: Date.now() + started.expiresIn * 1000,
    });
  }

  async function stopPairing() {
    setPairing(null);
    const updated = await run(cancelPairing);
    if (updated) setStatus(updated);
  }

  async function forgetDevice(deviceId) {
    const updated = await run(() => removeDevice(deviceId));
    if (updated) setStatus(updated);
  }

  const secondsLeft = pairing ? (pairing.expiresAt - now) / 1000 : 0;

  return {
    status,
    pairing,
    busy,
    secondsLeft,
    toggle,
    beginPairing,
    stopPairing,
    forgetDevice,
  };
}
