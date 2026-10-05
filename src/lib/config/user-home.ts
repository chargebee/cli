import { homedir } from "node:os";

/** HOME at call time so tests (and users) can override; Bun caches `os.homedir()`. */
export function userHome(): string {
  return process.env.HOME || homedir();
}
