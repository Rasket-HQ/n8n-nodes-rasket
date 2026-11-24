/**
 * `npm run scan` (or `pnpm run scan`): the offline half of n8n's verification for community nodes
 * (N8N-01).
 *
 * `npx @n8n/scan-community-package n8n-nodes-rasket` takes only a published version: it checks the
 * npm provenance, downloads the attested GitHub source and the npm tarball, and lints both. Before
 * anything is published this script does the same to what would be published:
 *
 * 1. `run build`, then `pack` into a temporary folder. pnpm when package.json has a `workspace:`
 *    version (only `pnpm pack` rewrites those), npm otherwise, as in the public mirror the package
 *    is published from (`export-mirror.mjs`).
 * 2. The packed package.json: no `workspace:` left, no runtime `dependencies`, and the tarball holds
 *    only `dist/`, the README, the licence and the changelog.
 * 3. Every path in the `n8n` section loads under plain Node from the unpacked tarball, its class
 *    instantiates with the expected name, and the icon files it names exist beside it.
 * 4. The scanner's own `lintDirectory` (from `@n8n/scan-community-package`) on the source —
 *    `nodes/`, `credentials/` and package.json, as it lints the GitHub checkout — and on the tarball's
 *    `**\/*.js` and package.json. Its warnings are listed too; only errors fail verification.
 * 5. The docs page's list of operations and trigger events (`operations.json` beside
 *    `/docs/integrations/n8n`, N8N-02) names exactly the nodes' own, so a renamed, added or removed
 *    operation fails here rather than on the published page. It is read as data, never imported
 *    (`apps/web` and this package do not depend on each other), and skipped outside the monorepo.
 *
 * `--out <dir>` copies the tarball it inspected into `<dir>` before the temporary folder goes, so
 * the mirror's `publish-n8n.yml` uploads that file and never a second pack (N8N-02).
 *
 * Exits 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// The scanner has no `exports` map; `dist/scanner.js` is the module its own CLI runs (0.44.0 moved
// it from `scanner/scanner.mjs` and renamed `analyzePackage` to `lintDirectory`).
import {
  buildScanConfig,
  lintDirectory,
  SOURCE_FILE_PATTERNS,
} from "@n8n/scan-community-package/dist/scanner.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const failures = [];

/** pnpm only where it is needed: a `workspace:` version, which `npm pack` would publish as is. */
const manager = readFileSync(path.join(root, "package.json"), "utf8").includes('"workspace:')
  ? "pnpm"
  : "npm";

const outFlag = process.argv.indexOf("--out");
const outDir = outFlag === -1 ? undefined : process.argv[outFlag + 1];
if (outFlag !== -1 && (outDir === undefined || outDir.startsWith("--"))) {
  throw new Error("--out needs a directory");
}

/** The docs page's list, in the monorepo only: a public mirror of this package has no apps/web. */
const DOCS_OPERATIONS = path.resolve(
  root,
  "../../apps/web/app/(docs)/docs/integrations/n8n/operations.json",
);

/** The display names of an `options`/`multiOptions` property's choices. */
function optionNames(property) {
  return (property?.options ?? []).map((option) => option.name).sort();
}

