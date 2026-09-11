/**
 * KittenN (Nemo) parser
 *
 * Input: decrypted KittenN project JSON (with `scenes`, `actors`, each having
 * `nekoBlockJsonList`).
 *
 * KittenN blocks are Blockly-style JSON:
 *   { type, id, fields, inputs: {A: {type, id, fields, inputs, ...}}, shadows,
 *     next: {...}, parent_id, is_output, is_shadow }
 *
 * Shadows are XML strings like:
 *   <shadow xmlns="..." type="math_number" id="...">
 *     <field name="NUM">6</field>
 *   </shadow>
 *
 * We convert to the same IR as Kitten4.
 */

"use strict";

const {
  makeProject, makeTarget, makeVariable, makeBroadcast,
  makeBlock, makeExpr, makeValue, makeCostume,
} = require("./ir");
const { BLOCK_MAP } = require("./block_map");

// ---- Shadow XML parser (minimal, no DOM) ----

function parseShadowXml(xml) {
  if (!xml || typeof xml !== "string") return null;
  const typeMatch = xml.match(/type="([^"]+)"/);
  const type = typeMatch ? typeMatch[1] : "unknown";

  const fields = {};
  const fieldRe = /<field[^>]*name="([^"]+)"[^>]*>([^<]*)<\/field>/g;
  let m;
  while ((m = fieldRe.exec(xml)) !== null) {
    fields[m[1]] = m[2];
  }
  return { type, fields };
}

// ---- Block conversion ----

function convertNemoChain(nemoBlock, context) {
  const chain = [];
  let current = nemoBlock;
  let guard = 0;
  while (current && typeof current === "object" && guard < 10000) {
    guard++;
    const block = convertNemoBlock(current, context);
    if (block) chain.push(block);
    current = current.next;
  }
  return chain;
}

function convertNemoBlock(nemoBlock, context) {
  const type = nemoBlock.type;

  // Handle shadow blocks (inline literals)
  if (nemoBlock.is_shadow) {
    const literal = makeBlock("math_number", {
      meta: { kittenType: type, kittenId: nemoBlock.id, source: "kittenn", isShadow: true },
    });
    const fields = nemoBlock.fields || {};
    literal.inputs.NUM = makeValue(fields.NUM !== undefined ? fields.NUM : fields.TEXT || 0, "number");
    if (type === "text") {
      literal.opcode = "text";
      literal.inputs.TEXT = makeValue(fields.TEXT || "", "string");
      delete literal.inputs.NUM;
    }
    return literal;
  }

  const mapping = BLOCK_MAP[type];
  if (!mapping) {
    return makeBlock("comment", {
      meta: { kittenType: type, kittenId: nemoBlock.id, source: "kittenn", unsupported: true },
    });
  }

  const irBlock = makeBlock(mapping.opcode, {
    meta: { kittenType: type, kittenId: nemoBlock.id, source: "kittenn" },
  });

  // Convert fields
  const fields = nemoBlock.fields || {};
  for (const [key, value] of Object.entries(fields)) {
    const mapped = findMapKey(mapping.map, key);
    if (mapped) {
      irBlock.fields[mapped[0]] = value;
    } else {
      // Try to store as lowercase version of field key
      irBlock.fields[key.toUpperCase()] = value;
    }
  }

  // Convert shadow defaults (when no real input is present)
  const shadows = nemoBlock.shadows || {};
  for (const [shadowKey, shadowXml] of Object.entries(shadows)) {
    const shadow = parseShadowXml(shadowXml);
    if (!shadow) continue;
    const scratchName = findMapKey(mapping.map, shadowKey)?.[0] || shadowKey.toUpperCase();

    // If there's no real input for this slot, use the shadow as default
    const realInput = nemoBlock.inputs && nemoBlock.inputs[shadowKey];
    if (!realInput) {
      const kind = shadow.type === "text" ? "string" : "number";
      const value = shadow.fields.NUM !== undefined ? Number(shadow.fields.NUM)
                   : shadow.fields.TEXT !== undefined ? shadow.fields.TEXT : 0;
      irBlock.inputs[scratchName] = makeValue(value, kind);
    }
  }

  // Convert inputs (real nested blocks)
  const inputs = nemoBlock.inputs || {};
  for (const [inputKey, inputBlock] of Object.entries(inputs)) {
    const scratchName = findMapKey(mapping.map, inputKey)?.[0] || inputKey.toUpperCase();
    if (inputBlock && typeof inputBlock === "object" && inputBlock.type) {
      irBlock.inputs[scratchName] = makeExpr(convertNemoBlock(inputBlock, context));
    }
  }

  // Handle branches (controls_if, repeat_forever etc.)
  // KittenN doesn't use child_block — it uses nested `statements` or the next chain
  // Actually KittenN uses the same structure with `branch` in some versions, but
  // the reference project has substack as the first `next` under certain blocks.
  // For controls_if: the branch is typically in `inputs.SUBSTACK`
  if (type === "controls_if") {
    if (nemoBlock.inputs && nemoBlock.inputs.SUBSTACK) {
      irBlock.branches.push(convertNemoChain(nemoBlock.inputs.SUBSTACK, context));
    }
    if (nemoBlock.inputs && nemoBlock.inputs.SUBSTACK2) {
      irBlock.branches.push(convertNemoChain(nemoBlock.inputs.SUBSTACK2, context));
    }
  }
  if (["repeat_forever", "repeat_n_times", "repeat_forever_until", "warp"].includes(type)) {
    if (nemoBlock.inputs && nemoBlock.inputs.SUBSTACK) {
      irBlock.branches.push(convertNemoChain(nemoBlock.inputs.SUBSTACK, context));
    }
  }

  // Special handlers (shared logic with Kitten4)
  if (mapping.special) {
    applyNemoSpecial(type, irBlock, nemoBlock, context);
  }

  return irBlock;
}

