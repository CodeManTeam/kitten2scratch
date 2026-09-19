"use strict";

function uniqueName(value, used) {
  const base = String(value || "backdrop");
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} (${suffix++})`;
  used.add(name);
  return name;
}

function addSceneBackdrops(stage, options) {
  const {
    scenes, sceneIds, currentSceneId, styles, makeCostume,
  } = options;
  const orderedIds = [...sceneIds];
  if (currentSceneId && !orderedIds.includes(currentSceneId)) orderedIds.unshift(currentSceneId);

  const usedNames = new Set();
  const sceneBackdropById = new Map();
  const sceneBackdropByName = new Map();
  const sceneBackdropNames = [];

  for (const sceneId of orderedIds) {
    const scene = scenes[sceneId];
    if (!scene) continue;
    const sceneName = scene.name || `scene-${sceneId}`;
    // A scene has one active background. Other scene styles are an editor
    // library, not additional scenes.
    const styleIds = [scene.current_style_id || (scene.styles || [])[0]].filter(Boolean);
    let selectedName = null;

    for (const styleId of styleIds) {
      const style = styles[styleId];
      if (!style) continue;
      const isSelected = styleId === scene.current_style_id || !selectedName;
      const suggestedName = isSelected
        ? sceneName
        : `${sceneName} - ${style.name || styleId}`;
      const costume = makeCostume(style, styleId);
      if (!costume) continue;

      costume.name = uniqueName(suggestedName, usedNames);
      stage.costumes.push(costume);
      if (isSelected && !selectedName) selectedName = costume.name;
    }

    if (!selectedName) continue;
    sceneBackdropById.set(String(sceneId), selectedName);
    if (!sceneBackdropByName.has(sceneName)) sceneBackdropByName.set(sceneName, selectedName);
    sceneBackdropNames.push(selectedName);
    if (sceneId === currentSceneId) stage.currentCostume = stage.costumes.findIndex(costume => costume.name === selectedName);
  }

  if (stage.currentCostume < 0) stage.currentCostume = 0;
  return { sceneBackdropById, sceneBackdropByName, sceneBackdropNames };
}

module.exports = { addSceneBackdrops };
