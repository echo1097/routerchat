import { describe, expect, it } from "vitest";

import { qrPath, qrRows, quietZone } from "../../../frontend/src/devices/pairingQr.js";

const link = "http://192.168.1.20:8000/#pair=ABCD2345";


function finderCorner(rows, startRow, startColumn) {
  const cells = [];
  for (let row = 0; row < 7; row += 1) {
    cells.push(rows[startRow + row].slice(startColumn, startColumn + 7).map(Number).join(""));
  }
  return cells;
}


describe("qrRows", () => {
  it("builds a square grid with the three finder corners", () => {
    const rows = qrRows(link);
    const size = rows.length;
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];

    expect(size).toBeGreaterThanOrEqual(21);
    expect(rows.every((cells) => cells.length === size)).toBe(true);
    expect(finderCorner(rows, 0, 0)).toEqual(finder);
    expect(finderCorner(rows, 0, size - 7)).toEqual(finder);
    expect(finderCorner(rows, size - 7, 0)).toEqual(finder);
  });

  it("changes when the link changes", () => {
    expect(qrRows(link)).not.toEqual(qrRows(`${link}X`));
  });
});


describe("qrPath", () => {
  it("draws one square per dark cell inside the quiet zone", () => {
    const path = qrPath([[true, false], [false, true]]);

    expect(path).toBe(`M${quietZone} ${quietZone}h1v1h-1zM${quietZone + 1} ${quietZone + 1}h1v1h-1z`);
  });
});
