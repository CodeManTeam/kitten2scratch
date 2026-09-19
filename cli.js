#!/usr/bin/env node
/**
 * kitten2scratch CLI
 * Usage: node cli.js <input.json|.bcm4|.bcmkn> [output.sb3] [--decrypted-json path]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseKitten4 } = require("./src/parse_kitten4");
const { parseKitten3 } = require("./src/parse_kitten3");
const { parseKittenN } = require("./src/parse_kittenn");
const { emitProject, packageSb3 } = require("./src/emit_sb3");

async function hydrateRemoteAssets(project) {
  const targets = [project.stage, ...(project.sprites || [])].filter(Boolean);
  const seen = new Map();
  for (const target of targets) {
    for (const asset of [...(target.costumes || []), ...(target.sounds || [])]) {
      const url = asset.sourceFile;
      if (!/^https?:\/\//i.test(String(url || "")) || asset.__data) continue;
      if (!seen.has(url)) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          seen.set(url, Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          console.warn(`Warning: cannot download asset ${url}: ${error.message}`);
          seen.set(url, null);
        }
      }
      const data = seen.get(url);
      if (data) {
        asset.__data = data;
        asset.sourceFile = null;
      }
    }
  }
}

function decryptBcmkn(encryptedText) {
  let stripped = encryptedText.trim();
  if (stripped.charCodeAt(0) === 0xFEFF) stripped = stripped.slice(1).trim();
  if (stripped.startsWith("{") || stripped.startsWith("[")) return stripped;

  const b64_text = Array.from(stripped).reverse().join("");
  const raw = Buffer.from(b64_text, "base64");
  if (raw.length <= 28) throw new Error("input is too short to be a valid AES-GCM bcmkn payload");

  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12, raw.length - 16);
  const authTag = raw.slice(raw.length - 16);

  let salt = "";
  for (let i = 0; i < 31; i++) salt += String.fromCharCode(i);
  const saltBuf = Buffer.from(salt, "utf-8");

  const errors = [];
  for (const algorithm of ["sha256", "sha512"]) {
    try {
      const key = crypto.createHash(algorithm).update(saltBuf).digest().slice(0, 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
    } catch (err) {
      errors.push(`${algorithm}: ${err.message}`);
    }
  }
  throw new Error("decryption failed; " + errors.join(" | "));
}

function detectFormat(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bcmkn") return "kittenn";
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return null; }
  }
  if (!content || typeof content !== "object") return null;
  if (content.theatre && /^3\./.test(String(content.application_version || ""))) return "kitten3";
  if (ext === ".bcm4" || ext === ".bcm") return "kitten4";
  if (content.compile_result && content.theatre) return "kitten4";
  if (content.scenes && content.actors && content.projectName !== undefined) return "kittenn";
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node cli.js <input.json|.bcm4|.bcmkn> [output.sb3] [--decrypted-json path]");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1] && !args[1].startsWith("--")
    ? path.resolve(args[1])
    : inputPath.replace(/\.[^.]+$/, ".sb3");
  const decryptedFlag = args.indexOf("--decrypted-json");
  const decryptedOutputPath = decryptedFlag >= 0 && args[decryptedFlag + 1]
    ? path.resolve(args[decryptedFlag + 1]) : null;

  let content;
  try {
    content = fs.readFileSync(inputPath, "utf8");
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    const isBcmkn = inputPath.toLowerCase().endsWith(".bcmkn");
    if (isBcmkn || (!content.trim().startsWith("{") && !content.trim().startsWith("["))) {
      try {
        content = decryptBcmkn(content);
        console.log("Successfully decrypted bcmkn payload.");
      } catch (decErr) {
        if (isBcmkn) throw decErr;
      }
    }
    parsed = JSON.parse(content);
    if (decryptedOutputPath) {
      fs.writeFileSync(decryptedOutputPath, content, "utf8");
      console.log(`Decrypted JSON: ${decryptedOutputPath}`);
    }
  } catch (err) {
    console.error(`Input is not valid JSON and could not be decrypted: ${err.message}`);
    process.exit(1);
  }

  const format = detectFormat(inputPath, parsed);
  if (!format) {
    console.error("Cannot detect project format (not Kitten3/Kitten4/KittenN JSON)");
    process.exit(1);
  }
  console.log(`Detected format: ${format}`);

  parsed.__sourceFile = inputPath;
  let project;
  if (format === "kitten4" || format === "kitten3") {
    project = format === "kitten3" ? parseKitten3(parsed) : parseKitten4(parsed);
    project.meta.projectDir = require("path").dirname(inputPath);
  } else {
    project = parseKittenN(parsed);
  }
  project.meta.projectDir = path.dirname(inputPath);

  // K3 stores CDN URLs in theatre.styles/audio. Package them into SB3 so the
  // result remains self-contained instead of relying on the CDN at runtime.
  await hydrateRemoteAssets(project);

  const sb3Project = emitProject(project);

  const spriteCount = sb3Project.targets.length - (sb3Project.targets[0]?.isStage ? 1 : 0);
  const blockCount = sb3Project.targets.reduce((sum, t) => sum + Object.keys(t.blocks).length, 0);
  console.log(`Project: ${project.name}`);
  console.log(`Targets: ${sb3Project.targets.length} (stage + ${spriteCount} sprites)`);
  console.log(`Total sb3 blocks: ${blockCount}`);
  console.log(`Variables: ${project.variables.length}`);
  console.log(`Broadcasts: ${project.broadcasts.length}`);

  const zipBuffer = await packageSb3(sb3Project, project.__assetFiles);
  fs.writeFileSync(outputPath, zipBuffer);
  console.log(`Output: ${outputPath} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { decryptBcmkn, detectFormat };