function findMapKey(map, kittenKey) {
  if (!map) return null;
  for (const [scratchName, [kind, key]] of Object.entries(map)) {
    if (key === kittenKey) return [scratchName, kind];
  }
  return null;
}

function applyNemoSpecial(type, irBlock, nemoBlock, context) {
  const fields = nemoBlock.fields || {};
  const inputs = nemoBlock.inputs || {};

  switch (type) {
    case "math_arithmetic": {
      const op = fields.type || fields.OP || "add";
      const scratchOp = { add: "+", minus: "-", multiply: "*", divide: "/" }[op] || "+";
      irBlock.opcode = {
        "+": "operator_add", "-": "operator_subtract",
        "*": "operator_multiply", "/": "operator_divide",
      }[scratchOp] || "operator_add";
      // Ensure inputs
      if (!irBlock.inputs.A && inputs.A) {
        irBlock.inputs.A = makeExpr(convertNemoBlock(inputs.A, context));
      }
      if (!irBlock.inputs.B && inputs.B) {
        irBlock.inputs.B = makeExpr(convertNemoBlock(inputs.B, context));
      }
      break;
    }
    case "logic_compare": {
      const op = fields.type || "eq";
      irBlock.opcode = { gt: "operator_gt", lt: "operator_lt", eq: "operator_equals" }[op] || "operator_equals";
      break;
    }
    case "logic_operation": {
      const op = fields.type || "and";
      irBlock.opcode = op === "or" ? "operator_or" : "operator_and";
      break;
    }
    case "math_trig":
    case "math_single":
    case "math_round": {
      const opMap = {
        sin: "sin", cos: "cos", tan: "tan", asin: "asin", acos: "acos", atan: "atan",
        sqrt: "sqrt", abs: "abs", ln: "ln", log: "log", "e ^": "e ^", "10 ^": "10 ^",
        round: "round", floor: "floor", ceiling: "ceiling",
        "0": "sqrt", "1": "abs", "2": "abs", "3": "ln", "4": "log", "5": "e ^", "6": "10 ^",
      };
      irBlock.fields.OPERATOR = opMap[fields.type] || "sqrt";
      if (inputs.A && !irBlock.inputs.NUM) {
        irBlock.inputs.NUM = makeExpr(convertNemoBlock(inputs.A, context));
      }
      break;
    }
    case "variables_get":
    case "script_variables_value": {
      irBlock.fields.VARIABLE = fields.variable || fields.VAR || "<unknown>";
      break;
    }
    case "variables_set":
    case "change_variables": {
      irBlock.fields.VARIABLE = fields.variable || "<unknown>";
      if (inputs.value && !irBlock.inputs.VALUE) {
        irBlock.inputs.VALUE = makeExpr(convertNemoBlock(inputs.value, context));
      }
      break;
    }
    case "procedures_2_defnoreturn": {
      irBlock.mutation = {
        procCode: fields.NAME || "function",
        argumentids: JSON.stringify([]),
        argumentnames: JSON.stringify([]),
        argumentdefaults: JSON.stringify([]),
        warp: "false",
      };
      break;
    }
    case "procedures_2_callnoreturn": {
      irBlock.mutation = { procCode: fields.procCode || fields.NAME || "function" };
      break;
    }
    case "procedures_2_parameter":
    case "procedures_2_stable_parameter":
    case "script_variables_param": {
      irBlock.fields.VALUE = fields.param_name || fields.name || "";
      break;
    }
  }
}

