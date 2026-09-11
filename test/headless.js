"use strict";
const fs = require("fs");
const VirtualMachine = require("../../tw-vm/src/index.js");
const ScratchStorage = require("../../tw-storage/dist/node/scratch-storage.js");

async function testProject(sb3Path) {
  const buf = fs.readFileSync(sb3Path);
  console.log("Loaded:", sb3Path, (buf.length / 1024).toFixed(1), "KB");
  const vm = new VirtualMachine();
  const storage = new ScratchStorage();
  storage.addWebStore(
    [ScratchStorage.AssetType.ImageVector, ScratchStorage.AssetType.ImageBitmap, ScratchStorage.AssetType.Sound],
    asset => "https://assets.scratch.mit.edu/internalapi/asset/" + asset.assetId + "." + asset.dataFormat + "/get/"
  );
  vm.attachStorage(storage);
  try { await vm.loadProject(buf); console.log("Project loaded OK"); }
  catch (e) { console.error("LOAD FAILED:", e.message || e); process.exit(1); }

  const targets = vm.runtime.targets;
  console.log("Targets:", targets.length);
  for (const t of targets) {
    const name = t.isStage ? "Stage" : t.getName();
    const costumeCount = t.getCostumes().length;
    const blockCount = Object.keys(t.blocks._blocks).length;
    console.log("  [" + (t.isStage ? "stage" : "sprite") + "] " + name + " costumes=" + costumeCount + " blocks=" + blockCount);
  }
  console.log('(skipping step to avoid infinite loop)');
  vm.runtime.dispose();
  console.log("PASS");
}

const args = process.argv.slice(2);
if (args.length < 1) { console.error("Usage: node test/headless.js <project.sb3>"); process.exit(1); }
testProject(args[0]).catch(e => { console.error(e); process.exit(1); });
