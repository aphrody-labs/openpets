// One-shot pnpm -> Bun migration for the OpenPets workspace (aphrody-labs fork).
// Rewrites package.json scripts and CI workflows, moves pnpm build allowances to
// trustedDependencies, and sets packageManager. Re-runnable: already-migrated text is left as is.
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bunVersion = Bun.version;

const rewriteCommand = (command: string): string =>
  command
    // pnpm --filter 'pkg^...' build: build a package's workspace dependencies first.
    .replace(
      /pnpm --filter '([^'^]+)\^\.\.\.' (\S+)/g,
      "bun run --filter '*' $2",
    )
    .replace(
      /pnpm --filter ('[^']+'|"[^"]+"|\S+) (?:run )?(\S+)/g,
      "bun run --filter $1 $2",
    )
    .replace(/pnpm -r --if-present (\S+)/g, "bun run --filter '*' $1")
    .replace(/pnpm -r (?:run )?(\S+)/g, "bun run --filter '*' $1")
    .replace(/pnpm --dir (\S+) (\S+)/g, "bun run --cwd $1 $2")
    .replace(/pnpm (?:dlx|exec) /g, "bunx ")
    .replace(/pnpm install --frozen-lockfile/g, "bun install --frozen-lockfile")
    .replace(/pnpm install/g, "bun install")
    .replace(/pnpm run /g, "bun run ")
    .replace(/\bpnpm ([a-z][\w:-]*)/g, "bun run $1")
    .replace(/\bnode --import tsx --test /g, "bun test ")
    .replace(/\bnode --test /g, "bun test ")
    .replace(/\bnode (\S+\.(?:mjs|js|ts))/g, "bun $1");

const changed: string[] = [];
const manifestPaths: string[] = ["package.json"];
for (const pattern of [
  "apps/*/package.json",
  "packages/*/package.json",
  "web/package.json",
]) {
  for await (const found of new Glob(pattern).scan({ cwd: root }))
    manifestPaths.push(found.replaceAll("\\", "/"));
}
for (const path of manifestPaths) {
  const file = Bun.file(join(root, path));
  if (!(await file.exists())) continue;
  const original = await file.text();
  const manifest = JSON.parse(original);
  if (manifest.scripts) {
    for (const [name, command] of Object.entries<string>(manifest.scripts))
      manifest.scripts[name] = rewriteCommand(command);
  }
  // Bun runs TypeScript natively; tsx is only dropped once no script still invokes it.
  if (
    manifest.devDependencies?.tsx &&
    !Object.values<string>(manifest.scripts ?? {}).some((command) =>
      /\btsx\b/.test(command),
    )
  )
    delete manifest.devDependencies.tsx;
  if (path === "package.json") {
    manifest.packageManager = `bun@${bunVersion}`;
    manifest.engines = { bun: `>=${bunVersion}` };
    const workspace = await Bun.file(join(root, "pnpm-workspace.yaml"))
      .text()
      .catch(() => "");
    const allowed = [...workspace.matchAll(/^\s+'?([@\w./-]+)'?: true$/gm)].map(
      (match) => match[1],
    );
    manifest.trustedDependencies = [
      ...new Set([
        ...(manifest.trustedDependencies ?? []),
        ...allowed,
        "electron",
      ]),
    ].sort();
  }
  const next = JSON.stringify(manifest, null, 2) + "\n";
  if (next !== original) {
    await Bun.write(join(root, path), next);
    changed.push(path);
  }
}

