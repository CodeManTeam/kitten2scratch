"use strict";

/**
 * Convert Kitten4 block_data_json (Blockly graph: blocks + connections)
 * into compile_result-style linked block chains that parse_kitten4 can consume.
 */
function blockDataJsonToChains(blockData) {
  const blocks = blockData.blocks || {};
  const connections = blockData.connections || {};
  const chains = [];
  const roots = Object.values(blocks).filter(b => b && !b.parent_id && !b.is_shadow && b.type !== "math_number" && b.type !== "text");
  for (const root of roots) {
    const chain = buildChain(root.id, blocks, connections);
    if (chain.length > 0) chains.push(chain[0]);
  }
  return chains;
}

function buildChain(rootId, blocks, connections) {
  const chain = [];
  let currentId = rootId;
  let guard = 0;
  while (currentId && guard < 10000) {
    guard++;
    const block = blocks[currentId];
    if (!block) break;
    const cloned = cloneWithChildren(block, blocks, connections);
    if (chain.length > 0) chain[chain.length - 1].next_block = cloned;
    chain.push(cloned);
    const nextConn = findConnection(connections[currentId], "next");
    currentId = nextConn ? nextConn.blockId : null;
  }
  return chain;
}

function findConnection(connMap, type, inputName) {
  for (const [targetId, conn] of Object.entries(connMap || {})) {
    if (conn.type === type && (type !== "input" || !inputName || conn.input_name === inputName)) {
      return { blockId: targetId, ...conn };
    }
  }
  return null;
}

function cloneWithChildren(block, blocks, connections) {
  const cloned = JSON.parse(JSON.stringify(block));
  const conns = connections[block.id] || {};
  const statementInputs = Object.entries(conns)
    .filter(([, c]) => c.type === "input" && c.input_type === "statement")
    .map(([targetId, c]) => ({ targetId, name: c.input_name }));
  if (statementInputs.length > 0) {
    const first = statementInputs[0];
    const chain = buildChain(first.targetId, blocks, connections);
    if (chain.length > 0) cloned.child_block = chain;
  }
  if (statementInputs.length > 1) {
    cloned.__extraStatements = statementInputs.map(s => ({ name: s.name, chain: buildChain(s.targetId, blocks, connections) }));
  }
  const valueInputs = Object.entries(conns)
    .filter(([, c]) => c.type === "input" && c.input_type === "value")
    .map(([targetId, c]) => ({ targetId, name: c.input_name }));
  cloned.params = cloned.params || {};
  for (const [k, v] of Object.entries(block.fields || {})) {
    cloned.params[k] = v;
  }
  for (const vi of valueInputs) {
    const target = blocks[vi.targetId];
    if (target) cloned.params[vi.name] = cloneWithChildren(target, blocks, connections);
  }
  return cloned;
}

module.exports = { blockDataJsonToChains };
