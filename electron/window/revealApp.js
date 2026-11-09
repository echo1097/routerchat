import { setTimeout as sleep } from "node:timers/promises";

const revealTime = 650;
const readyTimeout = 8000;

const hiddenStyle = `
  html { background: #000 !important; }
  #root { opacity: 0; }
`;

const revealStyle = `
  @keyframes routerchatBlurIn {
    from { opacity: 0; filter: blur(18px); transform: scale(1.015); }
    to { opacity: 1; filter: blur(0); transform: scale(1); }
  }

  @keyframes routerchatFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  #root { animation: routerchatBlurIn ${revealTime}ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }

  @media (prefers-reduced-motion: reduce) {
    #root { animation: routerchatFadeIn 200ms ease-out both; }
  }
`;

const waitForReadySignal = `
  new Promise((done) => {
    const deadline = performance.now() + ${readyTimeout};

    function settle(ready) {
      requestAnimationFrame(() => requestAnimationFrame(() => done(ready)));
    }

    function check() {
      if (document.documentElement.dataset.startupReady === "true") {
        settle(true);
        return;
      }

      if (performance.now() > deadline) {
        settle(false);
        return;
      }

      requestAnimationFrame(check);
    }

    check();
  })
`;

export function hideUntilRevealed(appWindow) {
  const contents = appWindow.webContents;

  return new Promise((done) => {
    contents.once("dom-ready", () => done(contents.insertCSS(hiddenStyle)));
  });
}

export function waitForStartupReady(appWindow) {
  return appWindow.webContents.executeJavaScript(waitForReadySignal);
}

export async function revealApp(appWindow, hiddenStyleKey) {
  const contents = appWindow.webContents;

  const revealStyleKey = await contents.insertCSS(revealStyle);
  await contents.removeInsertedCSS(hiddenStyleKey);
  await sleep(revealTime + 50);

  if (!appWindow.isDestroyed()) {
    await contents.removeInsertedCSS(revealStyleKey);
  }
}
