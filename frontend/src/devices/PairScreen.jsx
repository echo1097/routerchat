import { useEffect, useState } from "react";
import { Loader2, Smartphone } from "lucide-react";

import { cx, CONTROL_MOTION } from "../uiShared.js";
import { pairThisDevice } from "./devicesApi.js";
import { guessDeviceName, readPairingCode } from "./phoneBrowser.js";

const fieldClass =
  "h-12 w-full rounded-2xl bg-white/[0.045] px-4 text-base text-neutral-100 outline-none ring-1 ring-inset ring-white/[0.07] transition-[background-color,box-shadow] duration-150 ease-out placeholder:text-neutral-500 focus:bg-white/[0.06] focus:ring-white/[0.18]";

export function PairScreen({ onPaired }) {
  const [code, setCode] = useState(() => readPairingCode());
  const [name, setName] = useState(() => guessDeviceName());
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function submit(event) {
    event.preventDefault();
    setPairing(true);
    setError("");

    try {
      await pairThisDevice(code, name);
      await onPaired();
    } catch (pairError) {
      setError(pairError.message || "Pairing failed. Try again.");
      setPairing(false);
    }
  }

  return (
    <div className="grid min-h-[100dvh] w-full place-items-center bg-[#080808] px-4 py-6 text-ink">
      <form
        onSubmit={submit}
        aria-labelledby="pair-title"
        className="w-full max-w-md overflow-hidden rounded-3xl bg-panel [box-shadow:var(--shadow-surface)]"
      >
        <div className="px-6 pb-6 pt-7">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.06] text-neutral-200 ring-1 ring-inset ring-white/10">
            <Smartphone className="h-[22px] w-[22px]" strokeWidth={1.75} aria-hidden="true" />
          </span>

          <h1 id="pair-title" className="mt-5 text-balance text-xl font-semibold tracking-[-0.01em] text-ink">
            Pair this device
          </h1>

          <p className="mt-2 text-pretty text-sm leading-6 text-muted">
            On your computer, open RouterChat settings, go to Phone, and choose Pair a phone. Then enter the code it shows.
          </p>

          <label className="mt-5 block text-[13px] font-medium text-neutral-300" htmlFor="pair-code">
            Pairing code
          </label>
          <input
            id="pair-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={16}
            placeholder="ABCD EFGH"
            className={cx(fieldClass, "mt-2 font-mono tracking-[0.14em]")}
          />

          <label className="mt-4 block text-[13px] font-medium text-neutral-300" htmlFor="pair-name">
            Name for this device
          </label>
          <input
            id="pair-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            className={cx(fieldClass, "mt-2")}
          />

          {error && (
            <p role="alert" className="mt-4 text-pretty text-sm leading-6 text-amber-200">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-center border-t border-line bg-white/[0.015] px-6 py-4">
          <button
            type="submit"
            disabled={pairing || !code.trim()}
            className={cx(
              "inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-medium text-black",
              "hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
              "disabled:cursor-default disabled:bg-white/60",
              CONTROL_MOTION,
            )}
          >
            {pairing && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />}
            {pairing ? "Pairing" : "Pair"}
          </button>
        </div>
      </form>
    </div>
  );
}
