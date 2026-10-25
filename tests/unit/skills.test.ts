import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { buildProgram } from "../../src/cli/index.js";
import { bundledSkillsDir, installSkill, skillTargetDir, stampVersion, uninstallSkill } from "../../src/skills.js";

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const frontmatter = (md: string) => YAML.parse(md.split(/^---\r?$/m)[1]!) as Record<string, unknown>;

describe("skillTargetDir", () => {
  it("resolves project, global and --dir targets", () => {
    expect(skillTargetDir({ cwd: "/p" })).toBe(path.resolve("/p/.claude/skills/dogyard"));
    expect(skillTargetDir({ target: "global", home: "/h" })).toBe(path.join("/h", ".claude/skills/dogyard"));
    expect(skillTargetDir({ target: { dir: "agents" }, cwd: "/p" })).toBe(path.resolve("/p/agents/dogyard"));
  });
});

describe("installSkill", () => {
  it("copies the bundled skill, stamps the version and refuses to overwrite without force", () => {
    const home = tmp("skill-home-");
    const res = installSkill({ target: "global", home });
    expect(res.dir).toBe(path.join(home, ".claude/skills/dogyard"));
    expect(res.files).toContain(path.join(res.dir, "SKILL.md"));
    expect(res.files).toContain(path.join(res.dir, "references/flow-yaml.md"));
    const fm = frontmatter(readFileSync(path.join(res.dir, "SKILL.md"), "utf8"));
    expect(fm.name).toBe("dogyard");
    expect(fm.metadata).toEqual({ dogyard_version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(() => installSkill({ target: "global", home })).toThrow(/already installed.*--force/);
  });

  it("replaces the folder with force so stale files are removed", () => {
    const cwd = tmp("skill-project-");
    const { dir } = installSkill({ cwd });
    writeFileSync(path.join(dir, "stale.md"), "old");
    installSkill({ cwd, force: true });
    expect(existsSync(path.join(dir, "stale.md"))).toBe(false);
    expect(existsSync(path.join(dir, "SKILL.md"))).toBe(true);
  });

  it("uninstalls, reporting when nothing was there", () => {
    const cwd = tmp("skill-uninstall-");
    const opts = { target: { dir: "skills" }, cwd };
    expect(uninstallSkill(opts)).toBeUndefined();
    const { dir } = installSkill(opts);
    expect(uninstallSkill(opts)).toBe(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("stampVersion", () => {
  it("adds metadata to the frontmatter and leaves files without one unchanged", () => {
    expect(stampVersion("---\nname: x\n---\nbody\n", "1.2.3")).toBe("---\nname: x\nmetadata:\n  dogyard_version: 1.2.3\n---\nbody\n");
    expect(stampVersion("no frontmatter\n", "1.2.3")).toBe("no frontmatter\n");
    expect(stampVersion("---\r\nname: x\r\n---\r\nbody\r\n", "1.2.3")).toBe("---\r\nname: x\r\nmetadata:\r\n  dogyard_version: 1.2.3\r\n---\r\nbody\r\n");
  });
});

describe("bundled skill", () => {
  const read = (rel: string) => readFileSync(path.join(bundledSkillsDir(), rel), "utf8");

  it("has valid frontmatter and links only to files that exist", () => {
    const md = read("SKILL.md");
    const fm = frontmatter(md);
    expect(fm.name).toBe("dogyard");
    expect(String(fm.description).length).toBeGreaterThan(50);
    for (const [, link] of md.matchAll(/\]\((references\/[^)]+)\)/g)) expect(existsSync(path.join(bundledSkillsDir(), link!)), link).toBe(true);
  });

  it("documents every top-level CLI command in references/cli.md", () => {
    const cli = read("references/cli.md");
    for (const cmd of buildProgram().commands) expect(cli, cmd.name()).toContain(`\`${cmd.name()}`);
  });
});
