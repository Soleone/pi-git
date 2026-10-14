#!/usr/bin/env node
// Records the browser demo (demo/browser) as the README loop, and the hero from the diff view:
// the agent edits a file, /git shows the change and its diff, and /git-quick-commit writes the message and commits.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { record } from "@soleone/showcase/capture";

const exec = promisify(execFile);
const media = path.resolve("demo/media");
const viewport = { width: 1280, height: 820 };
// The terminal, below the title and the hint buttons.
const crop = "iw*1088/1280:ih*562/820:iw*96/1280:ih*179/820";
const click = (hint) => `[...document.querySelectorAll('#hints button')].find((button) => button.textContent === ${JSON.stringify(hint)}).click()`;
const shows = (text) => `window.terminalText().includes(${JSON.stringify(text)})`;

await exec("node", ["demo/browser/build.mjs"]);
const out = await mkdtemp(path.join(os.tmpdir(), "pi-git-demo-"));
const port = String(4400 + (process.pid % 500));
const server = spawn("node_modules/.bin/showcase", ["terminal", "demo/browser", "--out", path.join(out, "browser"), "--serve", "--port", port], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  createInterface({ input: server.stdout }).on("line", (line) => line.startsWith("Serving at") && resolve());
  server.once("exit", (code) => reject(new Error(`showcase terminal exited with status ${code}`)));
});
const shot = path.join(out, "hero.png");
try {
  const { frames, durationMs, grid } = await record({
    url: `http://127.0.0.1:${port}/`,
    out: path.join(media, "demo.webp"),
    viewport,
    width: 1088,
    crop,
    attempts: 3,
    async start(page) {
      await page.waitFor("window.demoReady === true", { timeoutMs: 120_000 });
      // The recipe starts pi by itself.
      await page.waitFor(shows("scripted • "), { timeoutMs: 60_000 });
      await page.sleep(1500);
    },
    async drive(page) {
      const focus = () => page.run("eval", "document.querySelector('.xterm-helper-textarea').focus()");
      await page.sleep(1200);
      await page.run("eval", click("add a --json flag"));
      await page.waitFor(shows("stage it yourself"), { timeoutMs: 60_000 });
      await page.sleep(1500);
      await page.run("eval", click("/git"));
      await page.waitFor(shows("0/1 staged"), { timeoutMs: 15_000 });
      await focus();
      await page.sleep(1500);
      await page.run("press", "d");
      await page.waitFor(shows("diff: src/cli.js"), { timeoutMs: 10_000 });
      await page.sleep(500);
      await page.run("screenshot", shot);
      await page.sleep(2500);
      await page.run("press", "q");
      await page.sleep(1000);
      await page.run("press", "Escape");
      await page.sleep(800);
      await page.run("eval", click("/git-quick-commit"));
      await page.waitFor(shows("Quick commit: complete"), { timeoutMs: 60_000 });
      await page.sleep(3500);
    },
  });
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", shot, "-vf", `crop=${crop}`, path.join(media, "hero.png")]);
  console.log(`Wrote demo/media/demo.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s) and demo/media/hero.png. Check the frames in ${grid}.`);
} finally {
  server.kill();
  await rm(out, { recursive: true, force: true });
}
