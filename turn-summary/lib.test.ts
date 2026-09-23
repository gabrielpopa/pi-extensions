import assert from "node:assert/strict";
import { countDiff, duration, finish, isEmpty, newAcc, parts, record } from "./lib.ts";

const patch = `--- a/x.ts
+++ b/x.ts
@@
 const a = 1
-const b = 2
+const b = 3
+const c = 4`;

assert.deepEqual(countDiff(patch), [2, 1]);

const acc = newAcc(0);
record(acc, "edit", { path: "/repo/src/x.ts" }, { patch }, false);
record(acc, "read", { path: "/repo/src/y.ts" }, undefined, false);
record(acc, "grep", { pattern: "foo" }, undefined, false);
record(acc, "bash", { command: "npm test\nmore" }, undefined, true);

const s = finish(acc, 65_000);
assert.equal(isEmpty(s), false);
assert.deepEqual(parts(s), ["edited x.ts +2 -1", "ran npm test", "2 looked up", "1m 5s", "1 failed"]);

const written = newAcc(0);
record(written, "write", { path: "/repo/a.md", content: "l1\nl2" }, undefined, false);
assert.deepEqual(parts(finish(written, 1_000)), ["edited a.md +2 -0", "1.0s"]);
assert.equal(duration(9_400), "9.4s");

const empty = finish(newAcc(10), 10);
assert.equal(isEmpty(empty), true);
assert.deepEqual(parts(empty), ["0.0s"]);

console.log("turn-summary lib ok");
