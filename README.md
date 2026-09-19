# 🐱 kitten2scratch

> A robust, dependency-light CLI converter to translate Codemao Kitten ecosystems (Kitten3, Kitten4, KittenN) into standard Scratch 3.0 / TurboWarp (`.sb3`) project archives.

## 📖 Overview

Codemao's proprietary platforms (Kitten) utilize specialized formats to store block-based code. `kitten2scratch` serves as a universal bridge, capable of deeply analyzing these closed formats, translating their logic architectures, and emitting standard `.sb3` files that can be directly executed in Scratch 3.0 or TurboWarp.

## 🏗 System Architecture

The core logic relies on a strictly decoupled **Three-Layer Pipeline**:

```text
[ Input: .bcm / .bcm4 / .bcmc / .bcmkn / .json ]
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 1. Parser Layer (Format Detection & Normalization)     │
│   ├─ Kitten3 Parser (XML/JSON hybrid, AST parsing)     │
│   ├─ Kitten4 Parser (domain_block / responder_block)   │
│   └─ KittenN Parser (nekoBlockJsonList)                │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 2. IR Layer (Intermediate Representation)              │
│   ├─ Project -> Target(s) -> Script(s) -> Block(s)     │
│   └─ Resolves variables, lists, procedures, broadcasts │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 3. Emitter Layer (Target Generator)                    │
│   ├─ Block Mapper (Maps IR blocks to Scratch opcodes)  │
│   ├─ Asset Bundler (Fetches/packs CDN & base64 assets) │
│   └─ SB3 Packager (Generates project.json & zips)      │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
                  [ Output: .sb3 ]
```

## 🧠 Format Specifications & Handlers

Codemao's ecosystem has evolved significantly. This tool handles three major generations:

### 1. Kitten3 (Legacy)
- **Identifiers**: `application_version` 3.x, `blocksXML`, `.bcmc`.
- **Canvas System**: `960x720` resolution.
- **Complexity**: Stores data as either XML or `compile_result`. The parser implements a headless XML reader to parse nodes into the IR. It scales coordinates (`x / 2`, `y / 2`) and translates directions from Radians to Degrees.

### 2. Kitten4 (Modern)
- **Identifiers**: `.bcm4`, `.bcm`, `block_data_json`.
- **Complexity**: Uses a node-graph approach with `domain_block` and `responder_block` chains. Requires traversing node connections to reconstruct the sequential script logic.

### 3. KittenN (Mobile/Neko)
- **Identifiers**: `.bcmkn`, `nekoBlockJsonList`.
- **Complexity**: Highly nested JSON structure with encrypted `.bcmkn` wrappers (Requires external Python decryption tool `tools/decrypt_bcmkn.py` before feeding into this CLI).

## ⚙️ Core Translation Mechanics

- **Coordinate Scaling**: K3 coordinates are divided by 2 to fit Scratch's `480x360` stage.
- **Angle Conversion**: K3 rotation is in radians. Formula: `degree = (radian * 180) / PI`.
- **Placeholder Degradation**: Codemao-specific blocks (e.g., physics engine, complex hardware APIs) are preserved as `kitten2scratch_placeholder` blocks to ensure visual continuity and prevent data loss.
- **Nested Expressions**: Deeply nested operations (e.g., `(a + (b * c))`) are resolved recursively in `ir.js` and flattened into Scratch's flat block dictionary using unique UUIDs.
- **Substacks**: C-blocks (If-Else, Repeat, Forever) are mapped to Scratch's `SUBSTACK` and `SUBSTACK2` inputs.

## 👨‍💻 Developer Guide: Extending the Block Map

To add support for a new block, modify `src/block_map.js`. The mapper maps Codemao opcodes to Scratch opcodes and defines input/field mappings.

```javascript
// Example: Mapping Kitten4's 'motion_movesteps' to Scratch's 'motion_movesteps'
"motion_movesteps": {
    opcode: "motion_movesteps",
    inputs: {
        "STEPS": "STEPS" // Map Codemao's input key to Scratch's input key
    }
}
```

## 🚀 Installation & Usage

**Prerequisites**: Node.js v14+

```bash
git clone https://github.com/yourusername/kitten2scratch.git
cd kitten2scratch
npm install
```

**CLI Execution**:

```bash
# Standard conversion (Auto-detects format)
node cli.js path/to/project.json output.sb3

# Run the test suite
npm test
```

## 📊 Feature Matrix & Roadmap

| Subsystem | Status | Technical Details |
| :--- | :---: | :--- |
| **Control Flow** | ✅ | If/Else, Repeat, Forever, Stop scripts mapped perfectly. |
| **Data (Var/List)** | ✅ | Scope resolution (Global vs Local) handled via Target tracking. |
| **Procedures** | ✅ | Custom block definitions & calls are fully reconstructed. |
| **Clones** | ✅ | `control_start_as_clone` and `control_create_clone_of` supported. |
| **Asset Fetching** | ✅ | Async downloader fetches `.png`/`.svg`/`.wav` from Codemao CDNs. |
| **Procedure Args** | ⏳ | Argument wiring (String/Number/Boolean inputs) needs mutation support. |
| **Cloud Variables** | ⏳ | To be mapped to TurboWarp's `☁` variable syntax. |
| **Scene Transitions**| ⏳ | Needs synthesis into Scratch `broadcast` equivalents. |

## 🛠 Tech Stack

- **Runtime**: Node.js (CommonJS)
- **Core Dependencies**: `jszip` (for archive creation)
- **Testing**: Native Node.js `assert` module via `test/run_tests.js`.

## 📄 License

[MIT](LICENSE)