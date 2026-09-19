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

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}
function serializeMutation(mutation) {
  if (!mutation) return null;
  const out = {};
  for (const [key, value] of Object.entries(mutation)) {
    if (key === "tagName") continue;
    if (typeof value === "boolean") {
      out[key] = value ? "true" : "false";
    } else {
      out[key] = value;
    }
  }
  if (!Array.isArray(out.children)) out.children = [];
  return out;
}

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
    const serialized = serializeMutation(block.mutation);
    if (serialized) sb3Block.mutation = serialized;
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
      const bcInfo = (context.__bcLookup && context.__bcLookup.get(fv)) ||
        (context.__bcByName && context.__bcByName.get(fv));
      fv = bcInfo ? [bcInfo.name, fv] : [fv, fv];
      if (bcInfo) fv[1] = bcInfo.id;
    } else if (fieldName === "LIST" && typeof fv === "string") {
      const listInfo = context.__listLookup && context.__listLookup.get(fv);
      fv = listInfo ? [listInfo.name, listInfo.id] : [fv, fv];
    }
    sb3Block.fields[fieldName] = Array.isArray(fv) ? fv : [fv, null];
  }

  // TurboWarp assumes event hats always have their matching selector field.
  // K3 workspaces can contain an empty broadcast listener while the user is
  // still editing it; preserve it as an empty, valid Scratch hat.
  if (block.opcode === "event_whenbroadcastreceived" && !sb3Block.fields.BROADCAST_OPTION) {
    sb3Block.fields.BROADCAST_OPTION = ["", null];
  }
  if (block.opcode === "event_broadcast" || block.opcode === "event_broadcastandwait") {
    if (!sb3Block.inputs.BROADCAST_INPUT && sb3Block.inputs.MESSAGE) {
      sb3Block.inputs.BROADCAST_INPUT = sb3Block.inputs.MESSAGE;
      delete sb3Block.inputs.MESSAGE;
    }
    if (!sb3Block.inputs.BROADCAST_INPUT) {
      const shadowId = nextBlockId();
      container[shadowId] = {
        opcode: "text", next: null, parent: blockId,
        inputs: {}, fields: { TEXT: ["", null] }, shadow: true, topLevel: false,
      };
      sb3Block.inputs.BROADCAST_INPUT = [1, shadowId];
    }
  }
  if (block.__menuShadow && sb3Block.inputs[block.__menuShadow] && sb3Block.inputs[block.__menuShadow][0] === 1) {
    const val = container[Object.entries(sb3Block.inputs).find(([k]) => k === block.__menuShadow)];
    // find the shadow block id
    const sid = sb3Block.inputs[block.__menuShadow][1];
    const shadow = container[sid];
    if (shadow && shadow.fields.TEXT !== undefined) {
      const txt = shadow.fields.TEXT[0];
      const menuId = nextBlockId();
      container[menuId] = {
        opcode: "sensing_touchingobjectmenu", next: null, parent: blockId,
        inputs: {}, fields: { TOUCHINGOBJECTMENU: [txt, null] },
        shadow: true, topLevel: false,
      };
      sb3Block.inputs[block.__menuShadow] = [1, menuId];
    }
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
  const argumentIds = JSON.parse(procDef.mutation.argumentids || "[]");
  const argumentNames = JSON.parse(procDef.mutation.argumentnames || "[]");
  const procCode = argumentIds.reduce(
    (acc, _id, i) => acc + (i > 0 ? " " : "") + "%s",
    procDef.mutation.proccode
  );
  const prototypeId = nextBlockId();
  const prototypeBlock = {
    opcode: "procedures_prototype", next: null, parent: defId,
    inputs: {}, fields: {}, shadow: true, topLevel: false,
    mutation: serializeMutation({ ...procDef.mutation, proccode: procCode }),
  };
  // Argument reporters as shadow blocks inside the prototype's argument inputs
  argumentIds.forEach((argId, i) => {
    const reporterId = nextBlockId();
    const reporterBlock = {
      opcode: "argument_reporter_string_number", next: null, parent: prototypeId,
      inputs: {}, fields: { VALUE: [argumentNames[i]] }, shadow: true, topLevel: false,
    };
    container[reporterId] = reporterBlock;
    prototypeBlock.inputs[argId] = [1, reporterId];
  });
  const defBlock = {
    opcode: "procedures_definition", next: null, parent: null,
    inputs: { custom_block: [1, prototypeId] }, fields: {}, shadow: false, topLevel: true,
    x, y, mutation: serializeMutation(procDef.mutation),
  };
  container[defId] = defBlock;
  container[prototypeId] = prototypeBlock;
  if (procDef.body && procDef.body.length > 0) {
    attachChain(defBlock, procDef.body, container, context);
  }
  return defId;
}

