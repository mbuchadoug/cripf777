// ==============================
// 🩹 PATCH: node-routeros "!empty" crash on RouterOS 7.20+
//
// RouterOS 7.20+ answers "!empty" to prints that return no rows. The
// node-routeros library doesn't know that reply, so it THROWS on a socket
// event — which escapes all try/catch and kills the whole process.
//
// This script rewrites the library's Channel.js so "!empty" is treated the
// same as "!done" (a normal "finished, no rows" reply). It's safe to run
// repeatedly and is idempotent.
//
// Run it once now:            node hotspot/patch-node-routeros.js
// And after every install by adding to package.json "scripts":
//     "postinstall": "node hotspot/patch-node-routeros.js"
// ==============================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find node_modules/node-routeros/dist/Channel.js walking up from here.
function findChannel() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "node_modules", "node-routeros", "dist", "Channel.js");
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  return null;
}

const target = findChannel();
if (!target) {
  console.log("[patch] node-routeros not found — skipping (nothing to patch)");
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");

if (src.includes("/* !empty patched */")) {
  console.log("[patch] node-routeros already patched ✅");
  process.exit(0);
}

// Turn the "default: emit unknown" branch into one that treats !empty as done.
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

if (!src.includes(needle)) {
  console.log("[patch] ⚠️  expected code block not found — library version may differ. No change made.");
  process.exit(0);
}

src = src.replace(needle, replacement);
fs.writeFileSync(target, src, "utf8");
console.log("[patch] node-routeros patched for !empty ✅  (" + target + ")");