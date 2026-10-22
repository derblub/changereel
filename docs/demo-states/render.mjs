/**
 * The second demo: the sample roastery with a bag dialog and an account behind a login,
 * reached with --states, compared and narrated.
 *
 *   ANTHROPIC_API_KEY=… node docs/demo-states/render.mjs --voice kokoro:af_heart [flags]
 *
 * Writes docs/demo-states/out. Needs Chrome and, for the voice, Kokoro (or Piper with a .onnx voice).
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
    ...["--before-label", "main", "--after-label", "free-delivery"],
    ...["--states", join(here, "states.json")],
    ...["--narrate", "--model", "claude-opus-5-5", "--preview"],
    ...process.argv.slice(2),
  ],
  // A demo value, not a secret: the login of the sample site takes any password that is not empty
  { stdio: "inherit", env: { ...process.env, LUMEN_PASSWORD: process.env.LUMEN_PASSWORD ?? "demo-password" } },
);
child.on("exit", (status) => {
  before.close();
  after.close();
  process.exit(status ?? 1);
});
