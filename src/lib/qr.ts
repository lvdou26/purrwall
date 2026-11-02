import qrcodegen from './qrcodegen';

/**
 * Share-URL → SVG path data for an inline QR (share popover). Loaded via
 * dynamic import so the ~10KB encoder stays out of the initial bundle —
 * NOTE: this is the app's first code-split chunk; the update pill must stay
 * deployed alongside it (stale tabs fetching a rotated-out chunk URL get
 * SPA-fallback HTML with HTTP 200, not a clean 404).
 */
export function qrSvgPath(text: string): { size: number; d: string } {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) d += `M${x},${y}h1v1h-1z`;
    }
  }
  return { size: qr.size, d };
}