function ensureBroadcasts(project) {
  const byName = new Map();
  for (const broadcast of project.broadcasts || []) {
    if (broadcast && broadcast.name !== undefined) byName.set(String(broadcast.name), broadcast);
  }
  const names = [];
  const { walkChain } = require("./ir");
  for (const target of [project.stage, ...project.sprites].filter(Boolean)) {
    for (const chain of target.blocks || []) {
      walkChain(chain, (block) => {
        if (block.opcode === "event_whenbroadcastreceived") {
          const name = block.fields && block.fields.BROADCAST_OPTION;
          if (typeof name === "string" && name) names.push(name);
        }
        if (block.opcode === "event_broadcast" || block.opcode === "event_broadcastandwait") {
          const input = block.inputs && block.inputs.BROADCAST_INPUT;
          if (input && input.type === "value" && input.value !== undefined && String(input.value)) {
            names.push(String(input.value));
          }
        }
      });
    }
  }
  for (const name of names) {
    if (byName.has(name)) continue;
    const id = `__k2s_broadcast_${project.broadcasts.length + 1}`;
    const broadcast = { id, name };
    project.broadcasts.push(broadcast);
    byName.set(name, broadcast);
  }
  return byName;
}

function emitProject(project) {
  resetIds();
  const broadcastByName = ensureBroadcasts(project);
  const sb3Project = {
    targets: [], monitors: [], extensions: [],
    meta: { semver: "3.0.0", vm: "0.2.0", agent: "kitten2scratch" },
    // Kitten's PerTick scheduler runs at 60 ticks per second. TurboWarp's
    // default is 30, which doubles movement/rotation speed when copied as a
    // forever loop, so preserve the source tick rate in project.json.
    framerate: Number(project.meta.framerate) || 60,
  };
  // Compute md5ext for each costume/sound from sourceFile
  const crypto = require("crypto");
  const projectDir = project.meta.projectDir || null;
  const allTargets = [project.stage, ...project.sprites].filter(Boolean);
  const assetFiles = new Map(); // sourceFile -> {md5ext, data}
  if (projectDir) {
    const assetDir = require("path").join(projectDir, "assets");
    for (const target of allTargets) {
      for (const costume of target.costumes) {
        if (costume.__data) {
          const md5 = crypto.createHash("md5").update(costume.__data).digest("hex");
          const md5ext = md5 + "." + costume.dataFormat;
          assetFiles.set("__inline__" + md5ext, { md5ext, data: costume.__data });
          costume.sourceFile = "__inline__" + md5;
          costume.md5ext = md5ext;
          continue;
        }
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
  // Fallback: any costume without md5ext gets the blank SVG so assetId stays valid
  for (const target of allTargets) {
    for (const costume of target.costumes) {
      if (!costume.md5ext) {
        costume.md5ext = BLANK_MD5EXT;
        costume.dataFormat = "svg";
        costume.name = costume.name || "costume1";
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
  const listLookup = new Map();
  for (const v of project.variables) {
    if (v.isList) listLookup.set(v.id, { name: v.name, id: v.id });
  }
  const bcLookup = new Map();
  for (const b of project.broadcasts) bcLookup.set(b.id, { name: b.name });
  const ctx = { allVariables: project.variables, allBroadcasts: project.broadcasts, __allTargets: [project.stage, ...project.sprites].filter(Boolean), __varLookup: varLookup, __listLookup: listLookup, __bcLookup: bcLookup, __bcByName: broadcastByName, __project: project };

  if (project.stage) {
    const stage = emitTarget(project.stage, { ...ctx, isStage: true });
    const framerate = Number(project.meta.framerate) || 60;
    const width = Number(project.meta.stageWidth) || 480;
    const height = Number(project.meta.stageHeight) || 360;
    // TurboWarp loads project runtime settings from a specially marked stage
    // comment, not the root project JSON. This preserves Kitten's 60Hz
    // PerTick loops and its native canvas dimensions.
    stage.comments.__k2s_turbo_config = {
      blockId: null,
      x: 24,
      y: 24,
      width: 350,
      height: 170,
      minimized: true,
      text: `Configuration for https://turbowarp.org/\n${JSON.stringify({ framerate, width, height })} // _twconfig_`,
    };
    sb3Project.targets.push(stage);
  }
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
  const targetVarLookup = new Map(context.__varLookup || []);
  const targetListLookup = new Map(context.__listLookup || []);
  for (const variable of target.variables || []) {
    targetVarLookup.set(variable.id, { name: variable.name });
    if (variable.isList) targetListLookup.set(variable.id, { name: variable.name, id: variable.id });
  }
  const targetContext = { ...context, __varLookup: targetVarLookup, __listLookup: targetListLookup };
  const sb3Target = {
    isStage, name: isStage ? "Stage" : target.name,
    variables: {}, lists: {}, broadcasts: {},
    blocks: {}, comments: {},
    currentCostume: target.currentCostume || 0, costumes: [], sounds: [],
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
      if (v.isGlobal === false) continue;
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
      emitProcedureDef(sb3Target.blocks, procDef, targetContext, 48 + (scriptIndex % 8) * 220, 48 + scriptIndex * 100);
      scriptIndex++;
    }
  }
  for (const chain of target.blocks) {
    if (!chain || chain.length === 0) continue;
    const chainIds = emitChain(chain, sb3Target.blocks, null, targetContext);
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

module.exports = { emitProject, packageSb3, emitChain, emitBlock, emitTarget };
