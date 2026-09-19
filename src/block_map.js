/**
 * Kitten/KittenN block type -> Scratch/TurboWarp opcode mapping table.
 *
 * This is the heart of the converter. Each entry:
 *   kitten_type: {
 *     opcode: "scratch_opcode",
 *     // How to map params/fields. Use these functions:
 *     //   num(key) -> numeric input from param `key`
 *     //   str(key) -> string input
 *     //   bool(key) -> boolean input
 *     //   field(key) -> dropdown field value (static, not an input)
 *     //   expr(key) -> expression block as input
 *     map: { scratchInputName: ["num"|"str"|"bool"|"expr"|"field", kittenParamKey] }
 *   }
 */

"use strict";

// ---- helpers ----
const N = (key) => ["num", key];
const S = (key) => ["str", key];
const B = (key) => ["bool", key];
const E = (key) => ["expr", key];
const F = (key) => ["field", key];

// ---- dropdown value normalization ----
// Kitten4 uses UPPER_SNAKE (MULTIPLY, MINUS, ...), KittenN uses lowercase (multiply, minus, ...).
// We normalize everything to Scratch's canonical form.

const ARITH_MAP = {
  ADD: "+", add: "+",
  MINUS: "-", minus: "-",
  MULTIPLY: "*", multiply: "*",
  DIVIDE: "/", divide: "/",
};

const COMPARE_MAP = {
  GT: ">", gt: ">",
  LT: "<", lt: "<",
  EQ: "=", eq: "=", EQUAL: "=", equal: "=",
};

const LOGIC_MAP = {
  AND: "and", and: "and",
  OR: "or", or: "or",
};

const MATH_SINGLE_MAP = {
  ROOT: "sqrt", "0": "sqrt",
  ABS: "abs", "1": "abs",
  NEG: "-", "2": "-",
  LN: "ln", "3": "ln",
  LOG10: "log", "4": "log",
  EXP: "e ^", "5": "e ^",
  POW10: "10 ^", "6": "10 ^",
};

const MATH_TRIG_MAP = {
  SIN: "sin", sin: "sin",
  COS: "cos", cos: "cos",
  TAN: "tan", tan: "tan",
  ASIN: "asin", asin: "asin",
  ACOS: "acos", acos: "acos",
  ATAN: "atan", atan: "atan",
};

const ROUND_MAP = {
  ROUND: "round", round: "round",
  ROUNDDOWN: "floor", round_down: "floor",
  ROUNDUP: "ceiling", round_up: "ceiling",
};

const KEY_MAP = {
  "37": "left arrow", "38": "up arrow", "39": "right arrow", "40": "down arrow",
  "32": "space", "13": "enter", "27": "escape",
  "65": "a", "66": "b", /* ... letter keys map directly ... */
};

const MOUSE_EVENT_MAP = {
  down: "down", up: "up", click: "click",
};

// ---- main mapping table ----

