export const phoneHelpTopics = [
  {
    title: "Chrome on Android says \"This site can't be reached\"",
    steps: [
      "Newer Android versions stop apps from reaching devices on your Wi-Fi until you allow it.",
      "On the phone, open Settings, then Apps, then Chrome, then Permissions.",
      "Allow Nearby devices. On some phones it is called Local network.",
      "Go back to Chrome and reload the page.",
    ],
  },
  {
    title: "The page won't load on any phone",
    steps: [
      "RouterChat has to be running on this computer.",
      "The phone has to be on the same Wi-Fi as this computer, not a guest network or mobile data.",
      "Turn off any VPN on the phone.",
      "The address has to start with http and not https.",
    ],
  },
  {
    title: "It worked before and now it doesn't",
    steps: [
      "Your computer's address on the Wi-Fi can change, which breaks the old bookmark.",
      "Choose Pair a phone again to see the current address and scan a new code.",
    ],
  },
  {
    title: "The phone says it isn't paired",
    steps: [
      "The phone was removed here, or it went 30 days without being used.",
      "Choose Pair a phone and scan the new code.",
    ],
  },
];
