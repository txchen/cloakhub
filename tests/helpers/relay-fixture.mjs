// Starts the Go CDP relay fixture (internal/cdp/relayfixture) in front of a browser.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let binary;

function build() {
  if (!binary) {
    binary = join(mkdtempSync(join(tmpdir(), "cloakhub-relay-")), "relayfixture");
    execFileSync("go", ["build", "-o", binary, "./internal/cdp/relayfixture"], { stdio: "inherit" });
  }
  return binary;
}

/** Returns { port, stats(), stop() } once the relay is listening. */
export async function startRelay({ browser, profile = "work", token, pages }) {
  const args = ["-browser", browser, "-profile", profile];
  if (token) args.push("-token", token);
  if (pages) args.push("-pages", pages);
  const child = spawn(build(), args, { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`relay fixture exited with ${code}`)));
  });
  return {
    port,
    async stats() {
      return (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
    },
    async stop() {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    }
  };
}
