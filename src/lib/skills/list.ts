import { realpath } from "node:fs/promises";
import { resolveSkillTargets, skillInstallPath, type Agent } from "./index.js";

interface SkillInstallation {
  path: string;
  global: boolean;
  agents: Agent[];
}

/** Group listings by destination, giving a shared global/project path one global label. */
export async function listSkillInstallations(opts: {
  agent?: string[];
  global?: boolean;
  project?: boolean;
  path?: string;
}): Promise<SkillInstallation[]> {
  const locations = await resolveSkillTargets(opts, undefined, true);
  const grouped = new Map<string, SkillInstallation>();
  for (const location of locations) {
    const path = skillInstallPath(location.projectDir, location.agent, location.global);
    const destination = await realpath(path);
    let installation = grouped.get(destination);
    if (!installation) {
      installation = { path, global: Boolean(location.global), agents: [] };
      grouped.set(destination, installation);
    }
    if (!installation.agents.includes(location.agent)) installation.agents.push(location.agent);
  }
  return [...grouped.values()];
}
