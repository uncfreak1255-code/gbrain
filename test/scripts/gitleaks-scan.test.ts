import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT_SRC = join(REPO_ROOT, "scripts/gitleaks-scan.sh");
const CONFIG_SRC = join(REPO_ROOT, ".gitleaks.toml");

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function secretLikeText(): string {
  return ["gh", "p_", "1234567890abcdefghij", "1234567890abcdefghij"].join("");
}

function shell(
  cwd: string,
  args: string[],
  opts: { ok?: boolean; input?: string; env?: Record<string, string> } = {},
) {
  const r = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    input: opts.input,
  });
  if (opts.ok !== false && r.status !== 0) {
    throw new Error(
      `${args.join(" ")} failed with ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
  return r;
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gitleaks-scan-"));
  roots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(SCRIPT_SRC, join(root, "scripts/gitleaks-scan.sh"));
  cpSync(CONFIG_SRC, join(root, ".gitleaks.toml"));
  writeFakeGitleaks(root);
  write(root, "README.md", "# fixture\n");
  commit(root, "initial");
  return root;
}

function runScan(root: string, ...args: string[]) {
  return shell(root, ["bash", "scripts/gitleaks-scan.sh", ...args], {
    ok: false,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
  });
}

function writeFakeGitleaks(root: string) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "gitleaks"),
    `#!/usr/bin/env bash
set -euo pipefail
mode="\${1:-}"
shift || true
range=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-opts)
      range="\${2:-}"
      shift 2
      ;;
    --log-opts=*)
      range="\${1#--log-opts=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
case "$mode" in
  git)
    if [ -z "$range" ]; then
      echo "fake gitleaks: missing --log-opts" >&2
      exit 2
    fi
    while IFS= read -r path; do
      if [ -f "$path" ] && grep -q -E 'ghp_[[:alnum:]_]+' "$path"; then
        echo "fake gitleaks: leaks found" >&2
        exit 1
      fi
    done < <(git diff --name-only "$range")
    exit 0
    ;;
  dir)
    if grep -R --exclude-dir=.git --exclude-dir=bin -q -E 'ghp_[[:alnum:]_]+' .; then
      echo "fake gitleaks: leaks found" >&2
      exit 1
    fi
    exit 0
    ;;
  *)
    echo "fake gitleaks: unsupported mode $mode" >&2
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
}

describe("scripts/gitleaks-scan.sh — merge scope", () => {
  it("clean base..HEAD exits 0", () => {
    const root = makeFixtureRepo();
    git(root, "branch", "base");
    write(root, "src/index.ts", "export const ok = true;\n");
    commit(root, "clean change");

    const r = runScan(root, "--scope", "merge", "--base", "base");

    expect(r.status).toBe(0);
  });

  it("a new committed finding exits 1", () => {
    const root = makeFixtureRepo();
    git(root, "branch", "base");
    write(root, "src/credential.txt", `fixture=${secretLikeText()}\n`);
    commit(root, "add credential-shaped fixture");

    const r = runScan(root, "--scope", "merge", "--base", "base");

    expect(r.status).toBe(1);
  });

  it("a finding committed before base does not fail", () => {
    const root = makeFixtureRepo();
    write(root, "src/old-credential.txt", `fixture=${secretLikeText()}\n`);
    commit(root, "old credential-shaped fixture");
    git(root, "branch", "base");
    write(root, "src/new-clean.ts", "export const stillClean = true;\n");
    commit(root, "new clean change");

    const r = runScan(root, "--scope", "merge", "--base", "base");

    expect(r.status).toBe(0);
  });

  it("an invalid base ref exits 2", () => {
    const root = makeFixtureRepo();

    const r = runScan(root, "--scope", "merge", "--base", "missing-ref");

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("invalid base ref");
  });
});

describe("scripts/gitleaks-scan.sh — workspace scope", () => {
  it("finds an uncommitted credential-shaped file and exits 1", () => {
    const root = makeFixtureRepo();
    write(root, "scratch/credential.txt", `fixture=${secretLikeText()}\n`);

    const r = runScan(root, "--scope", "workspace");

    expect(r.status).toBe(1);
  });
});
