"use strict";

/**
 * Kitten 3 / Scratch import bridge parser.
 *
 * The K3 Scratch bridge does not write compile_result. It converts Scratch
 * blocks into Kitten block XML and stores that XML on each scene/actor. The
 * surrounding BCM object still uses the K3 theatre format.
 */

const {
  makeProject, makeTarget, makeVariable, makeBroadcast, addSpriteInitialization,
  addSceneVisibilityHandlers,
} = require("./ir");
const { addSceneBackdrops } = require("./scene_backdrops");
const { convertChain, parseKitten4 } = require("./parse_kitten4");
const { parseBlocksXml } = require("./xml_blocks");

function objectEntries(value) {
  return value && typeof value === "object" ? Object.entries(value) : [];
}

function valueInfo(id, raw, cloud = false) {
  if (Array.isArray(raw)) {
    return { name: String(raw[0] ?? id), value: raw[1] ?? "", isList: Array.isArray(raw[1]), cloud };
  }
  if (raw && typeof raw === "object") {
    return {
      name: String(raw.name ?? raw.variable_name ?? id),
      value: raw.value ?? raw.default_value ?? (raw.type === "list" ? [] : ""),
      isList: raw.type === "list" || raw.type === "public_list" || raw.type === "private_list" || Array.isArray(raw.value),
      cloud,
      isGlobal: raw.is_global !== false,
      currentEntity: raw.current_entity,
    };
  }
  return { name: String(id), value: raw ?? "", isList: false, cloud };
}

function addCostumes(target, styles, styleIds, currentStyleId) {
  const ids = Array.isArray(styleIds) ? styleIds : [];
  for (const styleId of ids) {
    const style = styles[styleId];
    if (!style) continue;
    const width = Number(style.width) || 0;
    const height = Number(style.height) || 0;
    const center = style.rotate_center || style.pivot || { x: 0, y: 0 };
    const rotationCenterX = style.is_svg
      ? (width + Number(center.x || 0)) / 2
      : width / 2 + Number(center.x || 0);
    const rotationCenterY = style.is_svg
      ? (height + Number(center.y || 0)) / 2
      : height / 2 - Number(center.y || 0);
    const costume = {
      name: style.name || styleId,
      sourceFile: null,
      dataFormat: style.is_svg ? "svg" : "png",
      rotationCenterX,
      rotationCenterY,
      bitmapResolution: 1,
      md5ext: null,
    };
    const url = style.url || style.cdn_url || "";
    const dataMatch = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataMatch) {
      costume.__data = Buffer.from(dataMatch[2], "base64");
      costume.dataFormat = dataMatch[1].includes("svg") ? "svg" : "png";
    } else costume.sourceFile = url || null;
    target.costumes.push(costume);
  }
  const currentIndex = ids.indexOf(currentStyleId);
  target.currentCostume = currentIndex >= 0 ? currentIndex : 0;
}

function addScripts(target, blocksXml, context) {
  if (!blocksXml || typeof blocksXml !== "string") return;
  for (const root of parseBlocksXml(blocksXml)) {
    const convertedRoot = sceneActivationRoot(
      root,
      context.sceneId,
      !context.sceneId || context.sceneId === context.activeSceneId,
    );
    const chain = convertChain(convertedRoot, { ...context, source: "kitten3" });
    if (chain.length) target.blocks.push(chain);
  }
}

function sceneActivationRoot(rootBlock, sceneId, active) {
  if (active || !rootBlock || rootBlock.type !== "start_on_click") return rootBlock;
  return { ...rootBlock, type: "backdrop_on_change", params: { ...(rootBlock.params || {}), scene: sceneId } };
}

function addSounds(target, audio) {
  for (const [id, raw] of objectEntries(audio)) {
    const item = raw && typeof raw === "object" ? raw : { name: id, url: raw };
    const sound = {
      name: item.name || id,
      sourceFile: null,
      dataFormat: item.dataFormat || (item.url || "").split(".").pop() || "mp3",
      md5ext: null,
      rate: item.rate || 44100,
      sampleCount: item.sampleCount || 0,
    };
    const dataMatch = String(item.url || "").match(/^data:([^;]+);base64,(.*)$/s);
    if (dataMatch) {
      sound.__data = Buffer.from(dataMatch[2], "base64");
      sound.dataFormat = dataMatch[1].includes("wav") ? "wav" : "mp3";
    } else sound.sourceFile = item.url || null;
    target.sounds.push(sound);
  }
}