// ---- Project-level parsing ----

function parseKittenN(decryptedJson) {
  const project = makeProject(decryptedJson.projectName || "KittenN Project", {
    sourceFormat: "kittenn",
    sourceFile: decryptedJson.__sourceFile || null,
  });

  // Variables
  const variables = decryptedJson.variables || {};
  if (Array.isArray(variables)) {
    for (const v of variables) {
      project.variables.push(makeVariable(v.id || v.name, v.name || v.id, v.value || "", v.isCloud || false, Array.isArray(v.value), true));
    }
  } else if (typeof variables === "object") {
    for (const [id, v] of Object.entries(variables)) {
      project.variables.push(makeVariable(id, v.name || id, v.value || "", v.isCloud || false, Array.isArray(v.value), true));
    }
  }

  // Broadcasts
  let broadcasts = decryptedJson.broadcasts || {};
  if (broadcasts.broadcastsDict) broadcasts = broadcasts.broadcastsDict;
  if (Array.isArray(broadcasts)) {
    for (const b of broadcasts) {
      project.broadcasts.push(makeBroadcast(b.id || b.name, b.name || b.id));
    }
  } else if (typeof broadcasts === "object") {
    for (const [id, value] of Object.entries(broadcasts)) {
      if (id === "toJSON") continue;
      const names = Array.isArray(value) ? value : [value];
      for (const name of names) {
        if (typeof name === "string" && name) {
          project.broadcasts.push(makeBroadcast(id, name));
        }
      }
    }
  }

  // Build stage from first scene
  const scenesData = decryptedJson.scenes || {};
  const scenesDict = scenesData.scenesDict || {};
  const currentSceneId = scenesData.currentSceneId;
  const sceneIds = scenesData.sortList || Object.keys(scenesDict);

  // First scene becomes the stage
  const stageSceneId = currentSceneId || sceneIds[0];
  const stageScene = scenesDict[stageSceneId];
  const stage = makeTarget(stageScene ? (stageScene.name || "Stage") : "Stage", true);
  project.stage = stage;

  // Remaining scenes become hidden sprites (TurboWarp pattern for multi-scene)
  for (const sceneId of sceneIds.slice(1)) {
    const scene = scenesDict[sceneId];
    if (!scene) continue;
    const sprite = makeTarget(`[Scene] ${scene.name || sceneId}`, false);
    sprite.visible = false;
    project.sprites.push(sprite);
    attachNemoScripts(scene, sprite, context);
  }

  // Actors -> sprites
  const actorsData = decryptedJson.actors || {};
  const actorsDict = actorsData.actorsDict || {};
  let layerOrder = 1;
  for (const [actorId, actor] of Object.entries(actorsDict)) {
    const sprite = makeTarget(actor.name || actorId, false);
    sprite.__actorId = actorId;
    sprite.x = actor.position ? (actor.position.x || 0) : 0;
    sprite.y = actor.position ? -(actor.position.y || 0) : 0; // Nemo Y-axis is inverted
    sprite.size = actor.scale || 100;
    sprite.visible = actor.visible !== false;
    sprite.layerOrder = layerOrder++;
    project.sprites.push(sprite);
    attachNemoScripts(actor, sprite, { project, target: sprite });
  }

  // Stage scripts
  if (stageScene) {
    attachNemoScripts(stageScene, stage, { project, target: stage });
  }

  return project;

  function context() { return { project, target: null }; }
}

function attachNemoScripts(entity, target, context) {
  const blockList = entity.nekoBlockJsonList || [];
  for (const rootBlock of blockList) {
    const chain = convertNemoChain(rootBlock, context);
    if (chain.length > 0) target.blocks.push(chain);
  }
}

module.exports = { parseKittenN, convertNemoChain, convertNemoBlock, parseShadowXml };
