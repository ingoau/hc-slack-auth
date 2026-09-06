import { spawn } from "node:child_process";

function pipeTo(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
    child.stdin.end(text);
  });
}

export async function copyToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await pipeTo("pbcopy", [], text);
    return;
  }
  if (process.platform === "win32") {
    await pipeTo("clip", [], text);
    return;
  }
  try {
    await pipeTo("wl-copy", [], text);
  } catch {
    await pipeTo("xclip", ["-selection", "clipboard"], text);
  }
}
