import qrcode from "qrcode-generator";

export const quietZone = 4;

export function qrRows(text) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const rows = [];

  for (let row = 0; row < size; row += 1) {
    const cells = [];
    for (let column = 0; column < size; column += 1) {
      cells.push(code.isDark(row, column));
    }
    rows.push(cells);
  }

  return rows;
}

export function qrPath(rows) {
  const parts = [];

  rows.forEach((cells, row) => {
    cells.forEach((dark, column) => {
      if (dark) {
        parts.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
      }
    });
  });

  return parts.join("");
}
