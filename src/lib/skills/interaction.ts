import { realpath } from "node:fs/promises";
import { humanLog } from "../output.js";
import { canPrompt, cancel, confirm, isCancel, multiselect, select } from "../prompts.js";
import { resolveSkillTargets, skillInstallPath, type Agent, type InstalledLocation } from "./index.js";

export interface SkillSelection {
  agent?: Agent[];
  path?: string;
  global?: boolean;
  project?: boolean;
  yes?: boolean;
}

export async function selectScope(opts: SkillSelection, operation: "add" | "update" | "remove"): Promise<SkillSelection | null> {
  if (opts.global || opts.project || opts.path) return opts;
  if (opts.yes || !canPrompt()) {
    const global = operation === "update" && (await resolveSkillTargets({ ...opts, agent: undefined })).length === 0;
    return { ...opts, global };
  }
  const scope = await select({
    message: "Select installation scope",
    options: [
      { value: "project", label: "Project", hint: "Current directory" },
      { value: "global", label: "Global", hint: "Available across projects" },
    ],
    initialValue: "project",
  });
  if (isCancel(scope)) {
    cancel("Cancelled.");
    return null;
  }
  return { ...opts, global: scope === "global" };
}

export async function selectInstalledTargets(opts: SkillSelection, operation: "update" | "remove"): Promise<InstalledLocation[] | null> {
  const locations = await resolveSkillTargets(opts);
  if (!locations.length || opts.yes || opts.agent?.length || !canPrompt()) return locations;
  const groups = new Map<string, InstalledLocation[]>();
  for (const location of locations) {
    const path = await realpath(skillInstallPath(location.projectDir, location.agent, location.global));
    const group = groups.get(path) || [];
    group.push(location);
    groups.set(path, group);
  }
  const choices = [...groups.values()];
  const selected = await multiselect({
    message: `Select installations to ${operation}`,
    options: choices.map((group, index) => ({
      value: index,
      label: group.map((location) => location.agent).join(", "),
      hint: skillInstallPath(group[0]!.projectDir, group[0]!.agent, group[0]!.global),
    })),
    initialValues: operation === "remove" ? [] : choices.map((_, index) => index),
    required: true,
  });
  if (isCancel(selected)) {
    cancel("Cancelled.");
    return null;
  }
  return (selected as number[]).flatMap((index) => choices[index]!);
}

export async function confirmRemoval(locations: InstalledLocation[], yes = false): Promise<boolean> {
  const paths = [...new Set(locations.map((location) => skillInstallPath(location.projectDir, location.agent, location.global)))];
  humanLog("Remove chargebee-cli from:");
  for (const path of paths) humanLog(`  ${path}`);
  if (yes) return true;
  if (!canPrompt()) throw new Error("Removal requires confirmation. Run interactively or pass --yes.");
  const accepted = await confirm({ message: "Remove these skill installations?", initialValue: false });
  if (isCancel(accepted) || !accepted) {
    cancel("Cancelled.");
    return false;
  }
  return true;
}
