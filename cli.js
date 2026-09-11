#!/usr/bin/env node
/**
 * kitten2scratch CLI
 * Usage: node cli.js <input.json|.bcm4|.bcmkn> [output.sb3]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parseKitten4 } = require("./src/parse_kitten4");
const { parseKittenN } = require("./src/parse_kittenn");
const { emitProject, packageSb3 } = require("./src/emit_sb3");

function detectFormat(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bcmkn") return "kittenn";
  if (ext === ".bcm4" || ext === ".bcm") return "kitten4";
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return null; }
  }
  if (!content || typeof content !== "object") return null;
  if (content.compile_result && content.theatre) return "kitten4";
  if (content.scenes && content.actors && content.projectName !== undefined) return "kittenn";
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node cli.js <input.json|.bcm4|.bcmkn> [output.sb3]");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1] ? path.resolve(args[1]) : inputPath.replace(/\.[^.]+$/, ".sb3");

  let content;
  try {
    content = fs.readFileSync(inputPath, "utf8");
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    process.exit(1);
  }

  let parsed;
  try { parsed = JSON.parse(content); } catch {
    console.error("Input is not valid JSON. For .bcmkn, decrypt it first with tools/decrypt_bcmkn.py");
    process.exit(1);
  }

  const format = detectFormat(inputPath, parsed);
  if (!format) {
    console.error("Cannot detect project format (not Kitten4/KittenN JSON)");
    process.exit(1);
  }
  console.log(`Detected format: ${format}`);

  let project;
  if (format === "kitten4") {
    parsed.__sourceFile = inputPath;
    project = parseKitten4(parsed);
    project.meta.projectDir = require("path").dirname(inputPath);
  } else {
    project = parseKittenN(parsed);
  }

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

main().catch(e => { console.error(e); process.exit(1); });
