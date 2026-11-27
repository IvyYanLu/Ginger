import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLine } from "../lib/square.js";

const item = {
  id: "I", name: "Roll",
  variations: [{ id: "V4", label: "4 pc", price: 500, soldOut: true }, { id: "V8", label: "8 pc", price: 900, soldOut: false }],
  modifierLists: [
    { id: "RICE", name: "Rice", min: 1, max: 1, modifiers: [{ id: "W" }, { id: "B" }] },
    { id: "TOP", name: "Toppings", min: 0, max: 2, modifiers: [{ id: "T1" }, { id: "T2" }, { id: "T3" }] },
    { id: "ANY", name: "Extras", min: 0, max: null, modifiers: [{ id: "X1" }, { id: "X2" }] },
  ],
};
export const cases = [
  ["valid", [item, "V8", ["W"], 1], null],
  ["valid with max and unlimited lists", [item, "V8", ["B", "T1", "T3", "X1", "X2"], 20], null],
  ["missing item", [undefined, "V8", [], 1], /no longer available/],
  ["variation not on item", [item, "OTHER", ["W"], 1], /no longer available in that size/],
  ["sold out", [item, "V4", ["W"], 1], /Roll \(4 pc\) is sold out/],
  ["qty 0", [item, "V8", ["W"], 0], /1 to 20/],
  ["qty 21", [item, "V8", ["W"], 21], /1 to 20/],
  ["qty fractional", [item, "V8", ["W"], 1.5], /1 to 20/],
  ["qty string", [item, "V8", ["W"], "2"], /1 to 20/],
  ["duplicate modifier", [item, "V8", ["W", "T1", "T1"], 1], /selected twice/],
  ["unknown modifier", [item, "V8", ["W", "ZZ"], 1], /option for Roll is no longer available/],
  ["below min", [item, "V8", [], 1], /Choose an option for Rice/],
  ["above max (radio)", [item, "V8", ["W", "B"], 1], /at most 1 for Rice/],
  ["above max (checkbox)", [item, "V8", ["W", "T1", "T2", "T3"], 1], /at most 2 for Toppings/],
];

test("validateLine", () => {
  for (const [name, args, want] of cases) {
    const got = validateLine(...args);
    if (want === null) assert.equal(got, null, name);
    else assert.match(got ?? "", want, name);
  }
});
