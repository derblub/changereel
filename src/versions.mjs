/**
 * Two versions of a site from one repository, built and served side by side.
 *
 * Each version is a git worktree in a temporary directory, so the working tree you are in
 * is not touched and may have uncommitted changes. In each, the build command runs, then the
 * serve command with {port} replaced by a free port. A version is ready when its address
 * answers. `stop()` ends the servers and removes the worktrees.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

function run(command, cwd, name, log) {
  return new Promise((ok, fail) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const tail = [];
    const keep = (chunk) => {
      tail.push(...String(chunk).split("\n"));
      tail.splice(0, Math.max(0, tail.length - 30));
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", fail);
    child.on("exit", (code) => {
      if (code === 0) return ok();
      fail(new Error(`${name}: "${command}" ended with ${code}\n${tail.join("\n")}`));
    });
    log(`${name}: ${command}`);
  });
}

async function answers(url, timeout, child) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`The server for ${url} ended with ${child.exitCode}`);
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`${url} did not answer within ${Math.round(timeout / 1000)} seconds`);
}

/**
 * Builds and serves `base` and `head` of the repository at `cwd`.
 * Gives `{ before, after, stop }`: the two addresses and the way to end them.
 */
export async function serveVersions({ cwd = process.cwd(), base, head = "HEAD", build, serve, readyTimeout = 120_000 }, log = console.log) {
  if (!serve.includes("{port}")) throw new Error("--serve needs {port} where the port goes, e.g. \"npm run preview -- --port {port}\"");
  const root = git(cwd, "rev-parse", "--show-toplevel");
  const sides = [];
  const stop = async () => {
    for (const side of sides) {
      if (side.child && side.child.exitCode === null) {
        try {
          process.kill(-side.child.pid, "SIGTERM");
        } catch {
          side.child.kill();
        }
      }
      try {
        git(root, "worktree", "remove", "--force", side.dir);
      } catch {
        rmSync(side.dir, { recursive: true, force: true });
      }
    }
  };
  try {
    for (const [name, ref] of [["before", base], ["after", head]]) {
      const commit = git(root, "rev-parse", "--verify", `${ref}^{commit}`);
      const dir = mkdtempSync(join(tmpdir(), `changereel-${name}-`));
      const side = { name, dir, commit };
      sides.push(side);
      git(root, "worktree", "add", "--detach", dir, commit);
      log(`${name}: ${ref} (${commit.slice(0, 7)})`);
      if (build) await run(build, dir, name, log);
      const port = await freePort();
      side.url = `http://127.0.0.1:${port}`;
      // Its own process group, so that stopping it also ends what the shell started
      side.child = spawn(serve.replaceAll("{port}", String(port)), { cwd: dir, shell: true, stdio: "ignore", detached: true });
      await answers(side.url, readyTimeout, side.child);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { before: sides[0].url, after: sides[1].url, commits: { before: sides[0].commit, after: sides[1].commit }, stop };
}
