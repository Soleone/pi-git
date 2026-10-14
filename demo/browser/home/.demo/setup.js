// Runs once when the sandbox starts: makes project/ a git repository on main with a short history,
// through the same stand-in for git that pi-git uses.
const path = require("node:path");
const { main } = require("../.git-shim/git.cjs");

const project = path.join(__dirname, "../project");
const git = async (...args) => {
  const code = await main(args, project);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited with ${code}`);
};

(async () => {
  await git("init");
  await git("add", "--", "package.json", "src/readings.js", "src/cli.js");
  await git("commit", "--message", "feat: print today's forecast for a city");
  await git("add", "--all", "--", ".");
  await git("commit", "--message", "docs: add a README with usage");
})();