function sameList(documented, defined, what) {
  const missing = defined.filter((name) => !documented.includes(name));
  const extra = documented.filter((name) => !defined.includes(name));
  check(
    missing.length === 0 && extra.length === 0,
    `the docs page lists exactly ${what}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}${extra.length > 0 ? `; not in the node: ${extra.join(", ")}` : ""}`,
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
  return result.stdout;
}

function check(ok, message) {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
}

const work = mkdtempSync(path.join(tmpdir(), "n8n-nodes-rasket-scan-"));
try {
  // 1. Build and pack.
  run(manager, ["run", "build"], root);
  run(manager, ["pack", "--pack-destination", work], root);
  const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`${manager} pack wrote no tarball`);
  const unpacked = path.join(work, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", path.join(work, tarball), "-C", unpacked, "--strip-components=1"], work);
  console.log(`Packed ${tarball} with ${manager}`);

  // 2. The published package.json and file list.
  const packedJson = readFileSync(path.join(unpacked, "package.json"), "utf8");
  const pkg = JSON.parse(packedJson);
  check(!packedJson.includes("workspace:"), "the packed package.json has no workspace: versions");
  check(
    Object.keys(pkg.dependencies ?? {}).length === 0,
    "the packed package.json has no dependencies",
  );
  const listing = run("tar", ["-tzf", path.join(work, tarball)], work)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^package\//, ""));
  const stray = listing.filter(
    (file) =>
      !file.startsWith("dist/") &&
      !["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(file),
  );
  check(
    stray.length === 0,
    `the tarball holds only dist/ and the docs${stray.length === 0 ? "" : `: ${stray.join(", ")}`}`,
  );

  // 3. Every node and credential loads from the tarball under plain Node, as n8n's loader does.
  // n8n provides n8n-workflow at runtime; here it is linked in from this package's devDependencies.
  mkdirSync(path.join(work, "node_modules"));
  symlinkSync(
    path.dirname(require.resolve("n8n-workflow/package.json")),
    path.join(work, "node_modules", "n8n-workflow"),
  );
  const load = createRequire(path.join(unpacked, "package.json"));
  const descriptions = {};
  for (const file of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
    const loaded = load(path.join(unpacked, file));
    const className = path.basename(file).split(".")[0];
    const Class = loaded[className];
    check(typeof Class === "function", `${file} exports ${className}`);
    if (typeof Class !== "function") continue;
    const instance = new Class();
    const description = instance.description ?? instance;
    descriptions[className] = description;
    const icon = description.icon;
    const icons = typeof icon === "string" ? [icon] : [icon?.light, icon?.dark];
    for (const ref of icons) {
      const iconPath = path.join(
        path.dirname(path.join(unpacked, file)),
        String(ref).replace(/^file:/, ""),
      );
      check(
        typeof ref === "string" && existsSync(iconPath),
        `${className}'s icon ${String(ref)} is in the tarball`,
      );
    }
  }

  // 4. n8n's scanner rules, on the source and on the tarball.
  const source = await lintDirectory(root, SOURCE_FILE_PATTERNS);
  check(source.passed, "n8n's scanner passes the source (nodes/, credentials/, package.json)");
  if (!source.passed) console.log(source.details ?? source.message);
  const dist = await lintDirectory(unpacked, ["**/*.js", "package.json"]);
  check(dist.passed, "n8n's scanner passes the tarball (**/*.js, package.json)");
  if (!dist.passed) console.log(dist.details ?? dist.message);

  // The scanner only reports errors; its warn-level rules are shown here so they stay at zero.
  const { ESLint } = createRequire(require.resolve("@n8n/scan-community-package/dist/scanner.js"))(
    "eslint",
  );
  const eslint = new ESLint({
    cwd: root,
    allowInlineConfig: false,
    overrideConfigFile: true,
    overrideConfig: await buildScanConfig(),
  });
  const results = await eslint.lintFiles([
    "package.json",
    "nodes/**/*.{js,ts,json}",
    "credentials/**/*.{js,ts,json}",
  ]);
  const warnings = results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 1)
      .map(
        (message) =>
          `${path.relative(root, result.filePath)}:${String(message.line)} ${message.ruleId}: ${message.message}`,
      ),
  );
  console.log(
    warnings.length === 0
      ? "✓ no scanner warnings"
      : `! ${String(warnings.length)} scanner warnings:\n  ${warnings.join("\n  ")}`,
  );

  // 5. The docs page's operations and events are the nodes' own.
  if (existsSync(DOCS_OPERATIONS)) {
    const docs = JSON.parse(readFileSync(DOCS_OPERATIONS, "utf8"));
    const properties = descriptions.Rasket?.properties ?? [];
    const resources = properties.find((property) => property.name === "resource");
    sameList(
      docs.resources.map((entry) => entry.resource).sort(),
      optionNames(resources),
      "the Rasket node's resources",
    );
    for (const { name, value } of resources?.options ?? []) {
      const operations = properties.find(
        (property) =>
          property.name === "operation" && property.displayOptions?.show?.resource?.[0] === value,
      );
      const entry = docs.resources.find((candidate) => candidate.resource === name);
      sameList(
        (entry?.operations ?? []).map((operation) => operation.name).sort(),
        optionNames(operations),
        `the ${name} operations`,
      );
    }
    const events = (descriptions.RasketTrigger?.properties ?? []).find(
      (property) => property.name === "events",
    );
    sameList(
      docs.events.map((event) => event.name).sort(),
      optionNames(events),
      "the Rasket Trigger's events",
    );
  } else {
    console.log("- the docs page's operations list is not here (outside the monorepo); skipped");
  }

  // Only a tarball that passed everything above leaves the temporary folder.
  if (outDir !== undefined && failures.length === 0) {
    mkdirSync(outDir, { recursive: true });
    copyFileSync(path.join(work, tarball), path.join(outDir, tarball));
    console.log(`Copied ${tarball} to ${outDir}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
