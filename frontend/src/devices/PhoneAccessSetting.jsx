import { useState } from "react";
import { CircleHelp } from "lucide-react";

import { SettingGroup, SettingRow, SettingSwitch } from "../settings/SettingControls.jsx";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { countdownLabel, lastUsedLabel, plainAddress, spacedCode } from "./deviceLabels.js";
import { PairingQr } from "./PairingQr.jsx";
import { PhoneHelp } from "./PhoneHelp.jsx";
import { usePhoneAccess } from "./usePhoneAccess.js";

const buttonClass = cx(
  "flex h-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] px-4 text-[13px] font-medium text-neutral-300 hover:bg-white/[0.1] hover:text-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-[#6b6b6b] disabled:active:scale-100",
  CONTROL_MOTION,
);

const helpButtonClass = cx(
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12px] font-medium text-neutral-300 hover:bg-white/[0.1] hover:text-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
  CONTROL_MOTION,
);

function HelpButton({ open, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="phone-help"
      className={helpButtonClass}
    >
      <CircleHelp className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {open ? "Hide help" : "Help"}
    </button>
  );
}

function restartNote(status) {
  if (!status.enabled) {
    return "Restart RouterChat to finish turning phone access off. Paired phones are already locked out.";
  }

  return "Restart RouterChat to finish turning phone access on. If you already did, RouterChat couldn't find a home network to use.";
}

function PairingPanel({ pairing, secondsLeft, address, onCancel }) {
  return (
    <div className="settings-row flex flex-col items-center gap-4 px-5 py-5 text-center">
      <PairingQr link={pairing.link} />

      <div>
        <p className="text-[14.5px] font-medium text-neutral-50">Scan this with your phone's camera</p>
        <p className="mt-1 text-pretty text-[13px] leading-5 text-[#8a8a8a]">
          Or open <span className="font-mono text-neutral-300">{plainAddress(address)}</span> on the phone and type this code
        </p>
      </div>

      <p className="font-mono text-[22px] font-semibold tracking-[0.18em] text-neutral-50">
        {spacedCode(pairing.code)}
      </p>

      <div className="flex items-center justify-center gap-3">
        <span className="text-[13px] tabular-nums text-[#8a8a8a]">
          Expires in {countdownLabel(secondsLeft)}
        </span>
        <button type="button" onClick={onCancel} className={buttonClass}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OpenPanel({ address, backupAddress, onDone }) {
  return (
    <div className="settings-row flex flex-col items-center gap-4 px-5 py-5 text-center">
      <PairingQr link={address} label="QR code to open RouterChat on a phone" />

      <div>
        <p className="text-[14.5px] font-medium text-neutral-50">Scan this with a paired phone's camera</p>
        <p className="mt-1 text-pretty text-[13px] leading-5 text-[#8a8a8a]">
          Or open <span className="font-mono text-neutral-300">{plainAddress(address)}</span> in the phone's browser
        </p>
        {backupAddress && (
          <p className="mt-1 text-pretty text-[13px] leading-5 text-[#8a8a8a]">
            If that doesn't load, try <span className="font-mono text-neutral-300">{plainAddress(backupAddress)}</span>
          </p>
        )}
      </div>

      <div className="flex items-center justify-center">
        <button type="button" onClick={onDone} className={buttonClass}>
          Done
        </button>
      </div>
    </div>
  );
}

function DeviceRow({ device, busy, onRemove }) {
  return (
    <div className="settings-row flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <h3 className="truncate text-[14.5px] font-medium text-neutral-50">{device.name}</h3>
        <p className="mt-0.5 text-[13px] leading-5 text-[#8a8a8a]">{lastUsedLabel(device.lastSeenAt)}</p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => onRemove(device.id)}
        aria-label={`Remove ${device.name}`}
        className={buttonClass}
      >
        Remove
      </button>
    </div>
  );
}

export function PhoneAccessSetting({ onNotify }) {
  const phoneAccess = usePhoneAccess(onNotify);
  const { status, pairing, busy } = phoneAccess;
  const [helpOpen, setHelpOpen] = useState(false);
  const [openShown, setOpenShown] = useState(false);

  if (!status) return null;

  const ready = status.enabled && status.running;

  return (
    <SettingGroup
      id="settings-group-phone"
      title="Phone access"
      trailing={<HelpButton open={helpOpen} onToggle={() => setHelpOpen((current) => !current)} />}
    >
      <SettingRow
        title="Use RouterChat on a phone"
        description="Lets phones on your home Wi-Fi open RouterChat while it runs on this computer. The connection isn't encrypted, so only turn this on for a network you trust."
      >
        <SettingSwitch
          checked={status.enabled}
          onChange={phoneAccess.toggle}
          label="Use RouterChat on a phone"
          disabled={busy}
        />
      </SettingRow>

      {status.restartNeeded && (
        <div className="settings-row px-5 py-3">
          <p className="text-pretty text-[13px] leading-5 text-amber-200/90">{restartNote(status)}</p>
        </div>
      )}

      {ready && !pairing && (
        <SettingRow
          title="Pair a phone"
          description="Shows a code that works once and lasts 2 minutes"
        >
          <button
            type="button"
            disabled={busy}
            onClick={phoneAccess.beginPairing}
            className={buttonClass}
          >
            Pair a phone
          </button>
        </SettingRow>
      )}

      {ready && pairing && (
        <PairingPanel
          pairing={pairing}
          secondsLeft={phoneAccess.secondsLeft}
          address={status.address}
          onCancel={phoneAccess.stopPairing}
        />
      )}

      {ready && !pairing && !openShown && (
        <SettingRow
          title="Open on a phone"
          description="Shows a QR code that takes a paired phone straight to RouterChat"
        >
          <button type="button" onClick={() => setOpenShown(true)} className={buttonClass}>
            Show QR code
          </button>
        </SettingRow>
      )}

      {ready && !pairing && openShown && (
        <OpenPanel
          address={status.address}
          backupAddress={status.backupAddress}
          onDone={() => setOpenShown(false)}
        />
      )}

      {status.devices.map((device) => (
        <DeviceRow
          key={device.id}
          device={device}
          busy={busy}
          onRemove={phoneAccess.forgetDevice}
        />
      ))}

      {helpOpen && <PhoneHelp />}

      <div className="settings-row px-5 py-3">
        <p className="text-pretty text-[11.5px] leading-4 text-[#7a7a7a]">
          Phones stay paired until they go 30 days without being used. API keys can only be changed on this computer.
        </p>
      </div>
    </SettingGroup>
  );
}
