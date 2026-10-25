import path from "node:path";
import type { Command } from "commander";
import { bundledSkillsDir, installSkill, uninstallSkill, type SkillTarget } from "../../skills.js";
import { fail, log } from "../util.js";

interface TargetFlags {
  global?: boolean;
  dir?: string;
}

function resolveTarget(flags: TargetFlags): SkillTarget {
  if (flags.global && flags.dir !== undefined) fail("Use only one of --global, --dir");
  if (flags.global) return "global";
  return flags.dir !== undefined ? { dir: flags.dir } : "project";
}

export function registerSkills(program: Command): void {
  const skills = program.command("skills").description("Install the dogyard agent skill (teaches Claude Code and other agents to use DogYard)");
  skills
    .command("install")
    .description("Install the skill into ./.claude/skills/dogyard (or --global / --dir)")
    .option("-g, --global", "install into ~/.claude/skills for every project")
    .option("-d, --dir <dir>", "install into <dir>/dogyard (any agent's skills folder)")
    .option("--force", "replace an existing install")
    .action((flags: TargetFlags & { force?: boolean }) => {
      let res;
      try {
        res = installSkill({ target: resolveTarget(flags), force: flags.force ?? false });
      } catch (err) {
        return fail((err as Error).message);
      }
      log(`Installed skill "dogyard" in ${res.dir}`);
      for (const f of res.files) log(`  ${path.relative(process.cwd(), f)}`);
      log("\nStart a new Claude Code session to pick it up.");
    });
  skills
    .command("uninstall")
    .description("Remove an installed copy of the skill")
    .option("-g, --global", "remove from ~/.claude/skills")
    .option("-d, --dir <dir>", "remove <dir>/dogyard")
    .action((flags: TargetFlags) => {
      const dir = uninstallSkill({ target: resolveTarget(flags) });
      log(dir ? `Removed ${dir}` : "Skill is not installed there");
    });
  skills
    .command("path")
    .description("Print the folder of the skill bundled with this dogyard")
    .action(() => {
      process.stdout.write(`${bundledSkillsDir()}\n`);
    });
}
