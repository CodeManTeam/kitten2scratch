"use strict";

/**
 * Small XML reader for Kitten's Blockly XML.
 *
 * K3 stores the translated Scratch workspace as an XML fragment in
 * scene/actor.blocksXML. Keeping this reader local avoids making the CLI
 * depend on a browser DOM implementation.
 */

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(source))) attrs[match[1]] = decodeXml(match[2] ?? match[3]);
  return attrs;
}

function parseXmlFragment(xml) {
  const root = { name: "root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const input = String(xml || "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const tokenRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<([^>]+)>|([^<]+)/g;
  let match;
  while ((match = tokenRe.exec(input))) {
    const parent = stack[stack.length - 1];
    if (match[1] !== undefined) {
      parent.text += match[1];
      continue;
    }
    if (match[3] !== undefined) {
      parent.text += decodeXml(match[3]);
      continue;
    }

    const raw = match[2].trim();
    if (!raw || raw.startsWith("!")) continue;
    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameMatch = body.match(/^([^\s/>]+)/);
    if (!nameMatch) continue;
    const node = { name: nameMatch[1], attrs: parseAttributes(body.slice(nameMatch[0].length)), children: [], text: "" };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function children(node, name) {
  return (node.children || []).filter(child => child.name === name);
}

function firstChild(node, name) {
  return children(node, name)[0] || null;
}

function firstBlock(node) {
  if (!node) return null;
  return (node.children || []).find(child => child.name === "block" || child.name === "shadow") || null;
}

function textValue(node) {
  return (node.text || "").trim();
}

function xmlBlockToKitten(node) {
  if (!node || (node.name !== "block" && node.name !== "shadow")) return null;
  const type = node.attrs.type || "unknown";
  const block = {
    type,
    id: node.attrs.id || `${type}_${xmlBlockToKitten.nextId++}`,
    params: {},
    child_block: [],
    next_block: null,
    conditions: [],
    if_dropdown_conditions: [],
    procedure_name: "",
  };

  for (const field of children(node, "field")) {
    if (field.attrs.name) block.params[field.attrs.name] = textValue(field);
  }

  const mutation = firstChild(node, "mutation");
  if (mutation) {
    block.mutation = {
      name: mutation.attrs.name || "",
      name_value: mutation.attrs.name_value || "",
      args: children(mutation, "arg").map(arg => arg.attrs.name || textValue(arg)),
    };
    if (mutation.attrs.name) block.procedure_name = mutation.attrs.name;
  }

  for (const value of children(node, "value")) {
    const nested = firstBlock(value);
    if (nested) {
      const converted = xmlBlockToKitten(nested);
      if (converted) block.params[value.attrs.name || "VALUE"] = converted;
    }
  }

  const statements = children(node, "statement");
  const convertedStatements = [];
  for (const statement of statements) {
    const nested = firstBlock(statement);
    if (!nested) continue;
    const converted = xmlBlockToKitten(nested);
    if (!converted) continue;
    convertedStatements.push({ name: statement.attrs.name || "DO", chain: [converted] });
  }
  if (convertedStatements.length) {
    block.child_block = convertedStatements[0].chain;
    if (convertedStatements.length > 1) block.__extraStatements = convertedStatements;
  }

  const next = firstChild(node, "next");
  const nextBlock = firstBlock(next);
  if (nextBlock) block.next_block = xmlBlockToKitten(nextBlock);
  return block;
}

function parseBlocksXml(xml) {
  const root = parseXmlFragment(xml);
  const container = (root.children || []).find(node => node.name === "xml") || root;
  return (container.children || [])
    .filter(node => node.name === "block")
    .map(xmlBlockToKitten)
    .filter(Boolean);
}

xmlBlockToKitten.nextId = 1;

module.exports = { parseBlocksXml, parseXmlFragment, xmlBlockToKitten };
