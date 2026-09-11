/**
 * Kitten4 / Kitten (.bcm4, .bcm, plain JSON) parser
 *
 * Input: project JSON with `theatre` and `compile_result`
 * Output: Unified IR project
 */

"use strict";

const {
  makeProject, makeTarget, makeVariable, makeBroadcast,
  makeBlock, makeExpr, makeValue,
} = require("./ir");
const { BLOCK_MAP } = require("./block_map");

/**
 * Convert a Kitten4 compile_result block chain to a flat IR chain.
 * Kitten4 blocks link via `next_block` (same level) and `child_block` (branches).
 */
function convertChain(kittenBlock, context) {
  const chain = [];
  let current = kittenBlock;
  let guard = 0;
  while (current && typeof current === "object" && guard < 10000) {
    guard++;
    const block = convertBlock(current, context);
    if (block) chain.push(block);
    current = current.next_block;
  }
  return chain;
}

function convertBlock(kittenBlock, context) {
  const type = kittenBlock.type;
  const mapping = BLOCK_MAP[type];

  if (!mapping) {
    // Unknown block: emit a comment placeholder
    return makeBlock("motion_setx", {
      inputs: { X: makeValue(0, "number") },
      meta: { kittenType: type, kittenId: kittenBlock.id, source: "kitten4", unsupported: true },
    });
  }

  const irBlock = makeBlock(mapping.opcode, {
    meta: { kittenType: type, kittenId: kittenBlock.id, source: "kitten4" },
  });

  // Handle conditions for `when` (conditional hat blocks)
  if (kittenBlock.conditions && Array.isArray(kittenBlock.conditions) && kittenBlock.conditions.length > 0) {
    // This is a `when` block with condition chain — convert first condition as input
    irBlock.inputs.CONDITION = makeExpr(convertBlock(kittenBlock.conditions[0], context));
  }

  // Convert params
  if (kittenBlock.params && typeof kittenBlock.params === "object" && !type.startsWith("procedures_")) {
    for (const [paramKey, paramValue] of Object.entries(kittenBlock.params)) {
      if (type.startsWith("procedures_") && (paramKey === "procedure_name" || paramKey === "procCode")) continue;
      if (mapping.dropParams && mapping.dropParams.includes(paramKey.toLowerCase())) continue;
      if (mapping.map && mapping.map[paramKey] !== undefined) continue; // handled via map below
      // params not explicitly mapped: try to resolve as expression or literal
      const resolved = resolveParam(paramValue, context);
      if (resolved !== undefined) {
        irBlock.inputs[paramKey.toUpperCase()] = resolved;
      }
    }
  }

  // Apply explicit mapping
  if (mapping.map) {
    for (const [scratchName, mapEntry] of Object.entries(mapping.map)) {
      if (!Array.isArray(mapEntry)) continue;
      const [kind, kittenKey] = mapEntry;
      if (kittenKey === null || kittenKey === undefined) {
        // special case: field value from mapping itself (e.g. STOP_OPTION for break)
        if (kind === "field") irBlock.fields[scratchName] = kittenKey;
        continue;
      }
      const paramValue = kittenBlock.params ? kittenBlock.params[kittenKey] : undefined;
      if (paramValue === undefined && kind !== "field") continue;
      switch (kind) {
        case "field":
          irBlock.fields[scratchName] = paramValue !== undefined ? paramValue : mapping.map[scratchName][1];
          break;
        case "num":
          irBlock.inputs[scratchName] = isBlockRef(paramValue)
            ? makeExpr(convertBlock(paramValue, context))
            : makeValue(Number(paramValue) || 0, "number");
          break;
        case "str":
          irBlock.inputs[scratchName] = isBlockRef(paramValue)
            ? makeExpr(convertBlock(paramValue, context))
            : makeValue(String(paramValue || ""), "string");
          break;
        case "bool":
          irBlock.inputs[scratchName] = isBlockRef(paramValue)
            ? makeExpr(convertBlock(paramValue, context))
            : makeValue(Boolean(paramValue), "bool");
          break;
        case "expr":
          if (isBlockRef(paramValue)) {
            irBlock.inputs[scratchName] = makeExpr(convertBlock(paramValue, context));
          }
          break;
      }
    }
  }

  // Handle `when` blocks: their condition comes from `conditions` array
  if (type === "when" && !irBlock.inputs.CONDITION && kittenBlock.params && kittenBlock.params.condition) {
    irBlock.inputs.CONDITION = makeExpr(convertBlock(kittenBlock.params.condition, context));
  }

  // Handle branches
  const branchKey = mapping.branch || "child_block";
  if (mapping.hat) {
    // Event hat blocks: the first-level children run as the hat's `next` chain,
    // not as a SUBSTACK branch.
    const hatChild = (kittenBlock.child_block || [])[0];
    if (Array.isArray(hatChild)) return irBlock; // defensive: nested array form
    if (hatChild && typeof hatChild === "object") {
      irBlock.__nextChain = convertChain(hatChild, context);
    }
    applySpecial(type, irBlock, kittenBlock, context);
    return irBlock;
  }
  const childBlocks = kittenBlock[branchKey];
  if (Array.isArray(childBlocks) && childBlocks.length > 0) {
    // child_block may be [chain] (compile_result) or a chain (block_data_json);
    // either way the first element is the head of a next_block-linked chain.
    if (childBlocks[0] && typeof childBlocks[0] === "object" && childBlocks[0].type) {
      irBlock.branches.push(convertChain(childBlocks[0], context));
    }
  }

  // Handle special cases
  if (mapping.special) {
    applySpecial(type, irBlock, kittenBlock, context);
  }

  return irBlock;
}

