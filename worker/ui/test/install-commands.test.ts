import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installCommands } from "../src/install-commands";

const target = { server: "https://monitor.example.com/#invite=one-time-token", network: "abc123network" };
const windowsShell = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
  .filter((directory): directory is string => !!directory)
  .map(directory => join(directory, "Git", "usr", "bin", "sh.exe"))
  .find(path => existsSync(path));
const shell = process.platform === "win32" ? windowsShell : "/bin/sh";

// No downloads, installation, or privilege changes run on the test host.
function run(command: string) {
  if (!shell) throw new Error("A POSIX shell is required for command execution checks");
  const result = spawnSync(shell, ["-c", `
curl() { printf 'curl:%s\\n' "$@" >&2; }
sh() { printf '%s\\000' "$@"; }
${command}
`], { encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  return { ...result, arguments: result.stdout ? result.stdout.split("\0").slice(0, -1) : [] };
}

describe("device installation commands", () => {
  it("offers all Windows installers and install.sh on the panel's own Worker", () => {
    const commands = installCommands(target);
    const base = "https://monitor.example.com/panel/downloads";
    expect(commands.windows).toEqual([
      { label: "x64", url: `${base}/spider-watch-windows-amd64-setup.exe` },
      { label: "ARM64", url: `${base}/spider-watch-windows-arm64-setup.exe` },
      { label: "x86", url: `${base}/spider-watch-windows-386-setup.exe` },
    ]);
    expect(commands.unix).toContain("'https://monitor.example.com/install.sh' | sh -s --");
    expect(commands.unix).not.toContain("github.com");
    expect(commands.unix).not.toContain("\n");
  });

  it("does not depend on a public GitHub repository", () => {
    expect(installCommands({ ...target, repository: "Private/Repository" })).toEqual(installCommands(target));
  });

  it.each(["", "javascript:alert(1)", "//other.example", "http://monitor.example.com", "https://user:password@monitor.example.com"])(
    "rejects an unsafe server: %s", server => {
      expect(installCommands({ ...target, server })).toEqual({ windows: [] });
    },
  );

  it("allows HTTP only when explicitly enabled on loopback", () => {
    const local = { ...target, server: "http://127.0.0.1:8788/#invite=local" };
    expect(installCommands(local)).toEqual({ windows: [] });
    expect(installCommands(local, true).unix).toContain("'http://127.0.0.1:8788/install.sh'");
    expect(installCommands(local, true).unix).toContain("--allow-local-http");
    expect(installCommands({ ...target, server: "http://other.example/" }, true)).toEqual({ windows: [] });
  });
});

describe.skipIf(!shell)("Unix command execution with mocked operations", () => {
  it("passes invitation values literally without evaluating shell punctuation", () => {
    const server = "https://monitor.example.com/#invite='$(printf INJECTED)';exit 99;#";
    const network = "network ' \" $HOME `printf INJECTED` ; #";
    const result = run(installCommands({ ...target, server, network }).unix!);
    expect(result.status).toBe(0);
    expect(result.arguments).toEqual(["-s", "--", "--server", server, "--join", network]);
  });

  it("downloads the canonical script without redirecting to another host and uses bounded timeouts", () => {
    const result = run(installCommands(target).unix!);
    expect(result.status).toBe(0);
    const args = result.stderr.trim().split("\n").map(line => line.replace(/^curl:/, ""));
    expect(args).toEqual(["-fsS", "--connect-timeout", "10", "--max-time", "120", "https://monitor.example.com/install.sh"]);
  });
});
