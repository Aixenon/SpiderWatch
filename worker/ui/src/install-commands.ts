type InstallTarget = { server: string; network: string; repository?: string };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function installCommands(target: InstallTarget, localHTTP = false): { windows: { label: string; url: string }[]; unix?: string } {
  const { server, network, repository } = target;
  const commands: { windows: { label: string; url: string }[]; unix?: string } = { windows: [] };
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) return commands;
  const base = `https://github.com/${repository}/releases/latest/download`;
  commands.windows = [{ label: "x64", arch: "amd64" }, { label: "ARM64", arch: "arm64" }, { label: "x86", arch: "386" }]
    .map(({ label, arch }) => ({ label, url: `${base}/spider-watch-windows-${arch}-setup.exe` }));
  commands.unix = `(
  set -eu
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl --proto '=https' --proto-redir '=https' -fLsS --max-redirs 3 --max-filesize 65536 --connect-timeout 10 --max-time 120 ${shellQuote(base + "/install.sh")} -o "$installer"
  set -- --server ${shellQuote(server)} --join ${shellQuote(network)}${localHTTP ? " --allow-local-http" : ""}
  if [ "$(id -u)" -eq 0 ]; then sh "$installer" "$@"; else sudo sh "$installer" "$@"; fi
)`;
  return commands;
}
