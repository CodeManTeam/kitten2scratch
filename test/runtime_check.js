"use strict";
const fs = require("fs");
const VirtualMachine = require("../../tw-vm/src/index.js");
const ScratchStorage = require("../../tw-storage/dist/node/scratch-storage.js");

async function main() {
  const vm = new VirtualMachine();
  const storage = new ScratchStorage();
  storage.addWebStore(
    [ScratchStorage.AssetType.ImageVector, ScratchStorage.AssetType.ImageBitmap, ScratchStorage.AssetType.Sound],
    a => "https://assets.scratch.mit.edu/internalapi/asset/" + a.assetId + "." + a.dataFormat + "/get/"
  );
  vm.attachStorage(storage);
  await vm.loadProject(fs.readFileSync(process.argv[2] || "out/turbowarp_test.sb3"));
  const ces = [];
  vm.runtime.on("COMPILE_ERROR", (args) => ces.push(args));
  const errs = [];
  vm.runtime.on("RUNTIME_ERROR_DISMISSABLE", (e) => errs.push(String(e)));
  vm.start();
  vm.greenFlag();
  await new Promise(r => setTimeout(r, 1500));
  console.log("compile_errors=" + ces.length + " runtime_errors=" + errs.length);
  if (ces.length) console.log(ces.slice(0, 3).map(c => (c.blockOpcode || "?") + " " + (c.errorMessage || "")).join("\n"));
  if (errs.length) console.log(errs.slice(0, 3).join("\n"));
  vm.runtime.dispose();
}
main().catch(e => { console.error(e); process.exit(1); });
