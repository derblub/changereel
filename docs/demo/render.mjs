/**
 * The demo of the README: the two versions of the sample roastery compared and narrated.
 *
 *   ANTHROPIC_API_KEY=… node docs/demo/render.mjs --voice en_US-lessac-medium.onnx [flags]
 *
 * Writes docs/demo/out. Needs Chrome and, for the voice, Piper.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../test/serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const before = await serve(join(here, "before"));
const after = await serve(join(here, "after"));
// Not spawnSync: the two servers answer from this process, so its event loop has to keep running
const child = spawn(
  process.execPath,
  [
    join(here, "..", "..", "src", "cli.mjs"),
    ...["--before", before.url, "--after", after.url, "--title", "Lumen Coffee", "--out", join(here, "out")],
    ...["--before-label", "main", "--after-label", "subscriptions"],
    ...["--narrate", "--model", "claude-opus-5-5", "--preview"],
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("exit", (status) => {
  before.close();
  after.close();
  process.exit(status ?? 1);
});
