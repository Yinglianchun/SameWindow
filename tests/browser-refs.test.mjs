import assert from "node:assert/strict";
import test from "node:test";

import {
  ElementRefRegistry,
  resolvePageReference,
  snapshotElementRef,
} from "../src/browser-refs.mjs";

test("snapshot-scoped element refs cannot rebind to a newer snapshot", () => {
  const registry = new ElementRefRegistry();
  const page = {};
  const firstRef = snapshotElementRef("s1", 0);
  const secondRef = snapshotElementRef("s2", 0);

  registry.begin("s1");
  registry.commit("s1", [
    { ref: firstRef, page, selector: "[data-ref='button-a']" },
  ]);
  registry.begin("s2");
  registry.commit("s2", [
    { ref: secondRef, page, selector: "[data-ref='button-b']" },
  ]);

  assert.equal(firstRef, "s1:e1");
  assert.equal(secondRef, "s2:e1");
  assert.throws(
    () => registry.resolve(firstRef, page),
    /element ref s1:e1 is stale; take a fresh snapshot/,
  );
  assert.equal(registry.resolve(secondRef, page).selector, "[data-ref='button-b']");
});

test("superseded snapshot cannot repopulate the element-ref registry", () => {
  const registry = new ElementRefRegistry();
  const page = {};

  registry.begin("s1");
  registry.begin("s2");
  registry.commit("s2", [
    { ref: "s2:e1", page, selector: "[data-ref='button-b']" },
  ]);

  assert.throws(
    () => registry.commit("s1", [
      { ref: "s1:e1", page, selector: "[data-ref='button-a']" },
    ]),
    /snapshot was superseded; take a fresh snapshot/,
  );
  assert.throws(
    () => registry.resolve("s1:e1", page),
    /element ref s1:e1 is stale; take a fresh snapshot/,
  );
  assert.equal(registry.resolve("s2:e1", page).selector, "[data-ref='button-b']");
});

test("strict tab resolution rejects an unknown explicit tab ref", () => {
  const firstPage = { isClosed: () => false };
  const pages = [firstPage];

  assert.throws(
    () => resolvePageReference(
      "tab-old",
      new Map(),
      pages,
      firstPage,
      true,
    ),
    /browser tab ref tab-old is stale; take a fresh snapshot/,
  );
});
