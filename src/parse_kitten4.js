/**
 * Kitten4 / Kitten (.bcm4, .bcm, plain JSON) parser
 *
 * Input: project JSON with `theatre` and `compile_result`
 * Output: Unified IR project
 */

"use strict";

const {
  makeProject, makeTarget, makeVariable, makeBroadcast,
  makeBlock, makeExpr, makeValue, addSpriteInitialization,
  addSceneVisibilityHandlers,
} = require("./ir");
const { BLOCK_MAP } = require("./block_map");
const { addSceneBackdrops } = require("./scene_backdrops");

/**
 * Convert a Kitten4 compile_result block chain to a flat IR chain.
 * Kitten4 blocks link via `next_block` (same level) and `child_block` (branches).
 */
function convertChain(kittenBlock, context) {
  const chain = [];
  let current = kittenBlock;
  const seen = new Set();
  let guard = 0;
  while (current && typeof current === "object" && guard < 10000) {
    guard++;
    if (seen.has(current.id)) break;
    if (current.id) seen.add(current.id);
    const block = convertBlock(current, context);
    if (block?.__replacementChain) chain.push(...block.__replacementChain);
    else if (block) chain.push(block);
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
    meta: { kittenType: type, kittenId: kittenBlock.id, source: context.source || "kitten4", unsupported: true },
    });
  }

  const irBlock = makeBlock(mapping.opcode, {
    meta: { kittenType: type, kittenId: kittenBlock.id, source: context.source || "kitten4" },
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

function broadcastName(value) {
  if (isBlockRef(value)) {
    const params = value.params || {};
    return broadcastName(
      params.MESSAGE ?? params.message ?? params.msg ?? params.broadcast ??
      params.TEXT ?? params.text ?? value.value,
    );
  }
  if (value && typeof value === "object" && value.value !== undefined) return broadcastName(value.value);
  return value;
}

function listName(value) {
  if (isBlockRef(value)) {
    const params = value.params || {};
    return params.VAR ?? params.variable ?? params.list ?? params.LIST ?? "";
  }
  return value;
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

function numericInput(value, context) {
  if (isBlockRef(value)) return makeExpr(convertBlock(value, context));
  const number = Number(value);
  return makeValue(Number.isFinite(number) ? number : 0, "number");
}

function expr(opcode, inputs = {}, fields = {}) {
  return makeExpr(makeBlock(opcode, { inputs, fields }));
}

function valueExpr(value) {
  return value && (value.type === "expr" || value.type === "value")
    ? value : makeValue(value, "number");
}

function binary(opcode, left, right) {
  return expr(opcode, { NUM1: valueExpr(left), NUM2: valueExpr(right) });
}

function negate(input) {
  return binary("operator_subtract", makeValue(0, "number"), input);
}

function scratchRotationStyle(rotationType) {
  return ({ 0: "all around", 1: "left-right", 2: "don't rotate" })[Number(rotationType)] || "all around";
}

function uniqueSceneSpriteName(value, used) {
  const base = String(value || "Sprite");
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} (${suffix++})`;
  used.add(name);
  return name;
}

function sceneBackdropInput(value, context) {
  if (isBlockRef(value)) return makeExpr(convertBlock(value, context));
  const raw = String(value ?? "");
  const backdrop = context.__sceneBackdropById?.get(raw) || context.__sceneBackdropByName?.get(raw) || raw;
  return makeValue(backdrop, "string");
}

function sceneActivationRoot(rootBlock, sceneId, active) {
  if (active || !rootBlock || rootBlock.type !== "start_on_click") return rootBlock;
  return { ...rootBlock, type: "backdrop_on_change", params: { ...(rootBlock.params || {}), scene: sceneId } };
}

function orbitVariable(context, suffix) {
  const target = context.target;
  if (!target) return null;
  context.__orbitVars ||= {};
  const key = `${target.name}:${suffix}`;
  if (!context.__orbitVars[key]) {
    const id = `__k2s_orbit_${target.name}_${suffix}`;
    const name = `__k2s_orbit_${suffix}`;
    const existing = target.variables.find((variable) => variable.id === id);
    if (!existing) target.variables.push(makeVariable(id, name, 0, false, false, false));
    context.__orbitVars[key] = { id, name };
  }
  return context.__orbitVars[key];
}

function variableGet(variable) {
  return expr("data_variable", {}, { VARIABLE: variable.id });
}

function targetReporter(context, targetName, property) {
  const currentName = context.target?.name;
  if (!targetName || targetName === "__self" || targetName === currentName) {
    return expr(property === "x" ? "motion_xposition" : "motion_yposition");
  }
  return expr("sensing_of", { OBJECT: makeValue(targetName, "string") }, {
    PROPERTY: property === "x" ? "x position" : "y position",
  });
}

function buildOrbitChain(kittenBlock, context, angleInput) {
  const params = kittenBlock.params || {};
  const targetRaw = params.sprite ?? params.target ?? params.actor ?? "__self";
  const targetName = context.__actorNameById?.get(String(targetRaw)) || String(targetRaw);
  const xVar = orbitVariable(context, "x");
  const yVar = orbitVariable(context, "y");
  if (!xVar || !yVar) return null;

  const centerX = targetReporter(context, targetName, "x");
  const centerY = targetReporter(context, targetName, "y");
  const savedX = variableGet(xVar);
  const savedY = variableGet(yVar);
  const dx = binary("operator_subtract", savedX, centerX);
  const dy = binary("operator_subtract", savedY, centerY);
  const cos = expr("operator_mathop", { NUM: angleInput }, { OPERATOR: "cos" });
  const sin = expr("operator_mathop", { NUM: angleInput }, { OPERATOR: "sin" });
  const rotatedX = binary("operator_add", centerX, binary(
    "operator_subtract",
    binary("operator_multiply", dx, cos),
    binary("operator_multiply", dy, sin),
  ));
  const rotatedY = binary("operator_add", centerY, binary(
    "operator_add",
    binary("operator_multiply", dx, sin),
    binary("operator_multiply", dy, cos),
  ));
  const setVar = (variable, input) => makeBlock("data_setvariableto", {
    fields: { VARIABLE: variable.id },
    inputs: { VALUE: input },
    meta: { kittenType: "self_rotate_around", source: context.source || "kitten4" },
  });
  const setX = makeBlock("motion_setx", {
    inputs: { X: rotatedX },
    meta: { kittenType: "self_rotate_around", source: context.source || "kitten4" },
  });
  const setY = makeBlock("motion_sety", {
    inputs: { Y: rotatedY },
    meta: { kittenType: "self_rotate_around", source: context.source || "kitten4" },
  });
  const turn = makeBlock("motion_turnright", {
    inputs: { DEGREES: angleInput },
    meta: { kittenType: "self_rotate_around", source: context.source || "kitten4" },
  });
  return [
    setVar(xVar, expr("motion_xposition")),
    setVar(yVar, expr("motion_yposition")),
    setX,
    setY,
    turn,
  ];
}

// ---- Special block handlers ----

function applySpecial(type, irBlock, kittenBlock, context) {
  const params = kittenBlock.params || {};
  const source = context.source || "kitten4";
  const k3Scale = (input) => {
    if (source !== "kitten3" || !input) return input;
    if (input.type === "expr" && input.block?.opcode === "operator_multiply") {
      const left = input.block.inputs?.NUM1;
      const right = input.block.inputs?.NUM2;
      const isTwo = (value) => value?.type === "value" && Number(value.value) === 2;
      if (isTwo(right) && left) return left;
      if (isTwo(left) && right) return right;
    }
    if (input.type !== "value") return input;
    if (typeof input.value === "number") input.value /= 2;
    return input;
  };

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
    delete irBlock.inputs.SPRITE1;
    delete irBlock.fields.SPRITE1;
    irBlock.inputs.TOUCHINGOBJECTMENU = makeValue(normalize(sprite2), "string");
    irBlock.__menuShadow = "TOUCHINGOBJECTMENU";
  }

  switch (type) {
    case "broadcast_receive": {
      const message = broadcastName(params.message ?? params.MESSAGE ?? params.msg ?? params.broadcast);
      irBlock.fields.BROADCAST_OPTION = String(message ?? "");
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "broadcast_send": {
      const original = params.message ?? params.MESSAGE ?? params.msg ?? params.broadcast;
      const message = broadcastName(original);
      irBlock.inputs.BROADCAST_INPUT = isBlockRef(message)
        ? makeExpr(convertBlock(message, context))
        : makeValue(String(message ?? ""), "string");
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "broadcast_input": {
      const message = broadcastName(params.MESSAGE ?? params.message ?? params.msg ?? params.broadcast);
      irBlock.fields.BROADCAST_OPTION = String(message ?? "");
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "costume_by_id":
    case "set_costume_by_id":
    case "set_costume": {
      const id = params.sid || params.style_id || params.costume || params.style || "";
      const name = context.__styleNameById?.get(String(id)) || String(id);
      irBlock.inputs.COSTUME = makeValue(name, "string");
      delete irBlock.inputs.SID;
      delete irBlock.fields.COSTUME;
      break;
    }
    case "dialog_input": {
      if (!irBlock.inputs.QUESTION && params.text !== undefined) {
        irBlock.inputs.QUESTION = isBlockRef(params.text)
          ? makeExpr(convertBlock(params.text, context))
          : makeValue(String(params.text), "string");
      }
      break;
    }
    case "draggable": {
      irBlock.fields.DRAG_MODE = String(params.draggable ?? params.mode ?? "1") === "1" ? "draggable" : "not draggable";
      break;
    }
    case "pen_color": {
      const color = params.color;
      if (color !== undefined && !irBlock.inputs.COLOR) {
        irBlock.inputs.COLOR = isBlockRef(color) ? makeExpr(convertBlock(color, context)) : makeValue(String(color), "string");
      }
      break;
    }
    case "set_layer_with_pen": {
      // K3's pen-layer block has no Scratch equivalent. Keep it as a valid
      // pen color operation instead of emitting the unsupported POSITION input.
      delete irBlock.inputs.POSITION;
      irBlock.inputs.COLOR ||= makeValue("#000000", "string");
      break;
    }
    case "pen_size": {
      if (params.size !== undefined && !irBlock.inputs.SIZE) {
        irBlock.inputs.SIZE = k3Scale(isBlockRef(params.size) ? makeExpr(convertBlock(params.size, context)) : makeValue(Number(params.size) || 1, "number"));
      }
      break;
    }
    case "self_move_to": {
      if (irBlock.inputs.X) irBlock.inputs.X = k3Scale(irBlock.inputs.X);
      if (irBlock.inputs.Y) irBlock.inputs.Y = k3Scale(irBlock.inputs.Y);
      break;
    }
    case "move_specify": {
      const target = params.target;
      if (target !== undefined) irBlock.inputs.TO = isBlockRef(target) ? makeExpr(convertBlock(target, context)) : makeValue(String(target), "string");
      break;
    }
    case "move_to": {
      if (irBlock.inputs.X) irBlock.inputs.X = k3Scale(irBlock.inputs.X);
      if (irBlock.inputs.Y) irBlock.inputs.Y = k3Scale(irBlock.inputs.Y);
      break;
    }
    case "rotate":
    case "self_rotate": {
      const rawDegrees = irBlock.inputs.DEGREES || numericInput(params.degrees ?? 0, context);
      // Kitten's positive rotation is opposite to Scratch's `turn right`
      // convention. The official Scratch bridge serializes right turns as
      // `0 - degrees`, so reverse the value on the way back.
      irBlock.inputs.DEGREES = negate(rawDegrees);
      break;
    }
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
      irBlock.fields.LIST = listName(params.VAR ?? params.list) || "<unknown>";
      delete irBlock.inputs.VAR;
      delete irBlock.inputs.LIST;
      delete irBlock.inputs.VALUE;
      delete irBlock.inputs.TYPE;
      if (params.INDEX !== undefined && !irBlock.inputs.INDEX) {
        irBlock.inputs.INDEX = isBlockRef(params.INDEX) ? makeExpr(convertBlock(params.INDEX, context)) : makeValue(Number(params.INDEX) || 1, "number");
      }
      break;
    }
    case "lists_get":
    case "lists_append":
    case "lists_delete":
    case "lists_insert":
    case "lists_replace":
    case "lists_index_of":
    case "lists_length":
    case "lists_is_exist":
    case "show_hide_list": {
      const listRef = params.VAR ?? params.list ?? params.LIST;
      const listId = listName(listRef) || "<unknown>";
      if (type === "show_hide_list") {
        irBlock.fields.LIST = listId;
        irBlock.opcode = String(params.FUNC || params.func || "show").toLowerCase() === "hide"
          ? "data_hidelist" : "data_showlist";
        delete irBlock.inputs.FUNC;
        delete irBlock.inputs.VAR;
        break;
      }
      irBlock.fields.LIST = listId;
      delete irBlock.inputs.VAR;
      delete irBlock.inputs.VALUE;
      delete irBlock.inputs.LIST;
      if (type === "lists_get") {
        irBlock.opcode = "data_listcontents";
        break;
      }
      if (type === "lists_append") {
        const item = params.ITEM ?? params.item ?? params.VALUE ?? params.value;
        if (item !== undefined) irBlock.inputs.ITEM = isBlockRef(item)
          ? makeExpr(convertBlock(item, context)) : makeValue(String(item), "string");
      } else if (type === "lists_delete" || type === "lists_get_value") {
        const index = params.INDEX ?? params.index ?? params.N;
        if (index !== undefined) irBlock.inputs.INDEX = isBlockRef(index)
          ? makeExpr(convertBlock(index, context)) : makeValue(Number(index) || 1, "number");
      } else if (type === "lists_insert") {
        const item = params.ITEM ?? params.item ?? params.VALUE ?? params.value;
        const index = params.INDEX ?? params.index ?? params.N;
        if (item !== undefined) irBlock.inputs.ITEM = isBlockRef(item)
          ? makeExpr(convertBlock(item, context)) : makeValue(String(item), "string");
        if (index !== undefined) irBlock.inputs.INDEX = isBlockRef(index)
          ? makeExpr(convertBlock(index, context)) : makeValue(Number(index) || 1, "number");
      } else if (type === "lists_replace") {
        const item = params.ITEM ?? params.item ?? params.VALUE ?? params.value;
        const index = params.INDEX ?? params.index ?? params.N;
        if (item !== undefined) irBlock.inputs.ITEM = isBlockRef(item)
          ? makeExpr(convertBlock(item, context)) : makeValue(String(item), "string");
        if (index !== undefined) irBlock.inputs.INDEX = isBlockRef(index)
          ? makeExpr(convertBlock(index, context)) : makeValue(Number(index) || 1, "number");
      } else if (type === "lists_index_of" || type === "lists_is_exist") {
        const item = params.ITEM ?? params.item ?? params.VALUE ?? params.value;
        if (item !== undefined) irBlock.inputs.ITEM = isBlockRef(item)
          ? makeExpr(convertBlock(item, context)) : makeValue(String(item), "string");
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
    case "switch_to_screen":
    case "switch_screen": {
      const screen = params.scene || params.screen || params.message || "";
      irBlock.opcode = "looks_switchbackdropto";
      irBlock.inputs.BACKDROP = sceneBackdropInput(screen, context);
      delete irBlock.fields.BROADCAST_OPTION;
      delete irBlock.inputs.SCENE;
      delete irBlock.inputs.SCREEN;
      delete irBlock.inputs.MESSAGE;
      break;
    }
    case "backdrop_on_change": {
      const screen = params.scene || params.screen || params.backdrop || params.message || "";
      const raw = String(screen);
      irBlock.fields.BACKDROP = context.__sceneBackdropById?.get(raw) || context.__sceneBackdropByName?.get(raw) || raw;
      delete irBlock.inputs.SCENE;
      delete irBlock.inputs.SCREEN;
      delete irBlock.inputs.MESSAGE;
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
      const scaledValueInput = k3Scale(valueInput);
      if (coord === "x") {
        irBlock.opcode = params.increase === "set" ? "motion_setx" : "motion_changexby";
        irBlock.inputs.DX = scaledValueInput;
      } else {
        irBlock.opcode = params.increase === "set" ? "motion_sety" : "motion_changeyby";
        irBlock.inputs.DY = scaledValueInput;
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
    case "move_forward":
    case "self_go_forward": {
      if (params.steps !== undefined && !irBlock.inputs.STEPS) {
        irBlock.inputs.STEPS = k3Scale(isBlockRef(params.steps) ? makeExpr(convertBlock(params.steps, context)) : makeValue(Number(params.steps) || 0, "number"));
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
      const rawDegrees = irBlock.inputs.DEGREES || numericInput(params.degrees ?? 0, context);
      const angle = negate(rawDegrees);
      const replacement = buildOrbitChain(kittenBlock, context, angle);
      if (replacement) irBlock.__replacementChain = replacement;
      break;
    }
    case "controls_if":
    case "controls_if_no_else":
    case "control_if_else": {
      const condition = params.condition ?? params.CONDITION ?? params.IF0;
      if (condition !== undefined) {
        irBlock.inputs.CONDITION = isBlockRef(condition)
          ? makeExpr(convertBlock(condition, context))
          : makeValue(Boolean(condition), "bool");
      }
      delete irBlock.inputs.IF0;
      const hasElse = Boolean(
        kittenBlock.__extraStatements?.some(statement => statement.name === "ELSE") ||
        /else\s*=\s*["']?1/.test(String(kittenBlock.mutation || "")),
      );
      if (hasElse) irBlock.opcode = "control_if_else";
      // block_data_json gives us DO0/ELSE statement chains via __extraStatements
      if (kittenBlock.__extraStatements) {
        const elseStmt = kittenBlock.__extraStatements.find(s => s.name === "ELSE");
        if (elseStmt && elseStmt.chain && elseStmt.chain.length > 0) {
          irBlock.branches[1] = convertChain(elseStmt.chain[0], context);
        }
        const doStmt = kittenBlock.__extraStatements.find(s => s.name === "DO0");
        if (doStmt && doStmt.chain && doStmt.chain.length > 0) {
          irBlock.branches[0] = convertChain(doStmt.chain[0], context);
        }
      }
      break;
    }
    case "mouse_down": {
      // Scratch only has the `mouse down?` reporter; K4 stores the fixed
      // `down` selector as a Blockly field, which is not a Scratch input.
      delete irBlock.inputs.MOUSE_EVENT_TYPE;
      delete irBlock.fields.MOUSE_EVENT_TYPE;
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
    // Keep absolute CDN URLs intact. The CLI hydrates them before the SB3
    // emitter resolves local asset paths; reducing this to the basename loses
    // the information needed for that download step.
    sourceFile = url;
    const ext = (sourceFile.split(".").pop() || "").toLowerCase();
    dataFormat = ext === "svg" ? "svg" : ext === "png" ? "png" : (ext === "jpg" || ext === "jpeg") ? "jpg" : ext === "mp3" ? "mp3" : ext === "wav" ? "wav" : "svg";
  }
  const center = styleInfo.rotate_center || styleInfo.pivot || { x: 0, y: 0 };
  // Kitten rotate_center is relative to the image center (y up),
  // Scratch rotationCenter is relative to the top-left corner (y down).
  let dims = { width: 0, height: 0 };
  if (inlineData && dataFormat === "png") {
    // PNG IHDR: width/height at bytes 16..23
    if (inlineData.length >= 24) {
      dims.width = inlineData.readUInt32BE(16);
      dims.height = inlineData.readUInt32BE(20);
    }
  } else if (inlineData && dataFormat === "svg") {
    const text = inlineData.toString("utf8", 0, 4096);
    const wm = text.match(/width="([\d.]+)/);
    const hm = text.match(/height="([\d.]+)/);
    if (wm) dims.width = parseFloat(wm[1]);
    if (hm) dims.height = parseFloat(hm[1]);
  }
  const rcx = center.x !== undefined ? dims.width / 2 + center.x : dims.width / 2;
  const rcy = center.y !== undefined ? dims.height / 2 - center.y : dims.height / 2;
  return {
    name: styleInfo.name || "costume",
    sourceFile,
    dataFormat,
    rotationCenterX: rcx,
    rotationCenterY: rcy,
    bitmapResolution: 1,
    __data: inlineData,
  };
}

function parseKitten4(projectJson) {
  const source = projectJson.__sourceFormat || "kitten4";
  const project = makeProject(projectJson.project_name || "Kitten Project", {
    sourceFormat: source,
    sourceFile: projectJson.__sourceFile || null,
    framerate: Number(projectJson.framerate || projectJson.fps) || 60,
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

  // Every Kitten scene becomes a Scratch/TurboWarp backdrop on one stage.
  const sceneIds = theatre.scenes_order || Object.keys(scenes);
  const stageSceneId = theatre.current_scene || sceneIds[0];
  const stageScene = scenes[stageSceneId];

  // TurboWarp supports custom stage dimensions. Preserve Kitten's canvas
  // rather than fitting a portrait project into Scratch's 480x360 viewport.
  const kittenW = (projectJson.size && projectJson.size.width) || 480;
  const kittenH = (projectJson.size && projectJson.size.height) || 360;
  const sx = 1;
  const sy = 1;
  const s = 1;
  project.meta.stageWidth = kittenW;
  project.meta.stageHeight = kittenH;
  project.meta.scaleX = sx;
  project.meta.scaleY = sy;
  project.meta.uniformScale = s;

  const stage = makeTarget("Stage", true);
  stage.name = stageScene?.name || "Stage";
  const sceneBackdrops = addSceneBackdrops(stage, {
    scenes,
    sceneIds,
    currentSceneId: stageSceneId,
    styles: theatre.styles || {},
    makeCostume: costumeFromStyle,
  });
  project.stage = stage;

  // Actors -> Sprites
  let layerOrder = 1;
  const usedSpriteNames = new Set();
  const actorNameById = new Map();
  for (const [actorId, actor] of Object.entries(actors)) {
    const sprite = makeTarget(uniqueSceneSpriteName(actor.name || actorId, usedSpriteNames), false);
    sprite.__actorId = actorId;
    sprite.__sceneId = actor.scene || null;
    sprite.__sceneVisible = actor.visible !== false;
    sprite.x = (actor.x || 0) * sx;
    // K4 serializes actor positions in the same Y-up coordinate system as
    // Scratch/TurboWarp. Flipping this puts the top and bottom actors in the
    // opposite places on a portrait stage.
    sprite.y = (actor.y || 0) * sy;
    sprite.size = source === "kitten3" ? (actor.scale || 100) : (actor.scale || 100) * s;
    if (Number.isFinite(Number(actor.rotation))) {
      sprite.direction = 90 - Number(actor.rotation) * 180 / Math.PI;
    }
    sprite.visible = sprite.__sceneVisible && (!sprite.__sceneId || sprite.__sceneId === stageSceneId);
    sprite.draggable = actor.draggable === true;
    sprite.rotationStyle = scratchRotationStyle(actor.rotation_type);
    sprite.layerOrder = layerOrder++;

    // Styles -> costumes (use real asset data from theatre.styles)
    const theatreStyles = theatre.styles || {};
    const styleIds = actor.styles || [];
    const costumeStyleIds = [];
    for (const styleId of styleIds) {
      const styleInfo = theatreStyles[styleId];
      if (!styleInfo) continue;
      const costume = costumeFromStyle(styleInfo, styleId);
      if (costume) {
        sprite.costumes.push(costume);
        costumeStyleIds.push(styleId);
      }
    }
    const currentCostume = costumeStyleIds.indexOf(actor.current_style_id);
    sprite.currentCostume = currentCostume >= 0 ? currentCostume : 0;

    actorNameById.set(actorId, sprite.name);
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
  for (const [actorId, actor] of Object.entries(actors)) {
    if (actor.block_data_json && actor.block_data_json.blocks) {
      const chains = blockDataGraph.blockDataJsonToChains(actor.block_data_json);
      actorBlockData[actorId] = chains.map(chain => ({ compiled_block_map: { root: chain } }));
    }
  }
  const sceneBlockData = {};
  for (const [sceneId, scene] of Object.entries(scenes)) {
    if (scene.block_data_json?.blocks) {
      const chains = blockDataGraph.blockDataJsonToChains(scene.block_data_json);
      sceneBlockData[sceneId] = chains.map(chain => ({ compiled_block_map: { root: chain } }));
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

  // Initial scene scripts run normally. Inactive scenes contribute only their
  // backdrop-change hats, which are activated after a screen switch.
  for (const sceneId of sceneIds) {
    const entities = [];
    if (entityMap.get(sceneId)) entities.push(entityMap.get(sceneId));
    if (sceneBlockData[sceneId]) entities.push(...sceneBlockData[sceneId]);
    for (const stageEntity of entities) {
      for (const [rootId, rootBlock] of Object.entries(stageEntity.compiled_block_map || {})) {
      const activatedRoot = sceneActivationRoot(rootBlock, sceneId, sceneId === stageSceneId);
      if (sceneId !== stageSceneId && activatedRoot.type !== "backdrop_on_change") continue;
      const chain = convertChain(activatedRoot, {
        project, target: stage, source,
        __sceneBackdropById: sceneBackdrops.sceneBackdropById,
        __sceneBackdropByName: sceneBackdrops.sceneBackdropByName,
      });
      if (chain.length > 0) stage.blocks.push(chain);
      }
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
        const chain = convertChain(sceneActivationRoot(
          rootBlock,
          sprite.__sceneId,
          !sprite.__sceneId || sprite.__sceneId === stageSceneId,
        ), {
          project, target: sprite, procedures: sprite.__procedures, __actorNameById: actorNameById, source,
          __sceneBackdropById: sceneBackdrops.sceneBackdropById,
          __sceneBackdropByName: sceneBackdrops.sceneBackdropByName,
        });
        if (chain.length > 0) sprite.blocks.push(chain);
        }
      }
    }
  }

  for (const sprite of project.sprites) {
    addSpriteInitialization(sprite);
    addSceneVisibilityHandlers(
      sprite,
      sceneBackdrops.sceneBackdropById.get(String(sprite.__sceneId)),
      sceneBackdrops.sceneBackdropNames,
      sprite.__sceneVisible,
    );
  }

  project.__assetFiles = global.__k2s_assetFiles || null;
  return project;
}

module.exports = { parseKitten4, convertChain, convertBlock };
