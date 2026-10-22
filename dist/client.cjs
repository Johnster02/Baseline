/* Baseline engine. Built from src/ by scripts/build.mjs. Do not edit. */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/browser/client.ts
var client_exports = {};
__export(client_exports, {
  open: () => open
});
module.exports = __toCommonJS(client_exports);

// src/browser/rpc.ts
var COMMANDS = [
  "open",
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "hover",
  "back",
  "waitFor",
  "snapshot",
  "text",
  "url",
  "title",
  "shot",
  "created",
  "close"
];

// src/browser/client.ts
var seq = 0;
var pending = /* @__PURE__ */ new Map();
function call(method, ...args) {
  if (!process.send) return Promise.reject(new Error("Run this through `baseline script <runner> <file>`."));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ id, method, args });
  });
}
process.on("message", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error));
});
async function open() {
  const info = await call("open");
  const api = { runner: info.runner, persona: info.persona, depth: info.depth };
  for (const c of COMMANDS) if (c !== "open") api[c] = (...a) => call(c, ...a);
  api.call = (method, ...a) => call(method, ...a);
  api.close = async () => {
    await call("close");
    process.disconnect?.();
  };
  return api;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  open
});
