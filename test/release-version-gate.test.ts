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
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_RELEASE_ROOT: root };
  delete env.GITHUB_REF;
  delete env.GITHUB_EVENT_NAME;
  return spawnSync("bash", [guard], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
}

function writeRelease(root: string, version: string, packageVersion = version, changelogVersion = version) {
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [${changelogVersion}] - 2026-09-21\n`);
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function bareRemote(from: string) {
  const remote = mkdtempSync(join(tmpdir(), "gbrain-release-remote-"));
  roots.push(remote);
  git(from, ["clone", "--bare", from, remote]);
  return remote;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gbrain-release-version-"));
  roots.push(root);
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "release-gate@example.invalid"]);
  git(root, ["config", "user.name", "Release Gate"]);
  writeRelease(root, "0.51.0.0");
  git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
  git(root, ["commit", "-m", "older"]);
  writeRelease(root, "0.51.0.1");
  git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  git(root, ["switch", "-c", "feature"]);
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

  test("fails closed when origin/master is missing and cannot be fetched", () => {
    const root = fixture();
    writeRelease(root, "0.51.0.2");
    git(root, ["update-ref", "-d", "refs/remotes/origin/master"]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read VERSION from base ref 'origin/master'");
  });

  test("fetches origin/master when a detached feature checkout is missing it", () => {
    const root = fixture();
    writeRelease(root, "0.51.0.2");
    const remote = bareRemote(root);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["checkout", "--detach"]);
    git(root, ["update-ref", "-d", "refs/remotes/origin/master"]);
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.51.0.1 -> 0.51.0.2");
    expect(result.stdout).toContain("base=origin/master");
  });

  test("on master tip compares against HEAD^ after origin/master matches HEAD", () => {
    const root = fixture();
    git(root, ["switch", "master"]);
    writeRelease(root, "0.51.0.2");
    git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
    git(root, ["commit", "-m", "release"]);
    git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.51.0.1 -> 0.51.0.2");
    expect(result.stdout).toContain("base=HEAD^");
  });

  test("rejects master when VERSION equals HEAD^", () => {
    const root = fixture();
    git(root, ["switch", "master"]);
    writeRelease(root, "0.51.0.0");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be strictly newer");
    expect(result.stderr).toContain("at 'HEAD^'");
  });

  test("deepens a shallow master clone so HEAD^ is readable", () => {
    const root = fixture();
    git(root, ["switch", "master"]);
    writeRelease(root, "0.51.0.2");
    git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
    git(root, ["commit", "-m", "release"]);
    const remote = bareRemote(root);
    const clone = mkdtempSync(join(tmpdir(), "gbrain-release-shallow-"));
    roots.push(clone);
    expect(spawnSync("git", ["clone", "--depth=1", remote, clone], { encoding: "utf8" }).status).toBe(0);
    const result = run(clone);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.51.0.1 -> 0.51.0.2");
    expect(result.stdout).toContain("base=HEAD^");
  });

  test("uses HEAD^ on a detached master push when origin/master cannot be fetched", () => {
    const root = fixture();
    git(root, ["switch", "master"]);
    writeRelease(root, "0.51.0.2");
    git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
    git(root, ["commit", "-m", "release"]);
    git(root, ["checkout", "--detach"]);
    git(root, ["update-ref", "-d", "refs/remotes/origin/master"]);
    const result = run(root, { GITHUB_REF: "refs/heads/master" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.51.0.1 -> 0.51.0.2");
    expect(result.stdout).toContain("base=HEAD^");
  });

  test("fails closed on a single-commit master with no parent", () => {
    const root = mkdtempSync(join(tmpdir(), "gbrain-release-single-"));
    roots.push(root);
    git(root, ["init", "-b", "master"]);
    git(root, ["config", "user.email", "release-gate@example.invalid"]);
    git(root, ["config", "user.name", "Release Gate"]);
    writeRelease(root, "0.51.0.2");
    git(root, ["add", "VERSION", "package.json", "CHANGELOG.md"]);
    git(root, ["commit", "-m", "only"]);
    git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read VERSION from base ref 'HEAD^'");
  });
});
