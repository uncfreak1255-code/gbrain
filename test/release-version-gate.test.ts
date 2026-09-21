import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const guard = resolve("scripts/check-release-version.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(root: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [guard], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GBRAIN_RELEASE_ROOT: root, ...extraEnv },
  });
}

function writeRelease(root: string, version: string, packageVersion = version, changelogVersion = version) {
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${changelogVersion}] - 2026-09-21\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gbrain-release-version-"));
  roots.push(root);
  expect(spawnSync("git", ["init", "-b", "master"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "release-gate@example.invalid"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "Release Gate"], { cwd: root }).status).toBe(0);
  writeRelease(root, "0.51.0.0");
  expect(spawnSync("git", ["add", "VERSION", "package.json", "CHANGELOG.md"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", "older"], { cwd: root }).status).toBe(0);
  writeRelease(root, "0.51.0.1");
  expect(spawnSync("git", ["add", "VERSION", "package.json", "CHANGELOG.md"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", "base"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["switch", "-c", "feature"], { cwd: root }).status).toBe(0);
  return root;
}

describe("release version gate", () => {
  test("accepts a consistent four-part version strictly newer than the base", () => {
    const root = fixture();
    writeRelease(root, "0.51.0.2");
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.51.0.1 -> 0.51.0.2");
  });

  test("rejects a version equal to the base", () => {
    const root = fixture();
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be strictly newer");
  });

  test("ignores an arbitrary base-ref environment override", () => {
    const root = fixture();
    const result = run(root, { GBRAIN_RELEASE_BASE_REF: "HEAD~1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at 'origin/master'");
  });

  test("rejects package and changelog drift", () => {
    const packageRoot = fixture();
    writeRelease(packageRoot, "0.51.0.2", "0.51.0.1");
    expect(run(packageRoot).stderr).toContain("package.json version");

    const changelogRoot = fixture();
    writeRelease(changelogRoot, "0.51.0.2", "0.51.0.2", "0.51.0.1");
    expect(run(changelogRoot).stderr).toContain("top CHANGELOG version");
  });

  test("rejects versions without four numeric parts", () => {
    const root = fixture();
    writeRelease(root, "0.51.1");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MAJOR.MINOR.PATCH.MICRO");
  });
});
