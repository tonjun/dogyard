import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "dogyard";

/** Where to install: the project's `.claude/skills`, the user's `~/.claude/skills`, or any skills folder. */
export type SkillTarget = "project" | "global" | { dir: string };

export interface SkillTargetOptions {
  target?: SkillTarget;
  /** Project root for the `project` target (default: process.cwd()). */
  cwd?: string;
  /** Home directory for the `global` target (default: os.homedir()). */
  home?: string;
}

export interface InstallSkillOptions extends SkillTargetOptions {
  force?: boolean;
}

export interface InstallSkillResult {
  dir: string;
  files: string[];
}

/** The skill folder shipped with the package (`<pkg>/skills/dogyard`); this module sits one level below the root in both src/ and dist/. */
export function bundledSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", SKILL_NAME);
}

/** The folder a skill install writes to (`<skills dir>/dogyard`). */
export function skillTargetDir(opts: SkillTargetOptions = {}): string {
  const target = opts.target ?? "project";
  if (target === "project") return path.resolve(opts.cwd ?? process.cwd(), ".claude", "skills", SKILL_NAME);
  if (target === "global") return path.join(opts.home ?? homedir(), ".claude", "skills", SKILL_NAME);
  return path.resolve(opts.cwd ?? process.cwd(), target.dir, SKILL_NAME);
}

/** Copy the bundled skill into a skills folder, stamping the installing dogyard version into SKILL.md. */
export function installSkill(opts: InstallSkillOptions = {}): InstallSkillResult {
  const src = bundledSkillsDir();
  if (!existsSync(path.join(src, "SKILL.md"))) throw new Error(`Bundled skill not found at ${src}`);
  const dir = skillTargetDir(opts);
  if (existsSync(dir)) {
    if (!opts.force) throw new Error(`Skill already installed at ${dir} (use --force to replace it)`);
    // replace rather than merge, so files dropped from the bundle don't linger
    rmSync(dir, { recursive: true, force: true });
  }
  cpSync(src, dir, { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");
  writeFileSync(skillFile, stampVersion(readFileSync(skillFile, "utf8"), packageVersion()));
  return { dir, files: listFiles(dir) };
}

/** Remove an installed skill; returns its folder, or undefined when nothing was installed there. */
export function uninstallSkill(opts: SkillTargetOptions = {}): string | undefined {
  const dir = skillTargetDir(opts);
  if (!existsSync(dir)) return undefined;
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** Add `metadata.dogyard_version` to the SKILL.md frontmatter so a stale install can be spotted. */
export function stampVersion(skillMd: string, version: string): string {
  const end = skillMd.indexOf("\n---", 4);
  if (!skillMd.startsWith("---\n") || end < 0) return skillMd;
  return `${skillMd.slice(0, end)}\nmetadata:\n  dogyard_version: ${version}${skillMd.slice(end)}`;
}

function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => path.join(dir, rel))
    .filter((f) => statSync(f).isFile())
    .sort();
}
