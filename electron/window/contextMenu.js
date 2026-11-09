import { Menu } from "electron";

import { buildMenuItems } from "./contextMenuItems.js";

export function attachContextMenu(appWindow) {
  const contents = appWindow.webContents;

  const actions = {
    replaceWord: (word) => contents.replaceMisspelling(word),
    addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
  };

  contents.on("context-menu", (event, params) => {
    const menuItems = buildMenuItems(params, actions);

    if (menuItems.length === 0) {
      return;
    }

    Menu.buildFromTemplate(menuItems).popup({ window: appWindow });
  });
}