function isBlockRef(value) {
  return value && typeof value === "object" && value.type !== undefined;
}

function walkKittenBlocks(block, fn) {
  if (!block || typeof block !== "object") return;
  if (Array.isArray(block)) {
    for (const b of block) walkKittenBlocks(b, fn);
    return;
  }
  if (block.type) fn(block);
  for (const key of ["child_block", "next_block"]) {
    const value = block[key];
    if (Array.isArray(value)) value.forEach((b) => walkKittenBlocks(b, fn));
    else if (value && typeof value === "object") walkKittenBlocks(value, fn);
  }
}

function resolveParam(value, context) {
  if (isBlockRef(value)) {
    return makeExpr(convertBlock(value, context));
  }
  if (typeof value === "string" || typeof value === "number") {
    return makeValue(value, typeof value === "number" ? "number" : "string");
  }
  return undefined;
}

// ---- Special block handlers ----

function applySpecial(type, irBlock, kittenBlock, context) {
  const params = kittenBlock.params || {};

  // Normalize Kitten actor references to Scratch touching-menu values
  if (type === "bump" || type === "bump_into") {
    const normalize = (v) => v === "__mouse" || v === "__edge"
      ? ({ __mouse: "_mouse", __edge: "_edge" })[v]
      : context.__actorNameById && context.__actorNameById.get(v) || v;
    const sprite2 = (irBlock.fields.SPRITE2 !== undefined ? irBlock.fields.SPRITE2 : params.sprite2);
    delete irBlock.fields.TOUCHINGOBJECTMENU;
    delete irBlock.fields.SPRITE2;
    delete irBlock.inputs.TOUCHINGOBJECTMENU;
    delete irBlock.inputs.SPRITE2;
    irBlock.inputs.TOUCHINGOBJECTMENU = makeValue(normalize(sprite2), "string");
  }

  switch (type) {
    case "break": {
      irBlock.fields.STOP_OPTION = ["this script"];
      delete irBlock.inputs.STOP_OPTION;
      break;
    }
    case "math_arithmetic": {
      const op = params.type || params.OP;
      const scratchOp = { ADD: "+", MINUS: "-", MULTIPLY: "*", DIVIDE: "/", add: "+", minus: "-", multiply: "*", divide: "/" }[op] || "+";
      irBlock.opcode = {
        "+": "operator_add", "-": "operator_subtract",
        "*": "operator_multiply", "/": "operator_divide",
      }[scratchOp] || "operator_add";
      // Ensure A and B inputs
      if (params.A !== undefined && !irBlock.inputs.A) {
        irBlock.inputs.A = isBlockRef(params.A) ? makeExpr(convertBlock(params.A, context)) : makeValue(Number(params.A) || 0, "number");
      }
      if (params.B !== undefined && !irBlock.inputs.B) {
        irBlock.inputs.B = isBlockRef(params.B) ? makeExpr(convertBlock(params.B, context)) : makeValue(Number(params.B) || 0, "number");
      }
      // Scratch expects NUM1/NUM2 inputs; drop the nonstandard A/B/OP remnants.
      if (irBlock.inputs.A) { irBlock.inputs.NUM1 = irBlock.inputs.A; delete irBlock.inputs.A; }
      if (irBlock.inputs.B) { irBlock.inputs.NUM2 = irBlock.inputs.B; delete irBlock.inputs.B; }
      delete irBlock.fields.OP;
      delete irBlock.inputs.OP;
      break;
    }
    case "logic_compare": {
      const op = params.type || "EQ";
      const scratchOp = { GT: ">", LT: "<", EQ: "=", gt: ">", lt: "<", eq: "=", EQUAL: "=" }[op] || "=";
      irBlock.opcode = { ">": "operator_gt", "<": "operator_lt", "=": "operator_equals" }[scratchOp] || "operator_equals";
      if (params.A !== undefined && !irBlock.inputs.A) {
        irBlock.inputs.A = isBlockRef(params.A) ? makeExpr(convertBlock(params.A, context)) : makeValue(String(params.A), "string");
      }
      if (params.B !== undefined && !irBlock.inputs.B) {
        irBlock.inputs.B = isBlockRef(params.B) ? makeExpr(convertBlock(params.B, context)) : makeValue(String(params.B), "string");
      }
      if (irBlock.inputs.A) { irBlock.inputs.OPERAND1 = irBlock.inputs.A; delete irBlock.inputs.A; }
      if (irBlock.inputs.B) { irBlock.inputs.OPERAND2 = irBlock.inputs.B; delete irBlock.inputs.B; }
      delete irBlock.fields.OP;
      delete irBlock.inputs.OP;
      break;
    }
    case "logic_operation": {
      const op = params.type || "AND";
      irBlock.opcode = (op === "OR" || op === "or") ? "operator_or" : "operator_and";
      delete irBlock.fields.OP;
      delete irBlock.inputs.OP;
      break;
    }
    case "math_single":
    case "math_trig":
    case "math_round":
    case "math_arc_trig":
    case "math_function": {
      const opMap = {
        ROOT: "sqrt", "0": "sqrt", ABS: "abs", "1": "abs",
        NEG: "abs", "2": "abs", // negate is tricky
        LN: "ln", "3": "ln", LOG10: "log", "4": "log",
        EXP: "e ^", "5": "e ^", POW10: "10 ^", "6": "10 ^",
        SIN: "sin", sin: "sin", COS: "cos", cos: "cos", TAN: "tan", tan: "tan",
        ASIN: "asin", asin: "asin", ACOS: "acos", acos: "acos", ATAN: "atan", atan: "atan",
        ROUND: "round", round: "round",
        ROUNDDOWN: "floor", round_down: "floor", ROUNDUP: "ceiling", round_up: "ceiling",
      };
      const op = params.type || params.OP || "sqrt";
      irBlock.fields.OPERATOR = opMap[op] || "sqrt";
      if (params.A !== undefined && !irBlock.inputs.NUM) {
        irBlock.inputs.NUM = isBlockRef(params.A) ? makeExpr(convertBlock(params.A, context)) : makeValue(Number(params.A) || 0, "number");
        delete irBlock.inputs.A;
      }
      delete irBlock.fields.OPERATOR_SRC;
      delete irBlock.inputs.A;
      delete irBlock.inputs.OP;
      break;
    }
    case "variables_get":
    case "cloud_variables_get":
    case "script_variables_value": {
      irBlock.fields.VARIABLE = params.VAR || params.variable || params.valname || "<unknown>";
      break;
    }
    case "variables_set":
    case "cloud_variables_set": {
      irBlock.fields.VARIABLE = params.VAR || params.variable || params.valname || "<unknown>";
      if (params.value !== undefined && !irBlock.inputs.VALUE) {
        irBlock.inputs.VALUE = isBlockRef(params.value) ? makeExpr(convertBlock(params.value, context)) : makeValue(String(params.value), "string");
      }
      break;
    }
    case "change_variable":
    case "change_cloud_variable":
    case "change_variables": {
      delete irBlock.inputs.VALNAME;
      delete irBlock.inputs.METHOD;
      irBlock.fields.VARIABLE = params.VAR || params.valname || params.variable || "<unknown>";
      if (params.n !== undefined && !irBlock.inputs.VALUE) {
        irBlock.inputs.VALUE = isBlockRef(params.n) ? makeExpr(convertBlock(params.n, context)) : makeValue(String(params.n), "string");
      }
      if (params.value !== undefined && !irBlock.inputs.VALUE) {
        irBlock.inputs.VALUE = isBlockRef(params.value) ? makeExpr(convertBlock(params.value, context)) : makeValue(String(params.value), "string");
      }
      break;
    }
    case "list_get":
    case "list_item":
    case "lists_get_value":
    case "pure_list_get": {
      irBlock.fields.LIST = params.VAR || params.list || "<unknown>";
      if (params.INDEX !== undefined && !irBlock.inputs.INDEX) {
        irBlock.inputs.INDEX = isBlockRef(params.INDEX) ? makeExpr(convertBlock(params.INDEX, context)) : makeValue(Number(params.INDEX) || 1, "number");
      }
      break;
    }
    case "procedures_2_defnoreturn": {
      irBlock.mutation = null;
      irBlock.__procName = kittenBlock.procedure_name || kittenBlock.params.procCode || "function";
      break;
    }
    case "procedures_2_callnoreturn":
    case "procedures_2_return_value": {
      const procName = kittenBlock.procedure_name || params.procedure_name || "function";
      const procTable = context.procedures || (context.project && context.project.procedures);
      const procDef = procTable && procTable.get(procName);
      const paramNames = procDef ? procDef.paramNames : Object.keys(params);
      const callProccode = procName + paramNames.map(() => " %s").join("");
      irBlock.mutation = {
        tagName: "mutation",
        children: [],
        proccode: callProccode,
        argumentids: JSON.stringify(paramNames.map((_, i) => `arg${i}`)),
        warp: "false",
      };
      // Convert each argument value in declaration order into a call input.
      paramNames.forEach((pn, i) => {
        const v = params[pn];
        const irInput = isBlockRef(v) ? makeExpr(convertBlock(v, context)) : makeValue(String(v ?? ""), "string");
        irBlock.inputs[`arg${i}`] = irInput;
      });
      break;
    }
    case "procedures_2_parameter":
    case "procedures_2_actor_param":
    case "procedures_2_stable_parameter": {
      irBlock.fields.VALUE = kittenBlock.params.param_name || kittenBlock.params.name || "";
      break;
    }
    case "show_hide_variable": {
      // Kitten show/hide variable -> Scratch data_showvariable/data_hidevariable
      irBlock.opcode = params.FUNC === "hide" ? "data_hidevariable" : "data_showvariable";
      delete irBlock.inputs.FUNC;
      delete irBlock.inputs.VAR;
      irBlock.fields.VARIABLE = params.VAR || "<unknown>";
      break;
    }
    case "switch_screen": {
      irBlock.fields.BROADCAST_OPTION = params.scene || params.screen || "";
      break;
    }
    case "broadcast_input": {
      irBlock.fields.BROADCAST_OPTION = params.message || params.msg || params.broadcast || "";
      break;
    }
    case "self_change_coordinate": {
      delete irBlock.inputs.VALUE; delete irBlock.inputs.INCREASE; delete irBlock.inputs.COORDINARY;
      const coord = params.coordinary || params.coord || "y";
      const valueInput = isBlockRef(params.value) ? makeExpr(convertBlock(params.value, context)) : makeValue(Number(params.value) || 0, "number");
      if (coord === "x") {
        irBlock.opcode = params.increase === "set" ? "motion_setx" : "motion_changexby";
        irBlock.inputs.DX = valueInput;
      } else {
        irBlock.opcode = params.increase === "set" ? "motion_sety" : "motion_changeyby";
        irBlock.inputs.DY = valueInput;
      }
      break;
    }
    case "set_theatre_layer": {
      // Kitten layer values: "peak" (front-most) and "base"/"bottom" (back-most)
      irBlock.fields.LAYER = params.layer === "peak" ? "front" : "back";
      delete irBlock.inputs.LAYER;
      break;
    }
    case "warp": {
      // Kitten "warp" is a scratch-2 style no-op wrapper; keep the children
      // running after it via the next chain.
      const warpChild = (kittenBlock.child_block || [])[0];
      irBlock.branches = [];
      if (warpChild && typeof warpChild === "object") {
        irBlock.__nextChain = convertChain(warpChild, context);
      }
      break;
    }
    case "move_forward": {
      if (params.steps !== undefined && !irBlock.inputs.STEPS) {
        irBlock.inputs.STEPS = isBlockRef(params.steps) ? makeExpr(convertBlock(params.steps, context)) : makeValue(Number(params.steps) || 0, "number");
      }
      break;
    }
    case "costume": {
      const direction = params.prev_or_next || params.prev_or_next_style;
      if (direction === "prev") {
        irBlock.opcode = "looks_prevcostume"; // TurboWarp extension
      }
      break;
      }
    case "create_stage_dialog": {
      irBlock.opcode = "looks_say";
      delete irBlock.inputs.TEXT;
      delete irBlock.inputs.ACTOR;
      delete irBlock.inputs.MESSAGE;
      const textParam = params.message !== undefined ? params.message : params.text;
      irBlock.inputs.MESSAGE = isBlockRef(textParam)
        ? makeExpr(convertBlock(textParam, context))
        : makeValue(String(textParam ?? ""), "string");
      break;
    }
    case "stop": {
      const scope = String(params.scope ?? "0");
      const option = scope === "0" ? "this script" : scope === "2" ? "other scripts in sprite" : "all";
      irBlock.fields.STOP_OPTION = [option];
      delete irBlock.inputs.SCOPE;
      break;
    }
    case "self_rotate_around": {
      // Kitten rotates around a point; Scratch turns the sprite itself.
      irBlock.opcode = "motion_turnright";
      break;
    }
    case "controls_if": {
      // block_data_json gives us DO0/ELSE statement chains via __extraStatements
      if (kittenBlock.__extraStatements) {
        const elseStmt = kittenBlock.__extraStatements.find(s => s.name === "ELSE");
        if (elseStmt && elseStmt.chain && elseStmt.chain.length > 0) {
          irBlock.branches[1] = elseStmt.chain;
        }
        const doStmt = kittenBlock.__extraStatements.find(s => s.name === "DO0");
        if (doStmt && doStmt.chain && doStmt.chain.length > 0) {
          irBlock.branches[0] = doStmt.chain;
        }
      }
      break;
    }
    case "arithmetic":
    case "math_arithmetic": {
      const op2 = params.type || params.OP;
      const scratchOp2 = { ADD: "+", MINUS: "-", MULTIPLY: "*", DIVIDE: "/", add: "+", minus: "-", multiply: "*", divide: "/" }[op2] || "+";
      irBlock.opcode = { "+": "operator_add", "-": "operator_subtract", "*": "operator_multiply", "/": "operator_divide" }[scratchOp2] || "operator_add";
      if (irBlock.inputs.A) { irBlock.inputs.NUM1 = irBlock.inputs.A; delete irBlock.inputs.A; }
      if (irBlock.inputs.B) { irBlock.inputs.NUM2 = irBlock.inputs.B; delete irBlock.inputs.B; }
      delete irBlock.fields.OP;
      delete irBlock.inputs.OP;
      break;
    }
  }
}

