import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONTRACT_SHA256 } from "./contract.js";

const source = readFileSync(new URL("./contract.ts", import.meta.url), "utf8");
const marker = "// --- contract-hash: everything above this line is hashed ---";
assert.equal(createHash("sha256").update(source.split(marker)[0], "utf8").digest("hex").slice(0, 32), CONTRACT_SHA256);
console.log("contract: hash matches canonical copy");
