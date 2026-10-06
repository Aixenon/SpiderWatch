#!/bin/sh
# Linux and macOS bootstrap; binaries are independent of Linux distribution/libc.
set -eu
repo=${SPIDER_WATCH_REPOSITORY:-__SPIDER_REPOSITORY__}
version=__SPIDER_VERSION__
arch=
prefix=/usr/local/bin
service=yes
detect_only=no
server=
join=
allow_local_http=no
die() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--version|--arch|--prefix|--server|--join) [ "$#" -ge 2 ] && [ -n "$2" ] || die "Missing value for $1"; key=$1; value=$2; shift 2
      case "$key" in --repo) repo=$value;; --version) version=$value;; --arch) arch=$value;; --prefix) prefix=$value;; --server) server=$value;; --join) join=$value;; esac;;
    --no-service) service=no; shift;;
    --detect) detect_only=yes; shift;;
    --allow-local-http) allow_local_http=yes; shift;;
    *) die "Usage: install.sh --repo OWNER/REPO [--version vX.Y.Z] [--arch ARCH] [--server URL --join NETWORK_CODE] [--no-service --prefix DIR]";;
  esac
done
if [ -n "$server" ] || [ -n "$join" ]; then
  [ -n "$server" ] && [ -n "$join" ] || die '--server and --join must be used together.'
  printf '%s' "$join" | grep -Eq '^([A-Za-z0-9]{16}|[0-9]{12})$' || die 'Invalid network code.'
  case "$server" in https://*) ;; http://*) [ "$allow_local_http" = yes ] || die 'The server must use HTTPS.';; *) die 'The server must use HTTPS.';; esac
fi
configure() {
  [ -n "$server" ] || return 0
  set -- configure --server "$server" --join "$join"
  [ "$allow_local_http" = no ] || set -- "$@" --allow-local-http
  "$prefix/spider-watch" "$@"
}
system=$(uname -s)
case "$system" in Linux) goos=linux;; Darwin) goos=darwin;; *) die "Unsupported OS: $system. Windows: use the setup.exe installer.";; esac
if [ -z "$arch" ]; then
  machine=$(uname -m)
  bits=; endian=
  if [ "$goos" = linux ]; then
    # Kernel architecture can differ from userspace (e.g. ARM64 + 32-bit rootfs).
    set -- $(od -An -tu1 -N6 /bin/sh 2>/dev/null || true)
    if [ "$#" -eq 6 ] && [ "$1 $2 $3 $4" = '127 69 76 70' ]; then bits=$5; endian=$6; fi
  fi
  case "$machine" in
    x86_64|amd64) if [ "$bits" = 1 ]; then arch=386; else arch=amd64; fi;;
    i?86) arch=386;;
    aarch64|arm64) if [ "$bits" = 1 ]; then arch=armv5; else arch=arm64; fi;;
    arm*)
      # ARMv5 software FP is the safe fallback, including soft-float userspace.
      arch=armv5
      if grep -Eq 'Features.*vfpv3|Features.*vfpv4' /proc/cpuinfo 2>/dev/null; then arch=armv7
      elif grep -Eq 'Features.*vfp' /proc/cpuinfo 2>/dev/null; then arch=armv6; fi;;
    mips*)
      [ -n "$bits" ] && [ -n "$endian" ] || die 'Cannot detect MIPS ABI; specify --arch.'
      arch=mips; [ "$bits" != 2 ] || arch=mips64; [ "$endian" != 1 ] || arch=${arch}le; arch=${arch}-softfloat;;
    riscv64) [ "$bits" != 1 ] || die 'RISC-V 32-bit is not supported by Go'; arch=riscv64;;
    loongarch64) arch=loong64;;
    ppc64le) arch=ppc64le;;
    s390x) arch=s390x;;
    *) die "Unsupported architecture: $machine";;
  esac
fi
case "$goos-$arch" in
  darwin-amd64|darwin-arm64|linux-amd64|linux-386|linux-armv5|linux-armv6|linux-armv7|linux-arm64|linux-mips-softfloat|linux-mipsle-softfloat|linux-mips64-softfloat|linux-mips64le-softfloat|linux-riscv64|linux-loong64|linux-ppc64le|linux-s390x) ;;
  *) die "Unsupported target: $goos-$arch";;
