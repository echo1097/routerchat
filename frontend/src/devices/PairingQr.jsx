import { useMemo } from "react";

import { qrPath, qrRows, quietZone } from "./pairingQr.js";

export function PairingQr({ link, label = "QR code to pair a phone" }) {
  const { path, size } = useMemo(() => {
    const rows = qrRows(link);
    return { path: qrPath(rows), size: rows.length + quietZone * 2 };
  }, [link]);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="h-44 w-44 rounded-2xl bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
