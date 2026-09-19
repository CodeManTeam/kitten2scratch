/**
 * Unified Block IR (Intermediate Representation)
 *
 * All three source formats (Kitten4 compile_result, KittenN nekoBlockJsonList,
 * and legacy Kitten .bcm) are normalized into this single model, which then
 * maps nearly 1:1 onto Scratch 3 / TurboWarp sb3.
 *
 * Block shape:
 * {
 *   opcode: string,              // Scratch-style opcode (e.g. "event_whenflagclicked")
 *   fields: { [name]: value },   // dropdown field values
 *   inputs: { [name]: Input },   // Input = {type:"expr", block:IRBlock} | {type:"value", value:any, kind:"number"|"string"|"bool"}
 *   branches: [IRBlock|null],    // substack chains (index 0 = SUBSTACK, 1 = SUBSTACK2)
 *   mutation: object|null,       // for custom procedures
 *   warp: bool|null,             // for "warp" procedure calls
 *   meta: { kittenType, kittenId, source }
 * }
 *
 * Project shape:
 * {
 *   name: string,
 *   stage: Target,
 *   sprites: Target[],
 *   variables: Variable[],
 *   broadcasts: Broadcast[],
 *   procedures: Map<procId, ProcDef>,
 *   meta: { sourceFormat, sourceFile }
 * }
 *
 * Target shape:
 * {
 *   name, isStage,
 *   variables: Variable[],        // local to this target
 *   blocks: IRBlock[],            // top-level script chains (hat blocks)
 *   costumes: Costume[],          // {name, md5ext, dataFormat, rotationCenter}
 *   sounds: Sound[],
 *   x, y, size, direction, visible, draggable, rotationStyle, layerOrder
 * }
 */

"use strict";

const IR_VERSION = "1.0.0";

function makeBlock(opcode, options = {}) {
  return {
    opcode,
    fields: options.fields || {},
    inputs: options.inputs || {},
    branches: options.branches || [],
    mutation: options.mutation || null,
    warp: options.warp || null,
    meta: options.meta || {},
  };
}

function makeExpr(block) {
  return { type: "expr", block };
}

function makeValue(value, kind = "number") {
  return { type: "value", value, kind };
}

function makeProject(name, meta = {}) {
  return {
    name: name || "Untitled",
    stage: null,
    sprites: [],
    variables: [],
    broadcasts: [],
    procedures: new Map(),
    meta: { sourceFormat: "unknown", sourceFile: null, irVersion: IR_VERSION, ...meta },
  };
}

function makeTarget(name, isStage = false) {
  return {
    name: name || (isStage ? "Stage" : "Sprite"),
    isStage,
    variables: [],
    blocks: [],
    costumes: [],
    sounds: [],
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    visible: true,
    draggable: false,
    rotationStyle: "all around",
    currentCostume: 0,
    layerOrder: 0,
  };
}

function addSpriteInitialization(target) {
  if (!target || target.isStage) return;
  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return makeValue(Number.isFinite(parsed) ? parsed : fallback, "number");
  };
  const costume = target.costumes[target.currentCostume] || target.costumes[0];
  const chain = [
    makeBlock("event_whenflagclicked"),
    makeBlock("motion_gotoxy", { inputs: { X: number(target.x), Y: number(target.y) } }),
    makeBlock("motion_setrotationstyle", { fields: { STYLE: target.rotationStyle || "all around" } }),
    makeBlock("motion_pointindirection", { inputs: { DIRECTION: number(target.direction, 90) } }),
    makeBlock("looks_setsizeto", { inputs: { SIZE: number(target.size, 100) } }),
  ];
  if (costume) {
    chain.push(makeBlock("looks_switchcostumeto", {
      inputs: { COSTUME: makeValue(costume.name, "string") },
    }));
  }
  chain.push(makeBlock(target.visible === false ? "looks_hide" : "looks_show"));
  target.blocks.unshift(chain);
}

function addSceneVisibilityHandlers(target, ownBackdrop, allBackdrops, visible) {
  if (!ownBackdrop) return;
  for (const backdrop of allBackdrops) {
    target.blocks.push([
      makeBlock("event_whenbackdropswitchesto", { fields: { BACKDROP: backdrop } }),
      makeBlock(backdrop === ownBackdrop && visible ? "looks_show" : "looks_hide"),
    ]);
  }
}

function makeVariable(id, name, value, isCloud = false, isList = false, isGlobal = true) {
  return { id, name, value: value !== undefined ? value : "", isCloud, isList, isGlobal };
}

function makeBroadcast(id, name) {
  return { id, name };
}

function makeCostume(name, md5ext, dataFormat, rotationCenterX = 240, rotationCenterY = 180, bitmapResolution = 1) {
  return { name, md5ext, dataFormat, rotationCenterX, rotationCenterY, bitmapResolution };
}

function makeSound(name, md5ext, dataFormat, rate = 44100, sampleCount = 0) {
  return { name, md5ext, dataFormat, rate, sampleCount };
}

/**
 * Walk a chain of blocks linked by `next` (IR doesn't have `next` —
 * chains are arrays of blocks). Helper to flatten nested structures.
 */
function walkBlocks(block, visitor, depth = 0) {
  if (!block) return;
  visitor(block, depth);
  for (const [key, input] of Object.entries(block.inputs || {})) {
    if (input.type === "expr") walkBlocks(input.block, visitor, depth + 1);
  }
  for (const branch of block.branches || []) {
    walkBlocks(branch, visitor, depth + 1);
  }
}

function walkChain(chain, visitor) {
  for (const block of chain || []) {
    walkBlocks(block, visitor);
  }
}

function countBlocks(block) {
  let count = 0;
  walkBlocks(block, () => count++);
  return count;
}

module.exports = {
  IR_VERSION,
  makeBlock,
  makeExpr,
  makeValue,
  makeProject,
  makeTarget,
  addSpriteInitialization,
  addSceneVisibilityHandlers,
  makeVariable,
  makeBroadcast,
  makeCostume,
  makeSound,
  walkBlocks,
  walkChain,
  countBlocks,
};