// `pnpm <name>` in prose, usage strings and messages: only names that are real scripts or
// package-manager verbs, so sentences such as "pnpm must install ..." are not mangled.
const scriptNames = new Set<string>(["install", "add"]);
for (const path of manifestPaths) {
  const manifest = await Bun.file(join(root, path))
    .json()
    .catch(() => ({}));
  for (const name of Object.keys(manifest.scripts ?? {})) scriptNames.add(name);
}
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const knownScript = new RegExp(
  `\\bpnpm (${[...scriptNames]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?![\\w:-])`,
  "g",
);
const rewriteText = (text: string): string =>
  text
    .replace(/\bpnpm publish\b/g, "bun publish")
    .replace(/\bpnpm (?:--filter|-r|--dir|dlx|exec) [^\n`]*/g, (match) =>
      rewriteCommand(match),
    )
    .replace(/\bpnpm install\b/g, "bun install")
    .replace(/\bpnpm ([\w-]+:\*)/g, "bun run $1")
    .replace(knownScript, (_, name: string) =>
      name === "install" || name === "add" ? `bun ${name}` : `bun run ${name}`,
    );

// Release CI and packaging used pnpm's supportedArchitectures to fetch every optional sharp
// binary; Bun takes the same targets as install flags, kept in one root script.
const releaseInstall =
  "bun install --frozen-lockfile --os=darwin --os=win32 --os=linux --cpu=x64 --cpu=arm64 --libc=glibc";

for await (const path of new Glob(".github/workflows/*.yml").scan({
  cwd: root,
  dot: true,
})) {
  const original = await Bun.file(join(root, path)).text();
  const next = rewriteText(
    rewriteCommand(
      original
        .replace(
          /- uses: pnpm\/action-setup@[^\n]+\n(\s+with:\n(\s{8,}[^\n]+\n)+)?/g,
          "- uses: oven-sh/setup-bun@v2\n",
        )
        .replace(
          /- name: Setup pnpm\n(\s+)uses: pnpm\/action-setup@[^\n]+\n(\1with:\n(\1\s+[^\n]+\n)+)?/g,
          "- name: Setup Bun\n$1uses: oven-sh/setup-bun@v2\n",
        )
        .replace(/cache: ['"]?pnpm['"]?\n/g, "")
        .replace(/cache-dependency-path: pnpm-lock\.yaml\n/g, "")
        .replace(/\n\s+- ["']?pnpm-workspace\.yaml["']?(?=\n)/g, "")
        .replace(/pnpm-lock\.yaml/g, "bun.lock")
        .replace(/\$\(pnpm --version\)/g, "$(bun --version)")
        .replace(/'bun run version: /g, "'Bun version: "),
    ),
  ).replace(
    /bun install --frozen-lockfile(?! --os)/g,
    "bun run install:release",
  );
  if (next !== original) {
    await Bun.write(join(root, path), next);
    changed.push(path);
  }
}

const rewriteSpawns = (source: string): string =>
  source
    .replace(/"pnpm", \["exec", /g, '"bunx", [')
    .replace(/"pnpm", \["--filter", /g, '"bun", ["run", "--filter", ')
    .replace(/"pnpm", \["(install|--version)"/g, '"bun", ["$1"')
    .replace(/"pnpm", \["([a-z][\w:-]*)"/g, '"bun", ["run", "$1"')
    .replace(/run\("pnpm", args/g, 'run("bun", args')
    .replace(/, "--no-git-checks"/g, "");

for (const pattern of [
  "scripts/*.mjs",
  "apps/desktop/scripts/*.mjs",
  "packages/cli/src/index.ts",
]) {
  for await (const found of new Glob(pattern).scan({ cwd: root })) {
    const path = found.replaceAll("\\", "/");
    const original = await Bun.file(join(root, path)).text();
    let next = rewriteText(rewriteSpawns(original));
    if (path === "apps/desktop/scripts/run-tests.mjs") {
      // bun is a real executable on Windows; the pnpm.cmd shim wrapper is no longer needed.
      next = next.replace(
        /\n  if \(process\.platform === "win32" && command === "pnpm"\) \{\n[^\n]+\n  \}/,
        "",
      );
    }
    if (path === "scripts/npm-workspace-release.mjs") {
      next = next.replace(
        /  const workspaceFile = join\(repoRoot, "pnpm-workspace\.yaml"\);\n  if \(existsSync\(workspaceFile\)\) \{[\s\S]*?\n  \}\n\n/,
        "",
      );
    }
    if (path === "scripts/npm-workspace-release.test.mjs") {
      next = next.replace(
        /  writeFileSync\(join\(fixtureRoot, "pnpm-workspace\.yaml"\)[^\n]*\n/,
        "",
      );
    }
    if (path === "scripts/release-npm-ref-orchestration.test.mjs") {
      next = next
        .replace(
          /  writeFileSync\(join\(fixtureRoot, "pnpm-workspace\.yaml"\)[^\n]*\n  writeFileSync\(join\(fixtureRoot, "package\.json"\), JSON\.stringify\(\{ name: "fixture-root", private: true \}\)\);/,
          '  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"] }));',
        )
        .replace(
          /createFakeCommand\("pnpm", fakePnpmSource\(\)\)/,
          'createFakeCommand("bun", fakeBunSource())',
        )
        .replace(/function fakePnpmSource\(\)/, "function fakeBunSource()")
        // The fake `bun` shadows the real one on PATH, so fakes must name their interpreter absolutely.
        .replace(
          "`#!/usr/bin/env node\\n${source}`",
          "`#!${process.execPath}\\n${source}`",
        )
        .replace(
          '"pnpm availability check requires',
          '"bun availability check requires',
        )
        .replace('"unexpected pnpm operation"', '"unexpected bun operation"')
        .replace(
          'process.stdout.write("11.0.8\\\\n")',
          `process.stdout.write("${bunVersion}\\\\n")`,
        );
    }
    if (next !== original) {
      await Bun.write(join(root, path), next);
      changed.push(path);
    }
  }
}

const rootManifestPath = join(root, "package.json");
const rootManifest = await Bun.file(rootManifestPath).json();
if (rootManifest.scripts["install:release"] !== releaseInstall) {
  rootManifest.scripts = {
    "install:release": releaseInstall,
    ...rootManifest.scripts,
  };
  await Bun.write(
    rootManifestPath,
    JSON.stringify(rootManifest, null, 2) + "\n",
  );
  changed.push("package.json");
}

for (const pattern of [
  "*.md",
  "docs/**/*.md",
  "apps/**/*.md",
  "packages/**/*.md",
  "plugins/**/*.md",
  "skills/**/*.md",
]) {
  for await (const found of new Glob(pattern).scan({ cwd: root })) {
    const path = found.replaceAll("\\", "/");
    if (
      path.includes("node_modules/") ||
      path.includes("/dist/") ||
      path.includes("CHANGELOG")
    )
      continue;
    const original = await Bun.file(join(root, path)).text();
    const next = rewriteText(original)
      .replace(
        /\*\*pnpm\*\*([:：] ?)(\D*?)\d+(\D*)$/gm,
        `**Bun**$1$2${bunVersion}$3`,
      )
      .replace(/`pnpm-workspace\.yaml`/g, "`package.json` `workspaces`")
      .replace(/`package\.json `workspaces``/g, "`package.json` `workspaces`")
      .replace(/pnpm-workspace\.yaml/g, "package.json workspaces")
      .replace(/pnpm-lock\.yaml/g, "bun.lock")
      .replace(/`pnpm@[\d.x]+`/g, `\`bun@${bunVersion}\``)
      .replace(/ with `bun`, not pnpm/g, " with `bun`")
      .replace(/`pnpm`/g, "`bun`")
      .replace(/\bpnpm\b/g, "Bun");
    if (next !== original) {
      await Bun.write(join(root, path), next);
      changed.push(path);
    }
  }
}

console.log(
  JSON.stringify({ bun: bunVersion, changed: [...new Set(changed)] }, null, 2),
);
