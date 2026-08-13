import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("secret scan wiring", () => {
  it("package scripts expose merge and workspace scanner commands", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

    expect(pkg.scripts["check:secrets"]).toBe(
      "bash scripts/gitleaks-scan.sh --scope merge --base origin/master",
    );
    expect(pkg.scripts["check:secrets:hygiene"]).toBe(
      "bash scripts/gitleaks-scan.sh --scope workspace",
    );
  });

  it("local CI calls the shared script and never invokes workspace scope", () => {
    const ciLocal = readFileSync(join(REPO_ROOT, "scripts/ci-local.sh"), "utf8");

    expect(ciLocal).toContain("scripts/gitleaks-scan.sh --scope merge --base origin/master");
    expect(ciLocal).not.toContain("--scope workspace");
    expect(ciLocal).not.toContain("gitleaks dir .");
    expect(ciLocal).not.toContain("gitleaks git .");
  });

  it("GitHub CI uses the shared script without the Gitleaks Action or cache skip", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/test.yml"), "utf8");
    const start = workflow.indexOf("\n  gitleaks:\n");
    const end = workflow.indexOf("\n  verify:\n", start + 1);
    const gitleaksJob = workflow.slice(start, end);

    expect(gitleaksJob).toContain("scripts/gitleaks-scan.sh --scope merge");
    expect(gitleaksJob).not.toContain("needs: cache-check");
    expect(gitleaksJob).not.toContain("cache-check.outputs");
    expect(workflow).not.toContain("gitleaks/gitleaks-action");
  });
});
