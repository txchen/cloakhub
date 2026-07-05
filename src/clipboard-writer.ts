import type { BrowserClipboardWriter } from "./browser-runtime";

export interface XclipClipboardWriterOptions {
  spawn?: typeof Bun.spawn;
}

type ClipboardSubprocess = Pick<Bun.Subprocess<"pipe", "ignore", "ignore">, "exited" | "stdin">;

export function createXclipClipboardWriter(options: XclipClipboardWriterOptions = {}): BrowserClipboardWriter {
  const spawn = options.spawn ?? Bun.spawn;

  return {
    async writeText(display: string, text: string): Promise<void> {
      const subprocess = spawn(["xclip", "-selection", "clipboard"], {
        env: { ...process.env, DISPLAY: display },
        stderr: "ignore",
        stdin: "pipe",
        stdout: "ignore"
      }) as ClipboardSubprocess;

      subprocess.stdin.write(text);
      subprocess.stdin.end();

      const exitCode = await subprocess.exited;
      if (exitCode !== 0) {
        throw new Error(`xclip exited with status ${exitCode}`);
      }
    }
  };
}
