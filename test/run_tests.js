"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { decryptBcmkn } = require("../cli");
const { makeBlock } = require("../src/ir");
const { sceneGuardChain } = require("../src/parse_kittenn");

function testSceneGuardPreservesExistingBranches() {
  const existingBranch = [makeBlock("looks_show")];
  const first = makeBlock("event_whenflagclicked", { branches: [existingBranch] });
  const body = makeBlock("looks_hide");

  const result = sceneGuardChain([first, body], "Second scene", false);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].branches.length, 2);
  assert.strictEqual(result[0].branches[0], existingBranch);
  assert.strictEqual(result[0].branches[1][0].opcode, "control_if");
  assert.deepStrictEqual(result[0].branches[1][0].branches, [[body]]);
}

function testUnicodeReversalPath() {
  const stripped = "A😀中";
  const expected = "中😀A";
  const codeUnitReversal = stripped.split("").reverse().join("");

  assert.notStrictEqual(codeUnitReversal, expected);
  assert.strictEqual(Array.from(stripped).reverse().join(""), expected);

  const salt = Buffer.from(Array.from({ length: 31 }, (_, i) => String.fromCharCode(i)).join(""), "utf8");
  const key = crypto.createHash("sha256").update(salt).digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify({ text: "😀中文" });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");

  assert.strictEqual(decryptBcmkn(payload.split("").reverse().join("")), plaintext);
}

testSceneGuardPreservesExistingBranches();
testUnicodeReversalPath();
console.log("PASS: regression tests");