// ---- Project-level parsing ----

function costumeFromStyle(styleInfo, defaultName) {
  if (!styleInfo) return null;
  const url = styleInfo.url || styleInfo.cdn_url || "";
  let dataFormat = "svg";
  let inlineData = null;
  let sourceFile = null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) {
      const mime = m[1];
      dataFormat = mime.includes("svg") ? "svg" : mime.includes("png") ? "png" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
      inlineData = Buffer.from(m[2], "base64");
    }
  } else if (url) {
    sourceFile = url.split("/").pop();
    const ext = (sourceFile.split(".").pop() || "").toLowerCase();
    dataFormat = ext === "svg" ? "svg" : ext === "png" ? "png" : (ext === "jpg" || ext === "jpeg") ? "jpg" : ext === "mp3" ? "mp3" : ext === "wav" ? "wav" : "svg";
  }
  const center = styleInfo.rotate_center || styleInfo.pivot || { x: 0, y: 0 };
  return {
    name: styleInfo.name || "costume",
    sourceFile,
    dataFormat,
    rotationCenterX: center.x || 0,
    rotationCenterY: center.y || 0,
    bitmapResolution: 1,
    __data: inlineData,
  };
}

function parseKitten4(projectJson) {
  const project = makeProject(projectJson.project_name || "Kitten Project", {
    sourceFormat: "kitten4",
    sourceFile: projectJson.__sourceFile || null,
  });

  // Variables
  const variables = projectJson.variables || {};
  for (const [varId, varInfo] of Object.entries(variables)) {
    const isCloud = projectJson.cloud_variables && projectJson.cloud_variables[varId];
    const varData = isCloud || varInfo;
    const name = varData.name || varId;
    const value = varData.value !== undefined ? varData.value : "";
    const isList = Array.isArray(varData.value) || varData.type === "list";
    const cloud = isCloud !== undefined && isCloud !== null && typeof isCloud === "object";
    project.variables.push(makeVariable(varId, name, value, cloud, isList, true));
  }

  // Cloud variables (merge into project.variables)
  const cloudVariables = projectJson.cloud_variables || {};
  for (const [cvId, cvInfo] of Object.entries(cloudVariables)) {
    if (typeof cvInfo !== "object" || cvInfo === null) continue;
    const isList = cvInfo.type === "public_list" || cvInfo.type === "private_list";
    project.variables.push(makeVariable(cvId, cvInfo.name || cvId, isList ? [] : "", true, isList, true));
  }

  // Broadcasts
  const broadcasts = projectJson.broadcasts || {};
  const seenBcNames = new Set();
  for (const [bcId, bcValue] of Object.entries(broadcasts)) {
    const names = Array.isArray(bcValue) ? bcValue : [bcValue];
    for (const name of names) {
      if (typeof name === "string" && name && !seenBcNames.has(name) && bcId !== "toJSON") {
        seenBcNames.add(name);
        project.broadcasts.push(makeBroadcast(bcId, name));
      }
    }
  }

  const theatre = projectJson.theatre || {};
  const scenes = theatre.scenes || {};
  const actors = theatre.actors || {};

  // Stage (first scene as stage, subsequent scenes become sprites with special naming)
  const sceneIds = Object.keys(scenes);
  const stageSceneId = theatre.current_scene || sceneIds[0];
  const stageScene = scenes[stageSceneId];

  const stage = makeTarget("Stage", true);
  if (stageScene) {
    stage.name = stageScene.name || "Stage";
    const theatreStyles = theatre.styles || {};
    const styleInfo = theatreStyles[stageScene.current_style_id || (stageScene.styles || [])[0]];
    const stageCostume = costumeFromStyle(styleInfo, "backdrop1");
    if (stageCostume) {
      stage.costumes.push(stageCostume);
    }
    project.stage = stage;
  }

  // Actors -> Sprites
  let layerOrder = 1;
  for (const [actorId, actor] of Object.entries(actors)) {
    const sprite = makeTarget(actor.name || actorId, false);
    sprite.__actorId = actorId;
    sprite.x = actor.x || 0;
    sprite.y = actor.y || 0;
    sprite.size = actor.scale || 100;
    sprite.visible = actor.visible !== false;
    sprite.layerOrder = layerOrder++;

    // Styles -> costumes (use real asset data from theatre.styles)
    const theatreStyles = theatre.styles || {};
    const styleIds = actor.styles || [];
    for (const styleId of styleIds) {
      const styleInfo = theatreStyles[styleId];
      if (!styleInfo) continue;
      const costume = costumeFromStyle(styleInfo, styleId);
      if (costume) sprite.costumes.push(costume);
    }

    project.sprites.push(sprite);
  }

  // compile_result -> block scripts
  const compileResult = projectJson.compile_result || [];
  const entityMap = new Map();
  for (const entity of compileResult) {
    entityMap.set(entity.id, entity);
  }
  const blockDataGraph = require("./block_data_graph");
  const actorBlockData = {};
  const actorNameById = new Map();
  for (const [actorId, actor] of Object.entries(actors)) {
    actorNameById.set(actorId, actor.name || actorId);
  }
  for (const [actorId, actor] of Object.entries(actors)) {
    if (actor.block_data_json && actor.block_data_json.blocks) {
      const chains = blockDataGraph.blockDataJsonToChains(actor.block_data_json);
      actorBlockData[actorId] = chains.map(chain => ({ compiled_block_map: { root: chain } }));
    }
  }

  // Register procedure definitions per sprite (before converting scripts, so
  // calls can resolve their proc's argument metadata). Kitten4 stores defs in
  // entity.procedures, keyed by procedure name.
  for (const sprite of project.sprites) {
    const entity = entityMap.get(sprite.__actorId);
    if (!entity || !entity.procedures) continue;
    for (const [rootId, rootBlock] of Object.entries(entity.procedures || {})) {
      if (!rootBlock || rootBlock.type !== "procedures_2_defnoreturn") continue;
      const paramNames = Object.keys(rootBlock.params || {});
      const procId = rootBlock.procedure_name || rootBlock.id || `proc_${rootId}`;
      const bodyChain = convertChain((rootBlock.child_block || [])[0], { project, target: sprite });
      sprite.__procedures = sprite.__procedures || new Map();
      sprite.__procedures.set(procId, {
        id: procId,
        name: rootBlock.procedure_name || "function",
        paramNames,
        mutation: {
          tagName: "mutation",
          children: [],
        proccode: (rootBlock.procedure_name || "function") + paramNames.map(() => " %s").join(""),
          argumentids: JSON.stringify(paramNames.map((_, i) => `arg${i}`)),
          argumentnames: JSON.stringify(paramNames),
          argumentdefaults: JSON.stringify(paramNames.map(() => "")),
          warp: "false",
        },
        __bodyChain: bodyChain,
      });
      // Also expose sprite-local procedures project-wide: Kitten allows
      // calling another actor's procedure, and Scratch stores all proc defs
      // on the Stage.
      if (!project.procedures.has(procId)) project.procedures.set(procId, sprite.__procedures.get(procId));
    }
  }

  // Register procedure definitions for the stage entity too
  const stageEntityForProcs = stageSceneId ? entityMap.get(stageSceneId) : null;
  if (stageEntityForProcs && stageEntityForProcs.procedures) {
    for (const [rootId, rootBlock] of Object.entries(stageEntityForProcs.procedures || {})) {
      if (!rootBlock || rootBlock.type !== "procedures_2_defnoreturn") continue;
      const paramNames = Object.keys(rootBlock.params || {});
      const procId = rootBlock.procedure_name || rootBlock.id || `proc_${rootId}`;
      project.procedures.set(procId, {
        id: procId,
        name: rootBlock.procedure_name || "function",
        paramNames,
        mutation: {
          tagName: "mutation",
          children: [],
          proccode: (rootBlock.procedure_name || "function") + paramNames.map(() => " %s").join(""),
          argumentids: JSON.stringify(paramNames.map((_, i) => `arg${i}`)),
          argumentnames: JSON.stringify(paramNames),
          argumentdefaults: JSON.stringify(paramNames.map(() => "")),
          warp: "false",
        },
      });
    }
  }

  // Attach scene scripts to stage
  const stageEntity = entityMap.get(stageSceneId);
  if (stageEntity) {
    for (const [rootId, rootBlock] of Object.entries(stageEntity.compiled_block_map || {})) {
      const chain = convertChain(rootBlock, { project, target: stage });
      if (chain.length > 0) stage.blocks.push(chain);
    }
  }

  // Attach actor scripts to sprites
  for (const sprite of project.sprites) {
    let entities = [];
    if (entityMap.get(sprite.__actorId)) {
      entities = [entityMap.get(sprite.__actorId)];
    } else if (actorBlockData[sprite.__actorId]) {
      entities = actorBlockData[sprite.__actorId];
    }
    if (entities) {
      for (const entity of entities) {
        for (const [rootId, rootBlock] of Object.entries(entity.compiled_block_map || {})) {
        const chain = convertChain(rootBlock, { project, target: sprite, procedures: sprite.__procedures, __actorNameById: actorNameById });
        if (chain.length > 0) sprite.blocks.push(chain);
        }
      }
    }
  }

  project.__assetFiles = global.__k2s_assetFiles || null;
  return project;
}

module.exports = { parseKitten4, convertChain, convertBlock };
