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
  addSpriteInitialization, addSceneVisibilityHandlers,
} = require("./ir");
const { BLOCK_MAP } = require("./block_map");
const { addSceneBackdrops } = require("./scene_backdrops");

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

function readDict(value, key) {
  if (!value || typeof value !== "object") return {};
  return value[key] && typeof value[key] === "object" ? value[key] : value;
}

function valueOfField(fields, ...keys) {
  for (const key of keys) {
    if (fields && fields[key] !== undefined) return fields[key];
  }
  return undefined;
}

function listId(value) {
  if (value && typeof value === "object") {
    return valueOfField(value.fields, "list", "LIST", "variable", "VAR") || valueOfField(value.params, "list", "LIST", "variable", "VAR");
  }
  return value;
}

function makeUnsupported(type, id) {
  return makeBlock("control_wait", {
    inputs: { DURATION: makeValue(0, "number") },
    meta: { kittenType: type, kittenId: id, source: "kittenn", unsupported: true },
  });
}

function sceneActivationRoot(root, backdrop, active) {
  if (active || !root) return root;
  if (["on_running_group_activated", "start_on_click"].includes(root.type)) {
    return { ...root, type: "backdrop_on_change", fields: { ...(root.fields || {}), backdrop } };
  }
  return root;
}

function sceneGuardChain(chain, backdrop, active) {
  if (active || !chain.length) return chain;
  const first = chain[0];
  if (!first || first.opcode === "event_whenbackdropswitchesto") return chain;
  if (!first.opcode.startsWith("event_")) return chain;
  const body = chain.slice(1);
  if (!body.length) return chain;
  const guard = makeBlock("control_if", {
    inputs: {
      CONDITION: makeExpr(makeBlock("operator_equals", {
        inputs: {
          OPERAND1: makeExpr(makeBlock("looks_backdropnumbername", { inputs: { NUMBER_NAME: makeValue("name", "string") } })),
          OPERAND2: makeValue(backdrop, "string"),
        },
      })),
    },
    branches: [body],
  });
  first.branches = [...(first.branches || []), [guard]];
  return [first];
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
    return makeUnsupported(type, nemoBlock.id);
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

  // KittenN stores C-block bodies in `statements`, not in `inputs`.
  const statements = nemoBlock.statements || {};
  if (type === "controls_if" || type === "controls_if_no_else" || type === "control_if_else") {
    const conditionKeys = Object.keys(inputs).filter((key) => /^IF\d+$/i.test(key));
    if (conditionKeys.length && !irBlock.inputs.CONDITION) {
      irBlock.inputs.CONDITION = makeExpr(convertNemoBlock(inputs[conditionKeys[0]], context));
    }
    const body = statements.DO0 || statements.DO || statements.SUBSTACK;
    const alternate = statements.ELSE || statements.ELSE0 || statements.SUBSTACK2;
    if (body) irBlock.branches.push(convertNemoChain(body, context));
    if (alternate) irBlock.branches.push(convertNemoChain(alternate, context));
  } else if (["repeat_forever", "repeat_n_times", "repeat_forever_until", "warp", "traverse_number"].includes(type)) {
    const body = statements.DO || statements.DO0 || statements.STACK;
    if (body) irBlock.branches.push(convertNemoChain(body, context));
  } else if (type === "procedures_2_defnoreturn") {
    const body = statements.STACK || statements.DO;
    if (body) irBlock.branches.push(convertNemoChain(body, context));
  }

  // Special handlers (shared logic with Kitten4)
  if (mapping.special) {
    applyNemoSpecial(type, irBlock, nemoBlock, context);
  }

  return irBlock;
}

function findMapKey(map, kittenKey) {
  if (!map) return null;
  for (const [scratchName, entry] of Object.entries(map)) {
    if (!Array.isArray(entry)) continue;
    const [kind, key] = entry;
    if (key === kittenKey) return [scratchName, kind];
  }
  return null;
}

