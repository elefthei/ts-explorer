import { expect, test } from "bun:test";
import { canonicalScopeKey } from "../src/uml/keys.ts";

test("canonical scope keys share the occurrence-zero namespace identity", () => {
  expect(canonicalScopeKey('["a.ts","namespace","Outer.Inner",7]'))
    .toBe('["a.ts","namespace","Outer.Inner",0]');
  expect(canonicalScopeKey('["lib.rs","module","inner",2]'))
    .toBe('["lib.rs","module","inner",0]');
});

test("canonical scope keys leave file scope and malformed keys unchanged", () => {
  for (const key of ["", "not-json", "null", "{}", "[]", '["a.ts","namespace","N"]']) {
    expect(canonicalScopeKey(key)).toBe(key);
  }
});
