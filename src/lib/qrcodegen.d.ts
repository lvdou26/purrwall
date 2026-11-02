/** Hand-written types for the vendored qrcodegen.js (only the surface qr.ts uses). */
declare namespace qrcodegen {
  class QrCode {
    static encodeText(text: string, ecl: QrCode.Ecc): QrCode;
    readonly size: number;
    getModule(x: number, y: number): boolean;
  }
  namespace QrCode {
    class Ecc {
      static readonly LOW: Ecc;
      static readonly MEDIUM: Ecc;
      static readonly QUARTILE: Ecc;
      static readonly HIGH: Ecc;
    }
  }
}
export default qrcodegen;
