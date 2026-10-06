type InstallTarget = { server: string; network: string; repository?: string };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function installCommands(target: InstallTarget, localHTTP = false): { windows: { label: string; url: string }[]; unix?: string } {
  const { server, network } = target;
  const commands: { windows: { label: string; url: string }[]; unix?: string } = { windows: [] };
  let endpoint: URL;
  try { endpoint = new URL(server); } catch { return commands; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(localHTTP && loopback && endpoint.protocol === "http:"))) return commands;
  const base = `${endpoint.origin}/downloads`;
  commands.windows = [{ label: "x64", arch: "amd64" }, { label: "ARM64", arch: "arm64" }, { label: "x86", arch: "386" }]
    .map(({ label, arch }) => ({ label, url: `${base}/spider-watch-windows-${arch}-setup.exe` }));
  commands.unix = `curl -fsS --connect-timeout 10 --max-time 120 ${shellQuote(endpoint.origin + "/install.sh")} | sh -s -- --server ${shellQuote(server)} --join ${shellQuote(network)}${localHTTP ? " --allow-local-http" : ""}`;
  return commands;
}