esac
artifact=spider-watch-$goos-$arch
if [ "$detect_only" = yes ]; then printf '%s\n' "$artifact"; exit 0; fi
printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$' || die 'Specify --repo OWNER/REPO.'
[ "$version" = latest ] || printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die 'Version must be latest or vX.Y.Z.'
command -v curl >/dev/null 2>&1 || die 'curl and CA certificates are required.'
if [ "$service" = yes ]; then
  [ "$(id -u)" = 0 ] || die 'Run the installer with sudo, or use --no-service.'
  [ "$prefix" = /usr/local/bin ] || die 'Custom prefix requires --no-service.'
  if [ "$goos" = darwin ]; then manager=launchd
  elif command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then manager=systemd
  elif command -v rc-service >/dev/null 2>&1; then manager=openrc
  elif [ -f /etc/rc.common ] && command -v procd >/dev/null 2>&1; then manager=procd
  else die 'No supported service manager (systemd/OpenRC/procd/launchd); use --no-service.'; fi
  prefix=/opt/spider-watch
  [ ! -L /opt ] && [ ! -L "$prefix" ] || die 'Unsafe program directory.'
  mkdir -p "$prefix"
  for directory in /opt "$prefix"; do
    if [ "$goos" = darwin ]; then ownership=$(stat -f '%u %Lp' "$directory"); else ownership=$(stat -c '%u %a' "$directory"); fi
    set -- $ownership
    [ "$1" = 0 ] && [ "$((0$2 & 0022))" = 0 ] || die 'Program directories must be root-owned and not group/world writable.'
  done
fi
case "$prefix" in /*) ;; *) die 'Prefix must be absolute.';; esac
mkdir -p "$prefix"
[ ! -L "$prefix/spider-watch" ] || die 'Refusing to overwrite a symbolic link.'
stage=$(mktemp -d "$prefix/.spider-watch-install.XXXXXX")
trap 'rm -f "$stage/download" "$stage/checksums" "$stage/manifest"; rmdir "$stage"' EXIT HUP INT TERM
download() { curl --fail --silent --show-error --location --max-redirs 3 --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 180 --max-filesize "$3" "$1" -o "$2"; }
if [ "$version" = latest ]; then
  download "https://github.com/$repo/releases/latest/download/update-manifest.json" "$stage/manifest" 65536
  number=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9.]*\)".*/\1/p' "$stage/manifest")
  printf '%s' "$number" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'Invalid release version.'
  version=v$number
fi
base=https://github.com/$repo/releases/download/$version
download "$base/checksums.txt" "$stage/checksums" 16384
expected=$(awk -v name="$artifact" '$2==name {print $1}' "$stage/checksums")
printf '%s' "$expected" | grep -Eq '^[a-f0-9]{64}$' || die 'Missing/duplicate SHA-256 for this platform.'
download "$base/$artifact" "$stage/download" 16777216
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/download" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$stage/download" | awk '{print $1}')
else die 'A SHA-256 utility is required.'; fi
[ "$actual" = "$expected" ] || die 'SHA-256 mismatch.'
chmod 755 "$stage/download"
[ "$("$stage/download" version)" = "spider-watch ${version#v}" ] || die 'Executable self-check failed.'
if [ "$service" = yes ]; then
  case "$manager" in
    systemd) systemctl stop spider-watch.service 2>/dev/null || true;;
    openrc) rc-service spider-watch stop 2>/dev/null || true;;
    procd) /etc/init.d/spider-watch stop 2>/dev/null || true;;
    launchd) launchctl bootout system/io.spiderwatch.monitor 2>/dev/null || true;;
  esac
fi
mv -f "$stage/download" "$prefix/spider-watch"
if [ "$service" = no ]; then configure; printf 'Installed %s/spider-watch\n' "$prefix"; exit 0; fi
mkdir -p /usr/local/bin
[ ! -d /usr/local/bin/spider-watch ] || die 'CLI link is a directory.'
ln -sfn /opt/spider-watch/spider-watch /usr/local/bin/spider-watch
account=spider-watch
if [ "$goos" = darwin ]; then
  account=_spiderwatch
  if ! id "$account" >/dev/null 2>&1; then
    uid=400
    while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$((uid+1)); [ "$uid" -lt 500 ] || die 'No free service UID.'; done
    dscl . -create /Users/$account
    dscl . -create /Users/$account UniqueID "$uid"
    dscl . -create /Users/$account PrimaryGroupID 1
    dscl . -create /Users/$account UserShell /usr/bin/false
    dscl . -create /Users/$account NFSHomeDirectory /var/empty
    dscl . -create /Users/$account IsHidden 1
    dscl . -create /Users/$account Password '*'
  fi
