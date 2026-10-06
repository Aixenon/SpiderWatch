package agent

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

func SystemdUnit(executable, configPath, user string) (string, error) {
	for _, value := range []string{executable, configPath, user} {
		if strings.ContainsAny(value, "\r\n\x00\"\\%") {
			return "", errors.New("unsupported character in service path or user")
		}
	}
	if !filepath.IsAbs(executable) || !filepath.IsAbs(configPath) || user == "" || strings.ContainsAny(user, " \t") {
		return "", errors.New("service requires absolute paths and a service user")
	}
	return fmt.Sprintf(`[Unit]
Description=SpiderWatch network monitor
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=%s
ExecStart="%s" run --wait-config --config "%s"
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=77 78
MemoryAccounting=true
MemoryHigh=28M
MemoryMax=32M
MemorySwapMax=0
LimitCORE=0
Nice=10
CPUAccounting=true
CPUQuota=10%%
TasksMax=32
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths="%s"
PrivateTmp=true
StandardOutput=null
StandardError=journal
LogRateLimitIntervalSec=1h
LogRateLimitBurst=20

[Install]
WantedBy=multi-user.target
`, user, executable, configPath, filepath.Dir(configPath)), nil
}
