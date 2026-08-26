import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBaseUrl } from "../src/hostedLink.js";

test("a bare host normalizes to https and schemes stay explicit", () => {
  assert.equal(normalizeBaseUrl("passport.ego.ist"), "https://passport.ego.ist");
  assert.equal(normalizeBaseUrl("https://passport.ego.ist/"), "https://passport.ego.ist");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normalizeBaseUrl("http://passport.ego.ist"), /invalid_base_url/);
});
