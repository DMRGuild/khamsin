// One shared Eta instance per isolate, loaded with the PRECOMPILED template
// functions from src/templates.gen.mjs (built by scripts/build-templates.mjs
// — the Workers runtime disallows new Function, so templates cannot compile
// at request time). Template names are "@"-prefixed: on eta v4 that skips
// every filesystem-resolution path. Skin CSS is bundled as plain text
// (wrangler [[rules]]) — no code generation involved.

import { Eta } from "eta";
// deno-lint-ignore-file — generated module, plain JS.
// @ts-ignore generated at build time by scripts/build-templates.mjs
import { templates } from "./templates.gen.mjs";

import blackboard from "../skins/blackboard.css";
import chan from "../skins/chan.css";
import corp from "../skins/corp.css";
import dark from "../skins/dark.css";
import harvest from "../skins/harvest.css";

/** Skin CSS by name; unknown names render with no skin (base styles only). */
export const SKINS: Record<string, string> = {
  blackboard,
  chan,
  corp,
  dark,
  harvest,
};

let _eta: Eta | null = null;

export function getEta(): Eta {
  if (_eta) return _eta;
  // Options must match scripts/build-templates.mjs — escaping is baked into
  // the compiled functions, but include()/render() still read this config.
  const eta = new Eta({ autoEscape: true });
  for (const [name, fn] of Object.entries(templates)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eta.loadTemplate(name, fn as any);
  }
  _eta = eta;
  return eta;
}
