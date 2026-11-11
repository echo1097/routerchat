import { describe, expect, it } from "vitest";

import {
  guessDeviceName,
  isPhoneBrowser,
  readPairingCode,
} from "../../../frontend/src/devices/phoneBrowser.js";


describe("isPhoneBrowser", () => {
  it("treats the computer's own addresses as the computer", () => {
    expect(isPhoneBrowser("127.0.0.1")).toBe(false);
    expect(isPhoneBrowser("localhost")).toBe(false);
  });

  it("treats a home network address as a phone", () => {
    expect(isPhoneBrowser("192.168.1.20")).toBe(true);
    expect(isPhoneBrowser("10.0.0.5")).toBe(true);
  });
});


describe("readPairingCode", () => {
  it("reads the code from a scanned link", () => {
    expect(readPairingCode("#pair=ABCD2345")).toBe("ABCD2345");
    expect(readPairingCode("#pair=abcd-2345")).toBe("ABCD-2345");
  });

  it("ignores anything that is not a pairing link", () => {
    expect(readPairingCode("")).toBe("");
    expect(readPairingCode("#chat=123")).toBe("");
    expect(readPairingCode("#pair=")).toBe("");
    expect(readPairingCode("#pair=<script>")).toBe("");
    expect(readPairingCode("#pair=ABCD2345&next=evil")).toBe("");
  });
});


describe("guessDeviceName", () => {
  it("names common devices", () => {
    expect(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(guessDeviceName("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("iPad");
    expect(guessDeviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toBe("Android phone");
    expect(guessDeviceName("Mozilla/5.0 (Linux; Android 15; Tablet) Safari")).toBe("Android tablet");
    expect(guessDeviceName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("My device");
  });
});