function applyNemoSpecial(type, irBlock, nemoBlock, context) {
  const fields = nemoBlock.fields || {};
  const inputs = nemoBlock.inputs || {};

  switch (type) {
    case "backdrop_on_change": {
      irBlock.fields.BACKDROP = fields.backdrop || fields.BACKDROP || context.sceneBackdrop || "";
      break;
    }
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
    case "text_join": {
      // KittenN names the two join slots ADD0/ADD1 in some exports, while
      // other versions use TEXT1/TEXT2. Normalize both forms to Scratch's
      // STRING1/STRING2 inputs so TurboWarp does not drop the operands.
      const toInput = (value) => {
        if (value && typeof value === "object" && value.type) {
          return makeExpr(convertNemoBlock(value, context));
        }
        return makeValue(String(value ?? ""), "string");
      };
      const left = inputs.ADD0 || inputs.TEXT1 || inputs.STRING1 || inputs.A;
      const right = inputs.ADD1 || inputs.TEXT2 || inputs.STRING2 || inputs.B;
      if (left !== undefined) irBlock.inputs.STRING1 = toInput(left);
      if (right !== undefined) irBlock.inputs.STRING2 = toInput(right);
      for (const key of ["ADD0", "ADD1", "TEXT1", "TEXT2", "A", "B"]) {
        if (key !== "STRING1" && key !== "STRING2") delete irBlock.inputs[key];
      }
      break;
    }
    case "check_key": {
      irBlock.inputs.KEY_OPTION = makeValue(String(fields.key ?? fields.KEY_OPTION ?? ""), "string");
      delete irBlock.fields.KEY_OPTION;
      delete irBlock.fields.TYPE;
      break;
    }
    case "self_text_effect_color": {
      irBlock.fields.EFFECT = "color";
      const color = inputs.color || fields.color || fields.COLOR;
      if (color && typeof color === "object" && color.type) {
        irBlock.inputs.VALUE = makeExpr(convertNemoBlock(color, context));
      } else {
        irBlock.inputs.VALUE = makeValue(String(color || "#ffffff"), "string");
      }
      delete irBlock.fields.COLOR;
      delete irBlock.fields.VALUE;
      break;
    }
    case "bump_into":
    case "bump": {
      const sprite = fields.sprite1 || fields.SPRITE1 || fields.sprite || fields.SPRITE || "--mouse";
      irBlock.inputs.TOUCHINGOBJECTMENU = makeValue(
        sprite === "--mouse" ? "_mouse_" : sprite === "--edge" ? "_edge_" : String(sprite),
        "string",
      );
      delete irBlock.fields.SPRITE;
      delete irBlock.fields.SPRITE1;
      break;
    }
    case "mirror": {
      irBlock.inputs.DEGREES = makeValue(180, "number");
      delete irBlock.fields.SPRITE;
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
    case "variable_get":
    case "variable_set":
    case "variable_change": {
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
    case "list_get":
    case "list_item":
    case "pure_list_get": {
      irBlock.fields.LIST = listId(inputs.list || fields.list || fields.LIST);
      const index = inputs.list_index || inputs.INDEX || inputs.index;
      if (index) irBlock.inputs.INDEX = makeExpr(convertNemoBlock(index, context));
      delete irBlock.inputs.LIST;
      break;
    }
    case "self_listen":
    case "broadcast_input": {
      const message = inputs.message || inputs.MESSAGE || fields.message || fields.MESSAGE;
      const messageFields = message && message.fields;
      irBlock.fields.BROADCAST_OPTION = valueOfField(messageFields, "message", "MESSAGE") || message || "";
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "self_broadcast":
    case "self_broadcast_and_wait": {
      const message = inputs.message || inputs.MESSAGE || fields.message || fields.MESSAGE;
      const messageFields = message && message.fields;
      const name = valueOfField(messageFields, "message", "MESSAGE") || message || "";
      irBlock.inputs.BROADCAST_INPUT = makeValue(String(name), "string");
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "variable_change": {
      irBlock.fields.VARIABLE = fields.variable || fields.VAR || "<unknown>";
      irBlock.inputs.VALUE ||= makeValue(1, "number");
      break;
    }
    case "restart": {
      irBlock.fields.STOP_OPTION = "this script";
      break;
    }
    case "gradually_show_hide": {
      irBlock.opcode = String(fields.show_hide || "show") === "hide" ? "looks_hide" : "looks_show";
      break;
    }
    case "glide_coordinate_y": {
      const time = inputs.time ? convertNemoBlock(inputs.time, context) : makeBlock("math_number");
      const value = inputs.value ? convertNemoBlock(inputs.value, context) : makeBlock("math_number");
      irBlock.inputs.SECS = makeExpr(time);
      irBlock.inputs.X = makeExpr(makeBlock("motion_xposition"));
      irBlock.inputs.Y = makeExpr(value);
      break;
    }
    case "traverse_number": {
      const from = inputs.from ? convertNemoBlock(inputs.from, context) : makeBlock("math_number");
      const to = inputs.to ? convertNemoBlock(inputs.to, context) : makeBlock("math_number");
      irBlock.opcode = "control_repeat";
      irBlock.inputs.TIMES = makeExpr(makeBlock("operator_add", {
        inputs: { NUM1: makeExpr(to), NUM2: makeExpr(makeBlock("operator_subtract", { inputs: { NUM1: makeExpr(from), NUM2: makeValue(1, "number") } })) },
      }));
      break;
    }
    case "traverse_number_param":
    case "traverse_number_value": {
      const name = fields.TEXT || fields.text || fields.name || fields.variable || "i";
      irBlock.fields.VARIABLE = String(name);
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
      const proccode = fields.procCode || fields.PROCCODE || fields.NAME || "function";
      irBlock.mutation = { tagName: "mutation", proccode, procCode: proccode, argumentids: JSON.stringify([]), warp: "false" };
      break;
    }
    case "procedures_2_callreturn":
    case "procedures_2_return_value": {
      const proccode = fields.procCode || fields.PROCCODE || fields.NAME || "function";
      irBlock.mutation = { tagName: "mutation", proccode, procCode: proccode, argumentids: JSON.stringify([]), warp: "false" };
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
    framerate: Number(decryptedJson.framerate || decryptedJson.fps) || 60,
  });

  const variablesData = readDict(decryptedJson.variables, "variablesDict");
  const broadcastsData = readDict(decryptedJson.broadcasts, "broadcastsDict");
  const stylesData = readDict(decryptedJson.styles, "stylesDict");
  const scenesData = decryptedJson.scenes || {};
  const scenesDict = readDict(scenesData, "scenesDict");
  const actorsData = readDict(decryptedJson.actors, "actorsDict");
  const sceneIds = Array.isArray(scenesData.sortList) ? scenesData.sortList : Object.keys(scenesDict);
  const currentSceneId = scenesData.currentSceneId || sceneIds[0];

  const variableNameById = new Map();
  for (const [id, value] of Object.entries(variablesData)) {
    const info = value && typeof value === "object" ? value : { value };
    const name = info.name || id;
    variableNameById.set(String(id), name);
    project.variables.push(makeVariable(
      id,
      name,
      info.value !== undefined ? info.value : "",
      Boolean(info.isCloud || info.cloud),
      Array.isArray(info.value) || info.type === "list",
      info.isGlobal !== false,
    ));
  }

  const broadcastNameById = new Map();
  for (const [id, value] of Object.entries(broadcastsData)) {
    const names = Array.isArray(value) ? value : [value];
    for (const name of names) {
      if (typeof name !== "string" || !name || id === "toJSON") continue;
      broadcastNameById.set(String(id), name);
      if (!project.broadcasts.some((broadcast) => broadcast.id === id && broadcast.name === name)) {
        project.broadcasts.push(makeBroadcast(id, name));
      }
    }
  }

  function makeNemoCostume(styleId, fallbackName) {
    const style = styleId && styleId.url ? styleId : stylesData[styleId];
    if (!style) return null;
    const url = style.url || style.cdn_url || "";
    const format = /\.png(?:[?#]|$)/i.test(url) ? "png" : /\.(?:jpg|jpeg)(?:[?#]|$)/i.test(url) ? "jpg" : "svg";
    const center = style.centerPoint || style.rotate_center || style.pivot || { x: 0, y: 0 };
    return {
      name: style.name || fallbackName || styleId,
      sourceFile: url || null,
      dataFormat: format,
      rotationCenterX: Number(center.x || 0),
      rotationCenterY: Number(center.y || 0),
      bitmapResolution: 1,
      md5ext: null,
    };
  }

  const stageScene = scenesDict[currentSceneId];
  const stage = makeTarget("Stage", true);
  stage.name = stageScene?.name || "Stage";
  project.meta.stageWidth = Number(decryptedJson.stageSize?.width) || 480;
  project.meta.stageHeight = Number(decryptedJson.stageSize?.height) || 360;
  project.meta.scaleX = 1;
  project.meta.scaleY = 1;
  const sceneBackdropData = addSceneBackdrops(stage, {
    scenes: Object.fromEntries(Object.entries(scenesDict).map(([id, scene]) => [id, {
      ...scene,
      current_style_id: scene.currentStyleId,
      styles: scene.styles,
    }])),
    sceneIds,
    currentSceneId,
    styles: stylesData,
    makeCostume: (style, styleId) => makeNemoCostume(style, styleId),
  });
  project.stage = stage;

  const actorSceneById = new Map();
  for (const [sceneId, scene] of Object.entries(scenesDict)) {
    for (const actorId of scene.actorIds || []) actorSceneById.set(String(actorId), sceneId);
  }
  let layerOrder = 1;
  const usedNames = new Set();
  for (const [actorId, actor] of Object.entries(actorsData)) {
    const sprite = makeTarget(actor.name || actorId, false);
    sprite.__actorId = actorId;
    while (usedNames.has(sprite.name)) sprite.name = `${sprite.name} (2)`;
    usedNames.add(sprite.name);
    sprite.__sceneId = actorSceneById.get(String(actorId)) || actor.sceneId || actor.scene || currentSceneId;
    sprite.__sceneVisible = actor.visible !== false;
    sprite.x = Number(actor.position?.x) || 0;
    sprite.y = Number(actor.position?.y) || 0;
    sprite.size = Number(actor.scale) || 100;
    sprite.direction = 90 - Number(actor.rotation || 0) * 180 / Math.PI;
    sprite.visible = sprite.__sceneVisible && sprite.__sceneId === currentSceneId;
    sprite.layerOrder = layerOrder++;
    for (const styleId of actor.styles || []) {
      const costume = makeNemoCostume(styleId, styleId);
      if (costume) sprite.costumes.push(costume);
    }
    sprite.currentCostume = Math.max(0, (actor.styles || []).indexOf(actor.currentStyleId));
    project.sprites.push(sprite);
    attachNemoScripts(actor, sprite, {
      project, target: sprite, variableNameById, broadcastNameById,
      sceneBackdrop: sceneBackdropData.sceneBackdropById.get(String(sprite.__sceneId)),
      activeScene: sprite.__sceneId === currentSceneId,
    });
    addSpriteInitialization(sprite);
    addSceneVisibilityHandlers(
      sprite,
      sceneBackdropData.sceneBackdropById.get(String(sprite.__sceneId)),
      sceneBackdropData.sceneBackdropNames,
      sprite.__sceneVisible,
    );
  }

  // Stage scripts belong to the scene entity, but all scene backdrops live on
  // the one Scratch stage. Inactive scene roots wait for their backdrop.
  if (stageScene) {
    attachNemoScripts(stageScene, stage, {
      project, target: stage, variableNameById, broadcastNameById,
      sceneBackdrop: sceneBackdropData.sceneBackdropById.get(String(currentSceneId)),
      activeScene: true,
    });
  }

  for (const sceneId of sceneIds) {
    if (sceneId === currentSceneId) continue;
    const scene = scenesDict[sceneId];
    if (!scene) continue;
    attachNemoScripts(scene, stage, {
      project, target: stage, variableNameById, broadcastNameById,
      sceneBackdrop: sceneBackdropData.sceneBackdropById.get(String(sceneId)),
      activeScene: false,
    });
  }

  return project;
}

function attachNemoScripts(entity, target, context) {
  const blockList = entity.nekoBlockJsonList || [];
  for (const rootBlock of blockList) {
    const root = sceneActivationRoot(rootBlock, context.sceneBackdrop, context.activeScene !== false);
    const chain = convertNemoChain(root, context);
    if (chain.length > 0) target.blocks.push(chain);
  }
}

module.exports = { parseKittenN, convertNemoChain, convertNemoBlock, parseShadowXml, sceneGuardChain };
