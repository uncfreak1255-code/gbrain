import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RELEASE_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/release.yml");

function loadReleaseWorkflow(): any {
  return yaml.load(readFileSync(RELEASE_WORKFLOW, "utf8"));
}

describe("release workflow", () => {
  it("keeps the tag publish path bounded and does not run the full test suite", () => {
    const raw = readFileSync(RELEASE_WORKFLOW, "utf8");
    const workflow = loadReleaseWorkflow();

    expect(raw).not.toContain("- run: bun test");
    expect(workflow.jobs.preflight["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(
      workflow.jobs.preflight.steps.some((step: any) => step.run === "bun run typecheck"),
    ).toBe(true);
    expect(workflow.jobs.build.needs).toBe("preflight");
    expect(workflow.jobs.build["timeout-minutes"]).toBeLessThanOrEqual(10);
  });
});
