// ==============================
// 🩹 PATCH: node-routeros crashes on RouterOS 7.20+
//
// RouterOS 7.20+ sends reply sequences the node-routeros library doesn't
// expect, and it THROWS on raw socket events - which escape every try/catch
// and kill the whole Node process. Two spots need fixing:
//
//   1. Channel.js   → "!empty" reply falls into default: and throws.
//   2. Receiver.js  → a leftover packet for an already-finished request
//                     ("unregistered tag") throws instead of being ignored.
//
// This script rewrites both to fail safe. It is idempotent (safe to run
// repeatedly) and prints what it changed.
//
// Run once:   node hotspot/patch-node-routeros.js
// Make permanent - add to package.json "scripts":
//     "postinstall": "node hotspot/patch-node-routeros.js"
// ==============================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findLib(rel) {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "node_modules", "node-routeros", "dist", rel);
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  return null;
}

let changed = 0;

// ── Patch 1: Channel.js - treat "!empty" like "!done" ──
(() => {
  const target = findLib("Channel.js");
  if (!target) { console.log("[patch] Channel.js not found - skipping"); return; }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes("/* !empty patched */")) { console.log("[patch] Channel.js already patched"); return; }

  const needle = `            default:
                this.emit('unknown', reply);
                this.close();
                break;`;
  const replacement = `            case '!empty': /* !empty patched */
                if (!this.trapped)
                    this.emit('done', this.data);
                this.close();
                break;
            default:
                this.emit('unknown', reply);
                this.close();
                break;`;

  if (!src.includes(needle)) { console.log("[patch] Channel.js shape differs - not changed"); return; }
  fs.writeFileSync(target, src.replace(needle, replacement), "utf8");
  console.log("[patch] Channel.js patched for !empty");
  changed++;
})();

// ── Patch 2: Receiver.js - ignore orphan/unregistered-tag replies ──
(() => {
  const target = findLib("connector/Receiver.js");
  if (!target) { console.log("[patch] Receiver.js not found - skipping"); return; }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes("/* unregistered tag patched */")) { console.log("[patch] Receiver.js already patched"); return; }

  const needle = `        else {
            throw new RosException_1.RosException('UNREGISTEREDTAG');
        }`;
  const replacement = `        else {
            /* unregistered tag patched */
            return;
        }`;

  if (!src.includes(needle)) { console.log("[patch] Receiver.js shape differs - not changed"); return; }
  fs.writeFileSync(target, src.replace(needle, replacement), "utf8");
  console.log("[patch] Receiver.js patched for unregistered tag");
  changed++;
})();

console.log(changed ? `[patch] done - ${changed} file(s) patched` : "[patch] nothing to change (already patched)");