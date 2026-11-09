import { shell } from "electron";

import { backendUrl } from "../config.js";

const allowedPermissions = new Set(["media", "clipboard-sanitized-write"]);
const externalProtocols = new Set(["http:", "https:", "mailto:"]);

function isAppUrl(targetUrl) {
  try {
    return new URL(targetUrl).origin === backendUrl;
  } catch {
    return false;
  }
}

function openInBrowser(targetUrl) {
  try {
    if (externalProtocols.has(new URL(targetUrl).protocol)) {
      shell.openExternal(targetUrl);
    }
  } catch {
    return;
  }
}

export function secureWindow(appWindow) {
  const contents = appWindow.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);

    return { action: "deny" };
  });

  contents.on("will-navigate", (event, targetUrl) => {
    if (isAppUrl(targetUrl)) {
      return;
    }

    event.preventDefault();
    openInBrowser(targetUrl);
  });

  contents.session.setPermissionRequestHandler((requestContents, permission, callback) => {
    const allowed = isAppUrl(requestContents.getURL()) && allowedPermissions.has(permission);

    callback(allowed);
  });

  contents.session.setPermissionCheckHandler((requestContents, permission, requestingOrigin) => {
    return isAppUrl(requestingOrigin) && allowedPermissions.has(permission);
  });
}
