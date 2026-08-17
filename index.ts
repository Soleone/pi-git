import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiGit } from "./src/register.js";

export default function piGitExtension(pi: ExtensionAPI): void {
  registerPiGit(pi);
}
