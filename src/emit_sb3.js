const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
/**
 * IR -> Scratch 3 / TurboWarp sb3 emitter
 */

"use strict";

const JSZip = require("jszip");

let blockIdCounter = 0;
function nextBlockId() { blockIdCounter++; return `b${blockIdCounter}`; }
function resetIds() { blockIdCounter = 0; }

const BLANK_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1' viewBox='0 0 1 1'/>";
const BLANK_MD5EXT = crypto.createHash("md5").update(BLANK_SVG).digest("hex") + ".svg";

function emitChain(chain, container, parentKey = null, context = null) {
  const ids = [];
  let prevId = parentKey;
  for (const block of chain) {
    const blockId = nextBlockId();
    const sb3Block = emitBlock(block, container, blockId, context);
    if (prevId && container[prevId]) {
      container[prevId].next = blockId;
      sb3Block.parent = prevId;
    }
    container[blockId] = sb3Block;
    ids.push(blockId);
    prevId = blockId;
  }
  return ids;
}

function attachChain(sb3Block, chain, container, context) {
  const ids = emitChain(chain, container, sb3Block, context);
  if (ids.length > 0) {
    sb3Block.next = ids[0];
  }
  return ids;
}

function emitBlock(block, container, blockId, context) {
  const isLiteral = block.opcode === "math_number" || block.opcode === "text";
  if (isLiteral) {
    const sb3Block = {
      opcode: block.opcode, next: null, parent: null,
      inputs: {}, fields: {}, shadow: true, topLevel: false,
    };
    for (const [key, input] of Object.entries(block.inputs)) {
      if (input.type === "value") {
        sb3Block.fields = { [block.opcode === "text" ? "TEXT" : "NUM"]: [input.value] };
      }
    }
    return sb3Block;
  }

  const sb3Block = {
    opcode: block.opcode, next: null, parent: null,
    inputs: {}, fields: {}, shadow: false, topLevel: false,
  };
  if (block.__nextChain && block.__nextChain.length > 0) {
    attachChain(sb3Block, block.__nextChain, container, context);
  }
  if (block.mutation) {
    sb3Block.mutation = { tagName: "mutation", children: [], ...block.mutation };
  }

  for (const [inputName, input] of Object.entries(block.inputs)) {
    if (input.type === "value") {
      const kind = input.kind;
      const shadowId = nextBlockId();
      const shadowBlock = {
        opcode: kind === "string" ? "text" : "math_number",
        next: null, parent: blockId, inputs: {}, fields: {},
        shadow: true, topLevel: false,
      };
      if (kind === "string") { shadowBlock.fields.TEXT = [String(input.value)]; }
      else { shadowBlock.fields.NUM = [Number(input.value) || 0]; }
      container[shadowId] = shadowBlock;
      sb3Block.inputs[inputName] = [1, shadowId];
    } else if (input.type === "expr") {
      const subId = nextBlockId();
      const subBlock = emitBlock(input.block, container, subId, context);
      container[subId] = subBlock;
      subBlock.parent = blockId;
      sb3Block.inputs[inputName] = [3, subId];
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(block.fields)) {
    let fv = fieldValue;
    if (fieldName === "VARIABLE" && typeof fv === "string") {
      const varInfo = context.__varLookup && context.__varLookup.get(fv);
      fv = varInfo ? [varInfo.name, fv] : [fv, fv];
    } else if (fieldName === "BROADCAST_OPTION" && typeof fv === "string") {
      const bcInfo = context.__bcLookup && context.__bcLookup.get(fv);
      fv = bcInfo ? [bcInfo.name, fv] : [fv, fv];
    }
    sb3Block.fields[fieldName] = [fv];
  }

  const branchNames = ["SUBSTACK", "SUBSTACK2"];
  for (let i = 0; i < block.branches.length && i < 2; i++) {
    const branch = block.branches[i];
    if (!branch || branch.length === 0) continue;
    const chainIds = emitChain(branch, container, blockId, context);
    if (chainIds.length > 0) {
      sb3Block.inputs[branchNames[i]] = [2, chainIds[0]];
    }
  }

  return sb3Block;
}

function emitProcedureDef(container, procDef, context, x, y) {
  const defId = nextBlockId();
  const defBlock = {
    opcode: "procedures_definition", next: null, parent: null,
    inputs: {}, fields: {}, shadow: false, topLevel: true,
    x, y, mutation: { ...procDef.mutation },
  };
  container[defId] = defBlock;
  if (procDef.body && procDef.body.length > 0) {
    attachChain(defBlock, procDef.body, container, context);
  }
  return defId;
}

function emitProject(project) {
  resetIds();
  const sb3Project = {
    targets: [], monitors: [], extensions: [],
    meta: { semver: "3.0.0", vm: "0.2.0", agent: "kitten2scratch" },
  };
  // Compute md5ext for each costume/sound from sourceFile
  const crypto = require("crypto");
  const projectDir = project.meta.projectDir || null;
  const assetFiles = new Map(); // sourceFile -> {md5ext, data}
  if (projectDir) {
    const assetDir = require("path").join(projectDir, "assets");
    const allTargets = [project.stage, ...project.sprites].filter(Boolean);
    for (const target of allTargets) {
      for (const costume of target.costumes) {
        if (!costume.sourceFile) continue;
        if (assetFiles.has(costume.sourceFile)) { costume.md5ext = assetFiles.get(costume.sourceFile).md5ext; continue; }
        const fp = require("path").join(assetDir, costume.sourceFile);
        if (!fs.existsSync(fp)) continue;
        const data = fs.readFileSync(fp);
        const md5 = crypto.createHash("md5").update(data).digest("hex");
        const md5ext = md5 + "." + costume.dataFormat;
        assetFiles.set(costume.sourceFile, { md5ext, data });
        costume.md5ext = md5ext;
      }
      for (const sound of target.sounds) {
        if (!sound.sourceFile) continue;
        if (assetFiles.has(sound.sourceFile)) { sound.md5ext = assetFiles.get(sound.sourceFile).md5ext; continue; }
        const fp = require("path").join(assetDir, sound.sourceFile);
        if (!fs.existsSync(fp)) continue;
        const data = fs.readFileSync(fp);
        const md5 = crypto.createHash("md5").update(data).digest("hex");
        const md5ext = md5 + "." + (sound.dataFormat || "mp3");
        assetFiles.set(sound.sourceFile, { md5ext, data });
        sound.md5ext = md5ext;
      }
    }
  }

  // Normalize SVGs for scratch-svg-renderer compatibility
  function normalizeSvg(svgText) {
    let out = svgText;
    // 1) Strip isFromKittenPainter and data-paper-data attributes
    out = out.replace(/\s+isFromKittenPainter="[^"]*"/g, "");
    out = out.replace(/\s+data-paper-data="[^"]*"/g, "");
    // 2) Convert <image href= to xlink:href=
    out = out.replace(/<image([^>]*?)\s+href=/g, '<image$1 xlink:href=');
    // Ensure xmlns:xlink is present
    if (out.includes('xlink:href') && !out.includes('xmlns:xlink')) {
      out = out.replace(/<svg\s/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ');
    }
    // 3) Strip px from width/height, add viewBox if missing
    out = out.replace(/width="([\d.]+)px"/g, 'width="$1"');
    out = out.replace(/height="([\d.]+)px"/g, 'height="$1"');
    const wm = out.match(/width="([\d.]+)"/);
    const hm = out.match(/height="([\d.]+)"/);
    if (wm && hm && !out.includes('viewBox')) {
      out = out.replace(/(<svg[^>]*?)\s*(\/?)>/, '$1 viewBox="0 0 ' + wm[1] + ' ' + hm[1] + '"$2>');
    }
    return out;
  }

  // Apply normalization to all SVG assets
  if (projectDir) {
    for (const [key, info] of assetFiles) {
      if (key.endsWith(".svg") && info.data) {
        const text = info.data.toString("utf8");
        const normalized = normalizeSvg(text);
        info.data = Buffer.from(normalized, "utf8");
      }
    }
  }

  project.__assetFiles = assetFiles;

  const varLookup = new Map();
  for (const v of project.variables) varLookup.set(v.id, { name: v.name });
  const bcLookup = new Map();
  for (const b of project.broadcasts) bcLookup.set(b.id, { name: b.name });
  const ctx = { allVariables: project.variables, allBroadcasts: project.broadcasts, __allTargets: [project.stage, ...project.sprites].filter(Boolean), __varLookup: varLookup, __bcLookup: bcLookup, __project: project };

  if (project.stage) sb3Project.targets.push(emitTarget(project.stage, { ...ctx, isStage: true }));
  for (const sprite of project.sprites) {
    sb3Project.targets.push(emitTarget(sprite, { ...ctx, isStage: false }));
  }

  const extensions = new Set();
  const { walkBlocks } = require("./ir");
  for (const target of [project.stage, ...project.sprites].filter(Boolean)) {
    for (const chain of target.blocks) {
      for (const block of chain) {
        walkBlocks(block, (b) => {
          if (b && b.opcode && b.opcode.startsWith("pen_")) extensions.add("pen");
        });
      }
    }
  }
  sb3Project.extensions = Array.from(extensions);
  return sb3Project;
}

function emitTarget(target, context) {
  const { isStage } = context;
  const sb3Target = {
    isStage, name: isStage ? "Stage" : target.name,
    variables: {}, lists: {}, broadcasts: {},
    blocks: {}, comments: {},
    currentCostume: 0, costumes: [], sounds: [],
    volume: 100, layerOrder: target.layerOrder || 0,
    tempo: 60, videoTransparency: 50, videoState: "on",
    textToSpeechLanguage: null,
  };
  if (!isStage) {
    Object.assign(sb3Target, {
      x: target.x || 0, y: target.y || 0,
      size: target.size || 100, direction: target.direction || 90,
      draggable: target.draggable || false,
      rotationStyle: target.rotationStyle || "all around",
      visible: target.visible !== false,
    });
  }

  for (const c of target.costumes) {
    const assetId = (c.md5ext || "").split(".")[0];
    sb3Target.costumes.push({ name: c.name, assetId, md5ext: c.md5ext, dataFormat: c.dataFormat, rotationCenterX: c.rotationCenterX, rotationCenterY: c.rotationCenterY, bitmapResolution: c.bitmapResolution || 1 });
  }
  if (sb3Target.costumes.length === 0) {
    // Use a default blank SVG we control (always included in zip)
    sb3Target.costumes.push({
      name: isStage ? "backdrop1" : "costume1",
      md5ext: BLANK_MD5EXT,
      dataFormat: "svg",
      rotationCenterX: 0, rotationCenterY: 0,
      bitmapResolution: 1,
    });
  }

  for (const s of target.sounds) {
    const assetId = (s.md5ext || "").split(".")[0];
    sb3Target.sounds.push({ name: s.name, assetId, md5ext: s.md5ext, dataFormat: s.dataFormat, rate: s.rate || 44100, sampleCount: s.sampleCount || 0 });
  }

  for (const v of target.variables || []) {
    if (v.isList) { sb3Target.lists[v.id] = [v.name, v.value || []]; }
    else { sb3Target.variables[v.id] = [v.name, v.value || 0, ...(v.isCloud ? [true] : [])]; }
  }

  if (isStage && context.allVariables) {
    const localIds = new Set((target.variables || []).map(v => v.id));
    for (const v of context.allVariables) {
      if (localIds.has(v.id)) continue;
      if (v.isList) { sb3Target.lists[v.id] = [v.name, Array.isArray(v.value) ? v.value : []]; }
      else { sb3Target.variables[v.id] = [v.name, v.value || 0, ...(v.isCloud ? [true] : [])]; }
    }
    // Dedupe same-name variables that have different IDs (TurboWarp warning fix)
    const byName = new Map();
    for (const [vid, vdata] of Object.entries(sb3Target.variables)) {
      if (byName.has(vdata[0])) {
        // keep the one already there, remove the duplicate from a different id
        delete sb3Target.variables[vid];
      } else byName.set(vdata[0], vid);
    }
  }
  if (isStage && context.allBroadcasts) {
    for (const b of context.allBroadcasts) {
      sb3Target.broadcasts[b.id] = b.name;
    }
  }

  // Auto-create orphan variable references (stage only, so IDs are declared once)
  if (isStage) {
    const knownIds = new Set([
      ...Object.keys(sb3Target.variables),
      ...Object.keys(sb3Target.lists),
    ]);
    const referenced = new Set();
    const scanBlock = (b) => {
      if (b.fields && b.fields.VARIABLE) referenced.add(String(b.fields.VARIABLE));
      for (const inp of Object.values(b.inputs || {})) {
        if (inp.type === "expr") scanBlock(inp.block);
      }
      for (const br of b.branches || []) {
        for (const bb of br) scanBlock(bb);
      }
    };
    for (const t of context.__allTargets || []) {
      for (const chain of t.blocks || []) {
        for (const b of chain) scanBlock(b);
      }
    }
    let orphanIdx = 0;
    for (const refId of referenced) {
      if (knownIds.has(refId)) continue;
      sb3Target.variables[refId] = ["__orphan_" + (++orphanIdx), 0];
    }
  }

  let scriptIndex = 0;
  const procDefs = target.__procedures || (context.isStage && context.__project ? context.__project.procedures : null);
  const procSource = procDefs || { values: () => [] };
  if (procDefs) {
    for (const procDef of procDefs.values()) {
      emitProcedureDef(sb3Target.blocks, procDef, context, 48 + (scriptIndex % 8) * 220, 48 + scriptIndex * 100);
      scriptIndex++;
    }
  }
  for (const chain of target.blocks) {
    if (!chain || chain.length === 0) continue;
    const chainIds = emitChain(chain, sb3Target.blocks, null, context);
    if (chainIds.length > 0) {
      sb3Target.blocks[chainIds[0]].topLevel = true;
      sb3Target.blocks[chainIds[0]].x = 48 + (scriptIndex % 8) * 220;
      sb3Target.blocks[chainIds[0]].y = 48 + scriptIndex * 100;
      scriptIndex++;
    }
  }
  return sb3Target;
}

async function packageSb3(sb3Project, assetFetcher) {
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify(sb3Project));
  zip.file(BLANK_MD5EXT, BLANK_SVG);
  if (assetFetcher && typeof assetFetcher === "object") {
    for (const [file, info] of assetFetcher) {
      zip.file(info.md5ext, info.data);
    }
  } else if (assetFetcher && typeof assetFetcher === "function") {
    const assetSet = new Set();
    for (const t of sb3Project.targets) {
      for (const c of t.costumes) assetSet.add(c.md5ext);
      for (const s of t.sounds) assetSet.add(s.md5ext);
    }
    for (const md5ext of assetSet) {
      try {
        const data = await assetFetcher(md5ext);
        if (data) zip.file(md5ext, data);
      } catch (e) { console.warn(`asset ${md5ext}: ${e.message}`); }
    }
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

module.exports = { emitProject, packageSb3, emitChain, emitBlock };