const BLOCK_MAP = {
  // ===== Events =====
  start_on_click: { opcode: "event_whenflagclicked", map: {} },
  backdrop_on_change: { opcode: "event_whenbackdropswitchesto", map: { BACKDROP: F("backdrop") }, special: "backdrop_on_change", hat: true },
  on_keydown: { opcode: "event_whenkeypressed", map: { KEY_OPTION: F("key"), KEY_MODE: F("type") } },
  sprite_on_tap: { opcode: "event_whenthisspriteclicked", map: {}, hat: true, dropParams: ["actor", "type"] },
  self_on_tap: { opcode: "event_whenthisspriteclicked", map: {}, hat: true },
  // In K3 this is a message selector value nested inside self_listen/self_broadcast,
  // not an independent Scratch event hat.
  broadcast_input: { opcode: "event_whenbroadcastreceived", map: {}, special: "broadcast_input" },
  self_listen: { opcode: "event_whenbroadcastreceived", map: {}, special: "broadcast_receive", hat: true },
  self_broadcast: { opcode: "event_broadcast", map: {}, special: "broadcast_send" },
  self_broadcast_and_wait: { opcode: "event_broadcastandwait", map: {}, special: "broadcast_send" },
  on_running_group_activated: { opcode: "event_whenflagclicked", map: {} },
  when: { opcode: "event_whenbroadcastreceived", map: { CONDITION: E("condition") } },

  // ===== Control =====
  repeat_forever: { opcode: "control_forever", map: {}, branch: "child_block" },
  repeat_n_times: { opcode: "control_repeat", map: { TIMES: N("times") }, branch: "child_block" },
  controls_if: { opcode: "control_if", map: { CONDITION: E("condition") }, branch: "child_block", special: "controls_if" },
  controls_if_no_else: { opcode: "control_if", map: { CONDITION: E("condition") }, branch: "child_block", special: "controls_if" },
  control_if_else: { opcode: "control_if", map: { CONDITION: E("condition") }, branch: "child_block", special: "controls_if" },
  wait: { opcode: "control_wait", map: { DURATION: N("time") } },
  wait_until: { opcode: "control_wait_until", map: { CONDITION: E("condition") } },
  repeat_forever_until: { opcode: "control_repeat_until", map: { CONDITION: E("condition") }, branch: "child_block" },
  break: { opcode: "control_stop", map: { STOP_OPTION: null, HAS_NEXT: null }, special: "break" },
  warp: { opcode: "motion_align_scene", map: {}, special: "warp" },

  // ===== Motion =====
  self_go_forward: { opcode: "motion_movesteps", special: "move_forward" },
  self_rotate: { opcode: "motion_turnright", special: "rotate" },
  self_move_to: { opcode: "motion_gotoxy", map: { X: N("x"), Y: N("y") }, special: "move_to" },
  self_glide_to: { opcode: "motion_glidesecstoxy", special: "glide" },
  self_change_coordinate: { opcode: "motion_changeyby", special: "change_coord" },
  self_change_x: { opcode: "motion_changexby", map: { DX: N("x") } },
  mirror: { opcode: "motion_turnright", special: "mirror" },
  self_point_towards: { opcode: "motion_pointindirection", map: { DIRECTION: N("degrees") } },
  self_move_specify: { opcode: "motion_goto", map: {}, special: "move_specify" },

  // ===== Looks =====
  self_prev_next_style: { opcode: "looks_nextcostume", map: {}, special: "costume" },
  self_set_effect_2: { opcode: "looks_seteffectto", map: { EFFECT: F("scope"), VALUE: E("val") } },
  self_appear: { opcode: "looks_show", map: {} },
  self_disappear: { opcode: "looks_hide", map: {} },
  self_gradually_show_hide: { opcode: "looks_show", map: {}, special: "gradually_show_hide" },
  self_change_scale_2: { opcode: "looks_setsizeto", map: { SIZE: E("scale") } },
  self_text_effect_text: { opcode: "looks_say", map: { MESSAGE: E("text") } },
  self_text_effect_color: { opcode: "looks_seteffectto", map: {}, special: "text_effect_color" },
  self_next_style: { opcode: "looks_nextcostume", map: {} },
  set_costume_by_id: { opcode: "looks_switchcostumeto", map: {}, special: "costume_by_id" },
  set_costume: { opcode: "looks_switchcostumeto", map: {}, special: "costume_by_id" },
  self_change_scale: { opcode: "looks_changesizeby", map: { CHANGE: E("scale") } },
  self_text_effect_size: { opcode: "looks_setsizeto", map: { SIZE: E("size") } },
  self_clear_effects: { opcode: "looks_cleargraphiceffects", map: {} },
  set_theatre_layer: { opcode: "looks_gotofrontback", special: "layer" },
  set_scale: { opcode: "looks_setsizeto", map: { SIZE: E("scale") } },

  // ===== Sound =====
  audio_play: { opcode: "sound_play", map: { SOUND_MENU: F("audio") } },
  audio_stop: { opcode: "sound_stopallsounds", map: {} },
  stop: { opcode: "control_stop", map: { STOP_OPTION: null }, special: "stop" },
  self_rotate_around: { opcode: "motion_turnright", map: { DEGREES: E("degrees") }, special: "rotate_around" },
  self_glide_coordinate_y: { opcode: "motion_glidesecstoxy", map: {}, special: "glide_coordinate_y" },
  change_volume_or_rate: { opcode: "sound_setvolumeto", map: { VOLUME: E("volume") } },

  // ===== Pen =====
  self_pen_down: { opcode: "pen_penDown", map: {} },
  self_pen_up: { opcode: "pen_penUp", map: {} },
  clear_drawing: { opcode: "pen_clear", map: {} },
  set_layer_with_pen: { opcode: "pen_setPenColorToColor", map: { COLOR: E("color") }, special: "set_layer_with_pen" },
  stamp: { opcode: "pen_stamp", map: {} },
  image_stamp: { opcode: "pen_stamp", map: {} },
  self_set_pen_color: { opcode: "pen_setPenColorToColor", map: { COLOR: E("color") }, special: "pen_color" },
  self_set_pen_size: { opcode: "pen_setPenSizeTo", map: { SIZE: E("size") }, special: "pen_size" },

  // ===== Sensing =====
  mouse_down: { opcode: "sensing_mousedown", map: { MOUSE_EVENT_TYPE: F("mouse_event_type") }, special: "mouse_down" },
  mouse_click: { opcode: "sensing_mousedown", map: { MOUSE_EVENT_TYPE: F("mouse_event_type") } },
  check_key: { opcode: "sensing_keypressed", map: {}, special: "check_key" },
  bump: { opcode: "sensing_touchingobject", map: {}, special: "bump" },
  bump_into: { opcode: "sensing_touchingobject", map: {}, special: "bump" },
  bump_into_color: { opcode: "sensing_touchingcolor", map: { COLOR: E("color") } },
  get_answer: { opcode: "sensing_answer", map: {} },
  get_choice_or_index: { opcode: "sensing_answer", map: {} },
  ask_and_choose: { opcode: "sensing_askandwait", map: { QUESTION: E("question") } },
  get_current_scene: { opcode: "sensing_of", special: "scene" },
  timer: { opcode: "sensing_timer", map: {} },
  get_time: { opcode: "sensing_dayssince2000", special: "time" },
  username_get: { opcode: "sensing_username", map: {} },
  user_id_get: { opcode: "sensing_username", map: {} },
  distance_to: { opcode: "sensing_distanceto", map: { DISTANCETOMENU: F("sprite2") } },
  coordinate_of_sprite: { opcode: "sensing_of", special: "attribute_of" },
  get_mouse_info: { opcode: "sensing_mousex", special: "mouse_info" },
  self_ask: { opcode: "sensing_askandwait", map: {}, special: "dialog_input" },
  get_timer: { opcode: "sensing_timer", map: {} },
  reset_timer: { opcode: "sensing_resettimer", map: {} },
  out_of_boundary: { opcode: "sensing_touchingobject", special: "out_of_boundary" },

  // ===== Math / Logic / Text =====
  math_number: { opcode: "math_number", map: { NUM: N("NUM") }, isLiteral: true },
  text: { opcode: "text", map: { TEXT: S("TEXT") }, isLiteral: true },
  math_arithmetic: { opcode: "operator_add", map: { A: E("A"), B: E("B"), OP: F("type") }, special: "arithmetic" },
  logic_compare: { opcode: "operator_gt", map: { OPERAND1: E("A"), OPERAND2: E("B"), OP: F("type") }, special: "compare" },
  logic_operation: { opcode: "operator_and", map: { OPERAND1: E("A"), OPERAND2: E("B"), OP: F("type") }, special: "logic" },
  logic_boolean: { opcode: "operator_lt", special: "bool_literal" },
  logic_negate: { opcode: "operator_not", map: { OPERAND: E("BOOL") } },
  math_single: { opcode: "operator_mathop", map: { NUM: E("A"), OPERATOR: F("type") }, special: "math_single" },
  math_trig: { opcode: "operator_mathop", map: { NUM: E("A"), OPERATOR: F("type") }, special: "math_trig" },
  math_round: { opcode: "operator_mathop", map: { NUM: E("A"), OPERATOR: F("type") }, special: "math_round" },
  math_modulo: { opcode: "operator_mod", map: { DIVIDEND: E("A"), DIVISOR: E("B") } },
  math_arithmetic_power: { opcode: "operator_multiply", special: "power" },
  math_function: { opcode: "operator_mathop", map: { NUM: E("A"), OPERATOR: F("type") } },
  math_number_property: { opcode: "operator_lt", special: "number_property" },
  math_arc_trig: { opcode: "operator_mathop", map: { NUM: E("A"), OPERATOR: F("type") }, special: "arc_trig" },
  random: { opcode: "operator_random", map: { FROM: E("a"), TO: E("b") } },
  text_join: { opcode: "operator_join", map: { STRING1: E("TEXT1"), STRING2: E("TEXT2") }, special: "text_join" },
  text_split: { opcode: "operator_letter_of", special: "text_split" },
  text_length: { opcode: "operator_length", map: { STRING: E("TEXT") } },
  text_contain: { opcode: "operator_contains", map: { STRING1: E("TEXT1"), STRING2: E("TEXT2") } },
  text_select: { opcode: "operator_letter_of", map: { LETTER: E("INDEX"), STRING: E("TEXT") } },
  convert_type: { opcode: "operator_join", special: "convert_type" },
  divisible_by: { opcode: "operator_mod", special: "divisible" },

  // ===== Variables =====
  variables_get: { opcode: "data_variable", special: "variable_get" },
  variables_set: { opcode: "data_setvariableto", special: "variable_set" },
  change_variable: { opcode: "data_changevariableby", special: "variable_change" },
  show_hide_variable: { opcode: "data_showvariable", special: "show_variable" },
  cloud_variables_get: { opcode: "data_variable", special: "cloud_get" },
  cloud_variables_set: { opcode: "data_setvariableto", special: "cloud_set" },
  change_cloud_variable: { opcode: "data_changevariableby", special: "cloud_change" },

  // ===== Lists =====
  list_get: { opcode: "data_itemoflist", special: "list_get" },
  list_item: { opcode: "data_itemoflist", special: "list_get" },
  list_length: { opcode: "data_lengthoflist", special: "list_length" },
  list_index_of: { opcode: "data_itemnumoflist", special: "list_index" },
  list_is_exist: { opcode: "data_itemnumoflist", special: "list_contains" },
  lists_get_value: { opcode: "data_itemoflist", special: "list_get" },
  pure_list_get: { opcode: "data_itemoflist", special: "list_get" },

  // ===== Procedures =====
  procedures_2_defnoreturn: { opcode: "procedures_definition", special: "procedure_def" },
  procedures_2_callnoreturn: { opcode: "procedures_call", special: "procedure_call" },
  procedures_2_callreturn: { opcode: "procedures_call", special: "procedure_call_return" },
  procedures_2_return_value: { opcode: "procedures_call", special: "procedure_call_return" },
  procedures_2_parameter: { opcode: "argument_reporter_string_number", special: "procedure_param" },
  procedures_2_actor_param: { opcode: "argument_reporter_string_number", special: "procedure_param" },
  procedures_2_stable_parameter: { opcode: "argument_reporter_string_number", special: "procedure_param" },

  // ===== Clones =====
  start_as_a_mirror: { opcode: "control_start_as_clone", map: {}, hat: true },
  dispose_clone: { opcode: "control_stop", map: { STOP_OPTION: "this clone", HAS_NEXT: null } },
  get_current_clone_index: { opcode: "sensing_of", special: "clone_index" },
  get_clone_num: { opcode: "sensing_of", special: "clone_count" },
  get_clone_index_property: { opcode: "sensing_of", special: "clone_prop" },
  restart: { opcode: "control_stop", map: {}, special: "restart" },
  traverse_number: { opcode: "control_repeat", map: {}, special: "traverse_number", branch: "statements" },
  traverse_number_param: { opcode: "data_variable", map: {}, special: "traverse_param" },
  traverse_number_value: { opcode: "data_variable", map: {}, special: "traverse_param" },

  // ===== Stage / Screen =====
  switch_to_screen: { opcode: "looks_switchbackdropto", special: "switch_to_screen" },
  create_stage_dialog: { opcode: "looks_say", map: { MESSAGE: E("message") }, special: "stage_dialog" },
  get_3: { opcode: "sensing_of", special: "get_3" },

  // ===== KittenN-specific =====
  change_variables: { opcode: "data_changevariableby", special: "variable_change" },
  script_variables_value: { opcode: "data_variable", special: "script_variable_get" },
  script_variables_param: { opcode: "argument_reporter_string_number", special: "procedure_param" },
  lists_get: { opcode: "data_listcontents", map: {}, special: "list_contents" },
  lists_append: { opcode: "data_addtolist", map: {}, special: "list_append" },
  lists_delete: { opcode: "data_deleteoflist", map: {}, special: "list_delete" },
  lists_insert: { opcode: "data_insertatlist", map: {}, special: "list_insert" },
  lists_replace: { opcode: "data_replaceitemoflist", map: {}, special: "list_replace" },
  lists_get_value: { opcode: "data_itemoflist", map: {}, special: "list_get" },
  lists_index_of: { opcode: "data_itemnumoflist", map: {}, special: "list_index" },
  lists_length: { opcode: "data_lengthoflist", map: {}, special: "list_length" },
  lists_is_exist: { opcode: "data_listcontainsitem", map: {}, special: "list_contains" },
  show_hide_list: { opcode: "data_showlist", map: {}, special: "show_list" },
};

module.exports = {
  BLOCK_MAP,
  ARITH_MAP,
  COMPARE_MAP,
  LOGIC_MAP,
  MATH_SINGLE_MAP,
  MATH_TRIG_MAP,
  ROUND_MAP,
  KEY_MAP,
  MOUSE_EVENT_MAP,
  N, S, B, E, F,
};
