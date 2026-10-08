import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../web/novnc/patch-novnc.mjs", import.meta.url));

async function buildFixture(root) {
  await mkdir(join(root, "core"), { recursive: true });
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(
    join(root, "vnc.html"),
    '<!doctype html><html><body><script src="app/ui.js"></script></body></html>',
  );
  await writeFile(
    join(root, "core", "rfb.js"),
    "export const x = pseudoEncodingQualityLevel0 + 0;\nexport const y = pseudoEncodingCompressLevel0 + 0;\n",
  );
  await writeFile(join(root, "app", "ui.js"), 'import { RFB } from "../core/rfb.js";\n');
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), `samewindow-patch-novnc-${prefix}-`));
}

function runPatch(target, roots) {
  return execFileSync(process.execPath, [SCRIPT, target], {
    encoding: "utf8",
    env: { ...process.env, SAMEWINDOW_NOVNC_ROOTS: roots.join(delimiter) },
  });
}

test("patches vnc.html, rfb.js, and ui.js when target is inside an allowed root", async () => {
  const directory = await tempDir("happy");
  try {
    await buildFixture(directory);
    const output = runPatch(join(directory, "vnc.html"), [directory]);
    assert.match(output, /Patched/);

    const html = await readFile(join(directory, "vnc.html"), "utf8");
    assert.match(html, /<script src="\/user-cursor\.js"><\/script>/);
    assert.match(html, /src="app\/ui\.js\?samewindow-quality-4-compression-5"/);

    const rfb = await readFile(join(directory, "core", "rfb.js"), "utf8");
    assert.match(rfb, /pseudoEncodingQualityLevel0 \+ 4/);
    assert.match(rfb, /pseudoEncodingCompressLevel0 \+ 5/);

    const ui = await readFile(join(directory, "app", "ui.js"), "utf8");
    assert.match(ui, /\.\.\/core\/rfb\.js\?samewindow-quality-4-compression-5/);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "samewindow-patch-novnc-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a target outside any allowed root", async () => {
  const allowed = await tempDir("allow");
  const outside = await tempDir("outside");
  try {
    await buildFixture(allowed);
    await buildFixture(outside);
    assert.throws(
      () => runPatch(join(outside, "vnc.html"), [allowed]),
      /Refusing to patch/,
    );
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects a traversal-style argv escaping the allowed root", async () => {
  const directory = await tempDir("traversal");
  const escape = await tempDir("escape");
  try {
    await buildFixture(directory);
    await buildFixture(escape);
    // "<allowedRoot>/../<escapeDirName>/vnc.html" normalizes (via path.resolve)
    // to a real path outside the allowed root.
    const escapeName = escape.split(/[\\/]/).pop();
    const traversalArg = join(directory, "..", escapeName, "vnc.html");
    assert.throws(
      () => runPatch(traversalArg, [directory]),
      /Refusing to patch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(escape, { recursive: true, force: true });
  }
});

test("rejects vnc.html that is a symlink pointing outside the allowed root", async () => {
  const allowed = await tempDir("symlink-allow");
  const outside = await tempDir("symlink-outside");
  try {
    await buildFixture(outside);
    await symlink(join(outside, "vnc.html"), join(allowed, "vnc.html"));
    assert.throws(
      () => runPatch(join(allowed, "vnc.html"), [allowed]),
      /Refusing to patch/,
    );
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects derived core/rfb.js that is a symlink pointing outside the root", async () => {
  const allowed = await tempDir("derived-allow");
  const outside = await tempDir("derived-outside");
  try {
    await buildFixture(allowed);
    await mkdir(join(outside, "core"), { recursive: true });
    await writeFile(
      join(outside, "core", "rfb.js"),
      "export const x = pseudoEncodingQualityLevel0 + 0;\nexport const y = pseudoEncodingCompressLevel0 + 0;\n",
    );
    await rm(join(allowed, "core", "rfb.js"));
    await symlink(join(outside, "core", "rfb.js"), join(allowed, "core", "rfb.js"));
    assert.throws(
      () => runPatch(join(allowed, "vnc.html"), [allowed]),
      /escapes allowed root/,
    );
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
