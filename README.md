# kitten2scratch

Kitten / Kitten4 / KittenN to Scratch (TurboWarp) converter.

## Quick Start

```bash
# Kitten4 (.bcm4 / .bcm / plain JSON with theatre + compile_result)
node cli.js ../mirror/workids/173534122/project/project.local.json output.sb3

# KittenN (.bcmkn — decrypt first with tools/decrypt_bcmkn.py)
node cli.js ../analysis/decrypted_bcmkn/FpAWKY5SQeJ4VnIMZG9V0wvmTUaW.pretty.json output.sb3
```

## Architecture

Three-layer pipeline:

1. **Parser** — `src/parse_kitten4.js` and `src/parse_kittenn.js`
   normalize each format into a Unified Block IR.
2. **IR** — `src/ir.js` defines the intermediate representation:
   Project -> Target(s) -> Script(hat + chain of blocks).
3. **Emitter** — `src/emit_sb3.js` serializes IR to Scratch 3 `project.json`
   and packages into a `.sb3` zip via JSZip.

Block type mapping lives in `src/block_map.js` (~90 entries covering
events, control, motion, looks, sound, pen, sensing, operators,
variables, lists, procedures, clones, and stage/screen).

## Status

- [x] Kitten4 parser (compile_result chain, procedures, variables, broadcasts)
- [x] KittenN parser (nekoBlockJsonList, shadow XML, fields/inputs)
- [x] IR model with nested expressions and branches
- [x] sb3 emitter with literal shadows, expression blocks, substacks
- [x] Extension detection (pen)
- [x] CLI with format auto-detection
- [ ] Asset packing (fetch SVG/PNG/MP3 and embed into sb3)
- [ ] Procedure mutation full support (argument wiring)
- [ ] Cloud variable handling for TurboWarp
- [ ] Screen-switch to broadcast synthesis
- [ ] TurboWarp-specific extensions (cloud, extra opcodes)

## Test Results

Kitten4 test (project.local.json from workid 173534122):
228 targets, 5796 blocks, 113 variables, 55 unique opcodes, pen extension.

KittenN test (decrypted .bcmkn from workid 310414486):
13 targets, 81 blocks, 1 variable.
