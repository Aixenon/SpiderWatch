import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installCommands } from "../src/install-commands";

const target = { server: "https://monitor.example.com/#invite=one-time-token", network: "abc123network", repository: "Example/SpiderWatch" };
const windowsShell = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
  .filter((directory): directory is string => !!directory)
  .map(directory => join(directory, "Git", "usr", "bin", "sh.exe"))
  .find(path => existsSync(path));
const shell = process.platform === "win32" ? windowsShell : "/bin/sh";

// Every external operation is a shell function: these checks never download,
// create an installer, invoke sudo, or run an installation on the test host.
function run(command: string, options: { uid?: number; curlStatus?: number } = {}) {
  if (!shell) throw new Error("A POSIX shell is required for command execution checks");
  const result = spawnSync(shell, ["-c", `
mktemp() { printf '%s\\n' '/mock/installer'; }
rm() { :; }
curl() { printf 'curl:%s\\n' "$@" >&2; return ${options.curlStatus ?? 0}; }
id() { printf '%s\\n' '${options.uid ?? 0}'; }
sh() { printf '%s\\000' "$@"; }
sudo() { printf '%s\\n' 'sudo-called' >&2; "$@"; }
${command}
`], { encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  return { ...result, arguments: result.stdout ? result.stdout.split("\0").slice(0, -1) : [] };
}

describe("device installation commands", () => {
  it("offers all Windows packages and the Unix command for the deployment's fork", () => {
    const commands = installCommands({ ...target, repository: "AnotherOwner/monitor.fork_2" });
    const base = "https://github.com/AnotherOwner/monitor.fork_2/releases/latest/download";
    expect(commands.windows).toEqual([
      { label: "x64", url: `${base}/spider-watch-windows-amd64-setup.exe` },
      { label: "ARM64", url: `${base}/spider-watch-windows-arm64-setup.exe` },
      { label: "x86", url: `${base}/spider-watch-windows-386-setup.exe` },
    ]);
    expect(commands.unix).toContain(`${base}/install.sh`);
  });

  it.each([undefined, "", "../SpiderWatch", "Owner/../evil", "Owner/Repo/extra", "Owner/Repo?next=evil", "Owner/Repo#fragment", "https://github.com/Owner/Repo", "Owner/Repo\n", "Owner/Repo';echo injected"])(
    "does not offer downloads for an absent or invalid repository: %s", repository => {
      expect(installCommands({ ...target, repository })).toEqual({ windows: [] });
    },
  );
});

describe.skipIf(!shell)("Unix command execution with mocked operations", () => {
  it("passes invitation values literally without evaluating shell punctuation", () => {
    const server = "https://monitor.example.com/#invite='$(printf INJECTED)';\nexit 99;#";
    const network = "network ' \" $HOME `printf INJECTED` ; #";
    const result = run(installCommands({ ...target, server, network }).unix!);
    expect(result.status).toBe(0);
    expect(result.arguments).toEqual(["/mock/installer", "--server", server, "--join", network]);
    expect(result.stderr).not.toContain("sudo-called");
  });

  it("elevates the installer for an unprivileged user and preserves the local HTTP flag", () => {
    const result = run(installCommands(target, true).unix!, { uid: 1000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("sudo-called");
    expect(result.arguments).toEqual(["/mock/installer", "--server", target.server, "--join", target.network, "--allow-local-http"]);
  });

  it("does not run even a partial installer if curl fails", () => {
    const result = run(installCommands(target).unix!, { curlStatus: 22 });
    expect(result.status).toBe(22);
    expect(result.arguments).toEqual([]);
    expect(result.stderr).not.toContain("sudo-called");
  });

  it("downloads only through HTTPS with HTTP errors, size and time bounded", () => {
    const result = run(installCommands(target).unix!);
    expect(result.status).toBe(0);
    const arguments_ = result.stderr.trim().split("\n").map(line => line.replace(/^curl:/, ""));
    expect(arguments_).toContain("-fLsS");
    expect(arguments_).toContain("https://github.com/Example/SpiderWatch/releases/latest/download/install.sh");
    for (const [flag, value] of [["--proto", "=https"], ["--proto-redir", "=https"], ["--max-filesize", "65536"], ["--connect-timeout", "10"], ["--max-time", "120"]]) {
      expect(arguments_[arguments_.indexOf(flag) + 1]).toBe(value);
    }
  });
});
