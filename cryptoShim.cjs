// Browser crypto polyfill used as webpack's `crypto` fallback.
//
// It re-exports everything from crypto-browserify and additionally provides
// `randomUUID`, which crypto-browserify lacks but some deps (e.g. @azure/msal-node
// v5's GuidGenerator) import from `node:crypto`. We delegate to the runtime's
// native Web Crypto `randomUUID`, available in Obsidian's Electron/Chromium and
// in modern Node.
const cryptoBrowserify = require("crypto-browserify");

module.exports = cryptoBrowserify;

if (typeof module.exports.randomUUID !== "function") {
  module.exports.randomUUID = function randomUUID() {
    return globalThis.crypto.randomUUID();
  };
}
