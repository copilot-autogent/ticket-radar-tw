import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { outputPaths, processFixture, readFixture, writeJsonAtomic } from "./pipeline.js";
import { renderDashboard } from "./dashboard.js";

async function build(): Promise<void> {
  const root = process.cwd();
  const fixture = await readFixture(resolve(root, "fixtures/observations.json"));
  const output = processFixture(fixture);
  const paths = outputPaths(root);
  await mkdir(resolve(root, "generated"), { recursive: true });
  await Promise.all([
    writeJsonAtomic(paths.snapshot, output.snapshot),
    writeJsonAtomic(paths.state, output.state),
    writeJsonAtomic(paths.history, output.history),
    writeJsonAtomic(paths.transitions, output.transitions)
  ]);
  await renderDashboard(root, fixture, output);
}

if (process.argv[2] === "build") {
  await build();
} else {
  console.error("Usage: node dist/cli.js build");
  process.exitCode = 2;
}