elif ! id "$account" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd --system --no-create-home --shell /bin/false "$account"
  else addgroup -S "$account"; adduser -S -D -H -s /bin/false -G "$account" "$account"; fi
fi
root=/var/lib/spider-watch
config=$root/state/config.json
[ ! -L "$root" ] && [ ! -L "$root/state" ] || die 'Unsafe state directory.'
mkdir -p "$root/state"
chown 0:0 "$root"; chmod 755 "$root"
chown "$account" "$root/state"; chmod 700 "$root/state"
case "$manager" in
 systemd)
  "$prefix/spider-watch" service --config "$config" --user "$account" > /etc/systemd/system/spider-watch.service
  cat > /etc/systemd/system/spider-watch-update.service <<'EOF'
[Unit]
Description=SpiderWatch update check
[Service]
Type=oneshot
ExecStart=/opt/spider-watch/spider-watch update --automatic --config /var/lib/spider-watch/state/config.json
TimeoutStartSec=300
UMask=0077
EOF
  cat > /etc/systemd/system/spider-watch-update.timer <<'EOF'
[Unit]
Description=SpiderWatch periodic update
[Timer]
OnBootSec=15min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  printf 'systemd\n' > "$root/service-installed"
  systemctl enable --now spider-watch.service spider-watch-update.timer;;
 openrc)
  cat > /etc/init.d/spider-watch <<'EOF'
#!/sbin/openrc-run
description="SpiderWatch network monitor"
command="/opt/spider-watch/spider-watch"
command_args="run --wait-config --config /var/lib/spider-watch/state/config.json"
command_user="spider-watch"
supervisor="supervise-daemon"
respawn_delay=30
respawn_max=3
respawn_period=300
depend() { need net; }
EOF
  chmod 755 /etc/init.d/spider-watch
  printf 'openrc\n' > "$root/service-installed"
  rc-update add spider-watch default; rc-service spider-watch start;;
 procd)
  cat > /etc/init.d/spider-watch <<'EOF'
#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1
start_service() {
 procd_open_instance
 procd_set_param command /opt/spider-watch/spider-watch run --wait-config --config /var/lib/spider-watch/state/config.json
 procd_set_param user spider-watch
 procd_set_param respawn 300 30 3
 procd_set_param limits core="0 0"
 procd_close_instance
}
EOF
  chmod 755 /etc/init.d/spider-watch
  printf 'procd\n' > "$root/service-installed"
  /etc/init.d/spider-watch enable; /etc/init.d/spider-watch start;;
 launchd)
  cat > /Library/LaunchDaemons/io.spiderwatch.monitor.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.spiderwatch.monitor</string>
<key>ProgramArguments</key><array><string>/opt/spider-watch/spider-watch</string><string>run</string><string>--wait-config</string><string>--config</string><string>/var/lib/spider-watch/state/config.json</string></array>
<key>UserName</key><string>_spiderwatch</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>60</integer><key>Nice</key><integer>10</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
EOF
  cat > /Library/LaunchDaemons/io.spiderwatch.update.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.spiderwatch.update</string>
<key>ProgramArguments</key><array><string>/opt/spider-watch/spider-watch</string><string>update</string><string>--automatic</string><string>--config</string><string>/var/lib/spider-watch/state/config.json</string></array>
<key>StartInterval</key><integer>21600</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
EOF
  chmod 644 /Library/LaunchDaemons/io.spiderwatch.*.plist
  printf 'launchd\n' > "$root/service-installed"
  launchctl bootstrap system /Library/LaunchDaemons/io.spiderwatch.monitor.plist
  launchctl bootout system/io.spiderwatch.update 2>/dev/null || true
  launchctl bootstrap system /Library/LaunchDaemons/io.spiderwatch.update.plist;;
esac
if [ "$manager" = openrc ] || [ "$manager" = procd ]; then
  if command -v crontab >/dev/null 2>&1; then
    { crontab -l 2>/dev/null | grep -v '# spider-watch-update$' || true; printf '17 */6 * * * /opt/spider-watch/spider-watch update --automatic --config /var/lib/spider-watch/state/config.json >/dev/null 2>&1 # spider-watch-update\n'; } | crontab -
  else printf 'No cron available: use sudo spider-watch --update for updates.\n'; fi
fi
if [ -n "$server" ]; then
  configure
  printf 'Installed and registered. SpiderWatch is running as a system service.\n'
else
  printf 'Installed. Copy the registration command from the panel, then run it with sudo.\n'
fi
