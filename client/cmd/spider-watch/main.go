package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"spiderwatch/client/internal/agent"
)

var version = "0.7.0-dev"

func main() {
	agent.ConfigureRuntime()
	if err := agent.EnforceProcessLimit(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), agent.StopSignals()...)
	defer stop()
	if handled, err := agent.RunAsSystemService(os.Args[1:], func(serviceContext context.Context, args []string) error {
		return execute(serviceContext, args, os.Stdout, os.Stderr)
	}); handled {
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintln(os.Stderr, "error:", err)
			if errors.Is(err, agent.ErrInsufficientMemory) {
				os.Exit(78)
			}
			if errors.Is(err, agent.ErrRevoked) {
				os.Exit(77)
			}
			if errors.Is(err, agent.ErrMemoryBudget) {
				os.Exit(75)
			}
			os.Exit(1)
		}
		return
	}
	if err := execute(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		if errors.Is(err, agent.ErrRevoked) {
			os.Exit(77)
		}
		if errors.Is(err, agent.ErrMemoryBudget) {
			os.Exit(75)
		}
		if errors.Is(err, agent.ErrInsufficientMemory) {
			os.Exit(78)
		}
		os.Exit(1)
	}
}

func execute(ctx context.Context, args []string, out, errOut io.Writer) (resultErr error) {
	if len(args) == 0 {
		usage(out)
		return nil
	}
	if args[0] == "version" {
		fmt.Fprintln(out, "spider-watch", version)
		return nil
	}
	if args[0] == "help" || args[0] == "--help" {
		usage(out)
		return nil
	}
	if args[0] == "--update" {
		args[0] = "update"
	}
	if args[0] == "internal-apply-update" {
		if len(args) != 1 {
			return errors.New("unexpected updater arguments")
		}
		return agent.ApplyPreparedUpdate(ctx)
	}
	// Accept the familiar --join NETWORK_ID spelling and a positional alias.
	if args[0] == "--join" || args[0] == "join" && len(args) > 1 && !strings.HasPrefix(args[1], "-") {
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			return errors.New("--join requires a network ID")
		}
		args = append([]string{"join", "--group", args[1]}, args[2:]...)
	} else if strings.HasPrefix(args[0], "--join=") {
		args = append([]string{"join", "--group", strings.TrimPrefix(args[0], "--join=")}, args[1:]...)
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(errOut)
	configPath := flags.String("config", agent.DefaultConfigPath(), "configuration path")
	switch args[0] {
	case "configure", "join":
		server := flags.String("server", "", "HTTPS collector base URL")
		group := new(string)
		if args[0] == "configure" {
			group = flags.String("join", "", "16-character alphanumeric network code; configure and request membership together")
		}
		if args[0] == "join" {
			group = flags.String("group", "", "network ID (also accepts --join NETWORK_ID)")
		}
		name := flags.String("name", "", "display name")
		ticketFile := flags.String("ticket-file", "", "optional legacy devserver ticket file")
		accessFile := flags.String("access-file", "", "Access JSON file (or CF_ACCESS_CLIENT_ID/SECRET)")
		interval := flags.Int("interval", 300, "pending/legacy HTTP interval (15..3600); WebSocket intervals come from panel")
		interfaces := flags.String("interfaces", "", "comma-separated interface allowlist")
		mounts := flags.String("mounts", "", "comma-separated absolute mount paths")
		caFile := flags.String("ca-file", "", "optional explicit PEM trust roots")
		localHTTP := flags.Bool("allow-local-http", false, "allow HTTP only to a literal loopback IP")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("unexpected positional arguments")
		}
		var invitation string
		if *server != "" {
			clean, invite, parseErr := agent.ParseJoinServer(*server)
			if parseErr != nil {
				return parseErr
			}
			*server, invitation = clean, invite
		}
		*group = agent.NormalizeNetworkCode(*group)
		if args[0] == "configure" && *group != "" && !agent.ValidJoinCode(*group) {
			return errors.New("--join requires 16 letters or digits (legacy twelve-digit IDs are also accepted)")
		}
		restartInstalled, err := agent.PauseInstalledService(*configPath)
		if err != nil {
			return err
		}
		defer func() {
			if restartInstalled {
				restoreErr := agent.PrepareInstalledConfig(*configPath)
				if restoreErr == nil {
					_, restoreErr = agent.StartInstalledService(*configPath)
				}
				if restoreErr != nil {
					resultErr = errors.Join(resultErr, errors.New("could not restore the installed service; verify configuration permissions and start it again"))
				}
			}
		}()
		lock, err := agent.AcquireLock(*configPath)
		if err != nil {
			return err
		}
		defer lock.Close()
		visited := map[string]bool{}
		flags.Visit(func(f *flag.Flag) { visited[f.Name] = true })
		c, loadErr := agent.LoadSetupConfig(*configPath)
		alreadyRegistered := loadErr == nil && c.Group != "" && c.IdentityMode == "ed25519"
		if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
			return loadErr
		}
		if errors.Is(loadErr, os.ErrNotExist) {
			c, err = agent.NewConfig()
			if err != nil {
				return err
			}
			c.Access = agent.AccessCredentials{ClientID: os.Getenv("CF_ACCESS_CLIENT_ID"), ClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET")}
		}
		if c.Group != "" && ((*server != "" && strings.TrimRight(*server, "/") != c.Server) || (*group != "" && *group != c.Group)) {
			return errors.New("already joined another server or network; stop the service and leave before switching")
		}
		if visited["server"] {
			c.Server = strings.TrimRight(*server, "/")
		}
		if invitation != "" {
			if err = c.EnsureIdentity(); err != nil {
				return err
			}
			c.IdentityMode, c.Invitation, c.Gate = "ed25519", invitation, ""
			c.Access = agent.AccessCredentials{}
		}
		if visited["name"] {
			c.Name = *name
		}
		if args[0] == "configure" && visited["join"] {
			if !agent.ValidJoinCode(*group) {
				return errors.New("--join requires 16 letters or digits (legacy twelve-digit IDs are also accepted)")
			}
			c.Bootstrap, c.Name = true, ""
		}
		if visited["interval"] {
			c.Interval = *interval
		}
		if visited["allow-local-http"] {
			c.AllowLocalHTTP = *localHTTP
		}
		if visited["ca-file"] {
			c.CAFile = *caFile
		}
		if visited["interfaces"] {
			c.Interfaces = splitList(*interfaces)
		}
		if visited["mounts"] {
			c.Mounts = splitList(*mounts)
		}
		if *accessFile != "" {
			c.Access, err = agent.LoadAccess(*accessFile)
			if err != nil {
				return err
			}
		} else if os.Getenv("CF_ACCESS_CLIENT_ID") != "" || os.Getenv("CF_ACCESS_CLIENT_SECRET") != "" {
			c.Access = agent.AccessCredentials{ClientID: os.Getenv("CF_ACCESS_CLIENT_ID"), ClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET")}
		}
		// Save the stable identity before the network call, but only persist a
		// new network selection after a successful enrollment response.
		if err = agent.SaveSetupConfig(*configPath, c); err != nil {
			return err
		}
		if args[0] == "configure" && !visited["join"] {
			return printJSON(out, map[string]string{"node_id": c.NodeID, "state": "configured", "config": *configPath})
		}
		if *group != "" {
			c.Group = *group
		}
		ticket := strings.TrimSpace(os.Getenv("CF_MONITOR_JOIN_TICKET"))
		if *ticketFile != "" {
			b, err := agent.ReadBounded(*ticketFile, 1024)
			if err != nil {
				return err
			}
			ticket = strings.TrimSpace(string(b))
		}
		client, err := agent.NewClient(c)
		if err != nil {
			return err
		}
		defer client.Close()
		var response agent.ControlResponse
		if alreadyRegistered {
			response, err = client.Status(ctx)
			var rejected *agent.HTTPError
			if c.Invitation != "" && ((errors.As(err, &rejected) && rejected.Code == "revoked") || (err == nil && response.State == "pending")) {
				response, err = client.Join(ctx, ticket, agent.NewCollector(c, version).Host())
			}
		} else {
			response, err = client.Join(ctx, ticket, agent.NewCollector(c, version).Host())
		}
		if err != nil {
			return err
		}
		c.Invitation = "" // One-use bootstrap credential is no longer needed.
		if err = agent.SaveConfig(*configPath, c); err != nil {
			return err
		}
		// Release the configuration lock before the installed background service
		// reads it. Setup is a single operation even when approval is still pending.
		lock.Close()
		if err = agent.PrepareInstalledConfig(*configPath); err != nil {
			return err
		}
		service, err := agent.StartInstalledService(*configPath)
		if err != nil {
			return err
		}
		restartInstalled = false
		return printJSON(out, map[string]string{"node_id": c.NodeID, "network": c.Group, "state": response.State, "config": *configPath, "service": service})
	case "run":
		once := flags.Bool("once", false, "perform one status or report operation and exit")
		waitConfig := flags.Bool("wait-config", false, "installed service: wait quietly for initial configuration")
		verbose := flags.Bool("verbose", false, "print rate-limited lifecycle messages")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if err := agent.CheckStartupMemory(); err != nil {
			return err
		}
		if *waitConfig {
			if err := agent.WaitForConfig(ctx, *configPath); err != nil {
				return err
			}
		}
		c, err := agent.LoadConfig(*configPath)
		if err != nil {
			return err
		}
		lock, err := agent.AcquireLock(*configPath)
		if err != nil {
			return err
		}
		defer lock.Close()
		logger := log.New(io.Discard, "", 0)
		if *verbose {
			logger = log.New(errOut, "spider-watch: ", log.LstdFlags)
		}
		return agent.Run(ctx, c, agent.RunOptions{ConfigPath: *configPath, Version: version, Once: *once, Logger: logger})
	case "update":
		checkOnly := flags.Bool("check", false, "check for a newer stable version without downloading or installing it")
		automatic := flags.Bool("automatic", false, "honor the panel's per-device automatic update setting")
		requested := flags.Bool("requested", false, "handle one pending panel update through the installed service")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("unexpected positional arguments")
		}
		if *requested {
			if *automatic || *checkOnly {
				return errors.New("--requested cannot be combined with --automatic or --check")
			}
			if err := agent.PrepareRequestedUpdate(*configPath); err != nil {
				return err
			}
		}
		c, err := agent.LoadConfig(*configPath)
		if *automatic && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if err = agent.ValidateInstalledUpdateSource(*configPath, &c); err != nil {
			return err
		}
		client, err := agent.NewClient(c)
		if err != nil {
			return err
		}
		defer client.Close()
		if *requested {
			result, err := client.RequestedUpdate(ctx, version, *configPath)
			if err != nil {
				return err
			}
			return printJSON(out, result)
		}
		var plan agent.UpdatePlan
		if *automatic {
			plan, err = client.CheckAutomaticUpdate(ctx, version)
		} else {
			plan, err = client.CheckUpdate(ctx, version)
		}
		if err != nil {
			return err
		}
		if *checkOnly || !plan.Available {
			return printJSON(out, plan)
		}
		if err = agent.CheckStartupMemory(); err != nil {
			return err
		}
		resultPath, err := client.ScheduleUpdate(ctx, plan, *configPath)
		if err != nil {
			return err
		}
		if runtime.GOOS != "windows" {
			return printJSON(out, map[string]string{"state": "installed", "version": plan.Version, "result_file": resultPath})
		}
		return printJSON(out, map[string]string{"state": "installing", "version": plan.Version, "result_file": resultPath, "message": "installation finishes after this command exits; inspect result_file for installed or failed"})
	case "status", "leave":
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		c, err := agent.LoadConfig(*configPath)
		if err != nil {
			return err
		}
		var lock *agent.RunLock
		if args[0] == "leave" {
			lock, err = agent.AcquireLock(*configPath)
			if err != nil {
				return err
			}
			defer lock.Close()
		}
		client, err := agent.NewClient(c)
		if err != nil {
			return err
		}
		defer client.Close()
		if args[0] == "leave" {
			if _, err = client.Leave(ctx); err != nil {
				return err
			}
			c.Group = ""
			if err = agent.SaveSetupConfig(*configPath, c); err != nil {
				return err
			}
			return printJSON(out, map[string]string{"node_id": c.NodeID, "state": "left"})
		}
		response, err := client.Status(ctx)
		if err != nil {
			return err
		}
		return printJSON(out, map[string]any{"node_id": c.NodeID, "group": c.Group, "state": response.State})
	case "collect":
		mounts := flags.String("mounts", "", "comma-separated mount paths")
		interfaces := flags.String("interfaces", "", "comma-separated interface allowlist")
		window := flags.Duration("window", time.Second, "counter sampling window (100ms..10s)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *window < 100*time.Millisecond || *window > 10*time.Second {
			return errors.New("window must be 100ms..10s")
		}
		c, err := agent.NewConfig()
		if err != nil {
			return err
		}
		if *mounts != "" {
			c.Mounts = splitList(*mounts)
		}
		if *interfaces != "" {
			c.Interfaces = splitList(*interfaces)
		}
		if len(c.Mounts) > agent.MaxMounts || len(c.Interfaces) > agent.MaxInterfaces {
			return errors.New("too many mounts or interfaces")
		}
		collector := agent.NewCollector(c, version)
		collector.Collect(time.Now())
		timer := time.NewTimer(*window)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		return printJSON(out, map[string]any{"host": collector.Host(), "metrics": collector.Collect(time.Now())})
	case "doctor":
		offline := flags.Bool("offline", false, "check local resources without connecting")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		result := map[string]any{"runtime_limit_bytes": agent.RuntimeMemoryLimit, "rss_limit_bytes": agent.MaxRSSBytes, "minimum_available_bytes": agent.MinimumAvailableBytes}
		available, availableErr := agent.AvailableMemory()
		result["available_bytes"], result["startup_memory_ok"] = available, availableErr == nil && available >= agent.MinimumAvailableBytes
		rss, rssErr := agent.ProcessRSS()
		result["rss_bytes"], result["rss_supported"] = rss, rssErr == nil
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		if info, err := os.Stat(executable); err == nil {
			result["binary_bytes"] = info.Size()
			result["binary_within_budget"] = info.Size() <= agent.MaxBinaryBytes
		}
		if !*offline {
			c, err := agent.LoadConfig(*configPath)
			if err != nil {
				return err
			}
			client, err := agent.NewClient(c)
			if err != nil {
				return err
			}
			defer client.Close()
			response, err := client.Status(ctx)
			if err != nil {
				return err
			}
			result["state"] = response.State
		}
		if err = printJSON(out, result); err != nil {
			return err
		}
		return agent.CheckMemoryBudget()
	case "service":
		if runtime.GOOS != "linux" {
			return errors.New("systemd service generation is supported on Linux")
		}
		user := flags.String("user", "spider-watch", "existing service account")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		absoluteConfig, err := filepath.Abs(*configPath)
		if err != nil {
			return err
		}
		unit, err := agent.SystemdUnit(executable, absoluteConfig, *user)
		if err != nil {
			return err
		}
		_, err = io.WriteString(out, unit)
		return err
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func printJSON(out io.Writer, value any) error { return json.NewEncoder(out).Encode(value) }

func splitList(s string) []string {
	var result []string
	for _, value := range strings.Split(s, ",") {
		if v := strings.TrimSpace(value); v != "" {
			result = append(result, v)
		}
	}
	return result
}

func usage(out io.Writer) {
	fmt.Fprintln(out, `spider-watch: low-resource background network monitor

Commands:
  configure --server HTTPS_URL --join NETWORK_CODE: redeem an invitation and start the installed service
  --join ID request network membership (join ID is an alias)
  join      request membership; approval persists across reconnects
  run       wait for approval, then collect and upload (quiet by default)
  status    query device approval state without exposing credentials
  --update  check and install a newer stable release (update is an alias)
  update --check  inspect the advertised release without downloading it
  leave     leave the network and keep local identity (stop service first)
  collect   print one local metrics snapshot; no account required
  doctor    diagnose connectivity and local resource budget
  service   print a systemd unit with a 32 MiB hard memory limit
  version   print version

Use <command> -h for options. Copy a 5-minute, single-device join command
from the panel. SpiderWatch generates and saves its own Ed25519 key and UUID;
the private key stays on this device. A valid invitation joins immediately.
New invitations use signed HTTPS/WebSocket requests without machine Access tokens.
Optional Access credentials remain supported for older deployments.`)
}