function uniqueSpriteName(value, used) {
  const base = String(value || "Sprite");
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} (${suffix++})`;
  used.add(name);
  return name;
}

function makeCostumeFromStyle(style, styleId) {
  if (!style) return null;
  const width = Number(style.width) || 0;
  const height = Number(style.height) || 0;
  const center = style.rotate_center || style.pivot || { x: 0, y: 0 };
  const costume = {
    name: style.name || styleId,
    sourceFile: null,
    dataFormat: style.is_svg ? "svg" : "png",
    rotationCenterX: style.is_svg ? (width + Number(center.x || 0)) / 2 : width / 2 + Number(center.x || 0),
    rotationCenterY: style.is_svg ? (height + Number(center.y || 0)) / 2 : height / 2 - Number(center.y || 0),
    bitmapResolution: 1,
    md5ext: null,
  };
  const url = style.url || style.cdn_url || "";
  const dataMatch = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataMatch) {
    costume.__data = Buffer.from(dataMatch[2], "base64");
    costume.dataFormat = dataMatch[1].includes("svg") ? "svg" : "png";
  } else costume.sourceFile = url || null;
  return costume;
}

function parseKitten3(projectJson) {
  if (Array.isArray(projectJson.compile_result) && projectJson.compile_result.length > 0) {
    return parseKitten4({ ...projectJson, __sourceFormat: "kitten3" });
  }
  const theatre = projectJson.theatre || {};
  const scenes = theatre.scenes || {};
  const actors = theatre.actors || {};
  const styles = theatre.styles || {};
  const styleNameById = new Map(objectEntries(styles).map(([id, style]) => [String(id), style.name || id]));
  const project = makeProject(projectJson.project_name || "Kitten 3 Project", {
    sourceFormat: "kitten3",
    sourceFile: projectJson.__sourceFile || null,
    applicationVersion: projectJson.application_version || "3.8.17",
    framerate: Number(projectJson.framerate || projectJson.fps) || 60,
  });

  const kittenW = Number(projectJson.width || projectJson.size?.width) || 960;
  const kittenH = Number(projectJson.height || projectJson.size?.height) || 720;
  // TurboWarp can keep the original canvas size, so actor coordinates and
  // costume pixels do not need to be squeezed into the Scratch viewport.
  const sx = 1;
  const sy = 1;
  project.meta.stageWidth = kittenW;
  project.meta.stageHeight = kittenH;
  project.meta.scaleX = sx;
  project.meta.scaleY = sy;
  project.meta.uniformScale = 1;

  const cloudIds = new Set(objectEntries(projectJson.cloud_variables).map(([id]) => id));
  for (const [id, raw] of objectEntries(projectJson.variables)) {
    const info = valueInfo(id, raw, cloudIds.has(id));
    const variable = makeVariable(id, info.name, info.value, info.cloud, info.isList, info.isGlobal !== false);
    variable.currentEntity = info.currentEntity;
    project.variables.push(variable);
  }
  for (const [id, raw] of objectEntries(projectJson.cloud_variables)) {
    if (project.variables.some(variable => variable.id === id)) continue;
    const info = valueInfo(id, raw, true);
    project.variables.push(makeVariable(id, info.name, info.value, true, info.isList, true));
  }

  for (const [id, raw] of objectEntries(projectJson.broadcasts)) {
    const names = Array.isArray(raw) ? raw : [raw];
    for (const name of names) {
      if (typeof name === "string" && name) project.broadcasts.push(makeBroadcast(id, name));
    }
  }

  const sceneIds = theatre.scenes_order || Object.keys(scenes);
  const stageSceneId = theatre.current_scene || sceneIds[0];
  const stageScene = scenes[stageSceneId];
  const stage = makeTarget(stageScene?.name || "Stage", true);
  const sceneBackdrops = addSceneBackdrops(stage, {
    scenes,
    sceneIds,
    currentSceneId: stageSceneId,
    styles,
    makeCostume: makeCostumeFromStyle,
  });
  for (const sceneId of sceneIds) {
    const scene = scenes[sceneId];
    if (!scene || !scene.blocksXML) continue;
    addScripts(stage, scene.blocksXML, {
      project,
      target: stage,
      __styleNameById: styleNameById,
      sceneId,
      activeSceneId: stageSceneId,
      __sceneBackdropById: sceneBackdrops.sceneBackdropById,
      __sceneBackdropByName: sceneBackdrops.sceneBackdropByName,
    });
  }
  stage.variables = project.variables.filter(variable => variable.isGlobal === false && variable.currentEntity === stageSceneId);
  addSounds(stage, projectJson.audio);
  project.stage = stage;

  const actorNameById = new Map();
  for (const [id, actor] of objectEntries(actors)) actorNameById.set(id, actor.name || id);
  let layerOrder = 1;
  const usedSpriteNames = new Set();
  for (const [actorId, actor] of objectEntries(actors)) {
    const sprite = makeTarget(uniqueSpriteName(actor.name || actorId, usedSpriteNames), false);
    sprite.__actorId = actorId;
    sprite.__sceneId = actor.scene || null;
    sprite.__sceneVisible = actor.visible !== false;
    sprite.x = Number(actor.x || 0) * sx;
    sprite.y = -Number(actor.y || 0) * sy;
    sprite.size = Number(actor.scale ?? 100);
    // K3 stores actor rotation in radians; Scratch stores direction in degrees.
    sprite.direction = 90 - Number(actor.rotation || 0) * 180 / Math.PI;
    sprite.visible = sprite.__sceneVisible && (!sprite.__sceneId || sprite.__sceneId === stageSceneId);
    sprite.draggable = actor.draggable === true;
    sprite.layerOrder = layerOrder++;
    addCostumes(sprite, styles, actor.styles, actor.current_style_id);
    addScripts(sprite, actor.blocksXML, {
      project,
      target: sprite,
      __actorNameById: actorNameById,
      __styleNameById: styleNameById,
      __sceneBackdropById: sceneBackdrops.sceneBackdropById,
      __sceneBackdropByName: sceneBackdrops.sceneBackdropByName,
      sceneId: actor.scene,
      activeSceneId: stageSceneId,
    });
    for (const [id, raw] of objectEntries(actor.variables)) {
      const info = valueInfo(id, raw, cloudIds.has(id));
      const variable = makeVariable(id, info.name, info.value, info.cloud, info.isList, false);
      variable.currentEntity = actorId;
      sprite.variables.push(variable);
    }
    if (!sprite.variables.length) sprite.variables = project.variables.filter(variable => variable.isGlobal === false && variable.currentEntity === actorId);
    addSounds(sprite, projectJson.audio);
    addSpriteInitialization(sprite);
    addSceneVisibilityHandlers(
      sprite,
      sceneBackdrops.sceneBackdropById.get(String(sprite.__sceneId)),
      sceneBackdrops.sceneBackdropNames,
      sprite.__sceneVisible,
    );
    project.sprites.push(sprite);
  }

  return project;
}

module.exports = { parseKitten3 };
