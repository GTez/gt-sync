import { strict as assert } from "assert";
import { Cipher, encryptedSize } from "@fyears/rclone-crypt";
// NB: we intentionally do NOT import from ../src/encryptRClone here — it pulls
// in ./encryptRClone.worker, a webpack/esbuild-only module that tsx can't load.
// src/encryptRClone re-exports getSizeFromOrigToEnc = encryptedSize verbatim,
// so testing the library's encryptedSize directly covers the same code.

// The recommended/authenticated encryption mode (rclone crypt) had zero test
// coverage. CipherRclone in src/encryptRClone.ts is only worker glue; the actual
// crypto is delegated to @fyears/rclone-crypt's Cipher, called exactly the way
// encryptRClone.worker.ts does: cipher.key(password, "") then
// encryptFileName/decryptFileName and encryptData/decryptData. We test that
// library directly so the crypto correctness has a safety net without spinning
// up Web Workers (unavailable under mocha/tsx).
describe("Encryption rclone crypt tests", () => {
  beforeEach(() => {
    // mirror the other crypto test's environment shim
    const webcrypto = require("crypto").webcrypto;
    if ((globalThis as any).crypto === undefined) {
      (globalThis as any).crypto = webcrypto;
    }
    global.window = { crypto: webcrypto } as any;
  });

  async function makeCipher(password: string) {
    const c = new Cipher("base64");
    await c.key(password, "");
    return c;
  }

  it("content round-trips (encryptData -> decryptData)", async () => {
    const c = await makeCipher("somepassword");
    const plain = new TextEncoder().encode("hello rclone 中文 🙂 content");
    const enc = await c.encryptData(plain, undefined);
    const dec = await c.decryptData(enc);
    assert.deepEqual(Buffer.from(dec), Buffer.from(plain));
  });

  it("content encryption is non-deterministic (random nonce) but both decrypt", async () => {
    const c = await makeCipher("pw");
    const plain = new TextEncoder().encode("repeatable plaintext");
    const e1 = await c.encryptData(plain, undefined);
    const e2 = await c.encryptData(plain, undefined);
    assert.ok(!Buffer.from(e1).equals(Buffer.from(e2)));
    assert.deepEqual(Buffer.from(await c.decryptData(e1)), Buffer.from(plain));
    assert.deepEqual(Buffer.from(await c.decryptData(e2)), Buffer.from(plain));
  });

  it("filename encryption is deterministic and round-trips", async () => {
    const c = await makeCipher("pw");
    const name = "folder/some note.md";
    const enc1 = await c.encryptFileName(name);
    const enc2 = await c.encryptFileName(name);
    // rclone name encryption must be deterministic so remote lookups are stable
    assert.equal(enc1, enc2);
    assert.notEqual(enc1, name);
    assert.equal(await c.decryptFileName(enc1), name);
  });

  it("wrong password fails to decrypt content (authenticated mode)", async () => {
    const c1 = await makeCipher("right-password");
    const c2 = await makeCipher("wrong-password");
    const enc = await c1.encryptData(
      new TextEncoder().encode("top secret"),
      undefined
    );
    await assert.rejects(c2.decryptData(enc));
  });

  it("encryptedSize (re-exported as getSizeFromOrigToEnc) grows with size", () => {
    // header-only for empty input, and strictly larger for non-empty
    assert.ok(encryptedSize(0) > 0);
    assert.ok(encryptedSize(1024) > encryptedSize(0));
  });
});
