import { useEffect, useState } from "react";

import { SettingRow, SettingSwitch } from "./SettingControls.jsx";


export function StartupSoundSetting() {
  const desktop = window.routerchatDesktop;
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => {
    if (!desktop) return;

    desktop
      .getStartupSoundMuted()
      .then((muted) => setSoundOn(!muted))
      .catch(() => {});
  }, [desktop]);

  if (!desktop) return null;

  async function toggleSound(value) {
    setSoundOn(value);

    try {
      await desktop.setStartupSoundMuted(!value);
    } catch {
      setSoundOn(!value);
    }
  }

  return (
    <SettingRow title="Startup sound" description="Play a short sound when the desktop app opens">
      <SettingSwitch checked={soundOn} onChange={toggleSound} label="Startup sound" />
    </SettingRow>
  );
}
