package agent

import "time"

const ProtocolVersion = 1

type HostInfo struct {
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	Kernel       string `json:"kernel,omitempty"`
	CPUs         int    `json:"cpus"`
	LogicalCPUs  int    `json:"logical_cpus,omitempty"`
	CPUModel     string `json:"cpu_model,omitempty"`
	PhysicalCPUs int    `json:"physical_cpus,omitempty"`
	Version      string `json:"agent_version,omitempty"`
	Revision     string `json:"agent_revision,omitempty"`
}

// Live protocol 2 binds identity/version to the authenticated connection. Only
// metadata that can change between agent runs travels in its one hello frame.
type LiveHello struct {
	Type          string   `json:"type"`
	Protocol      int      `json:"protocol"`
	Session       string   `json:"session"`
	UpdateControl int      `json:"update_control"`
	Host          HostInfo `json:"host"`
}

type LiveMetrics struct {
	Type     string   `json:"type"`
	Sequence uint64   `json:"sequence"`
	Metrics  Snapshot `json:"metrics"`
}

type CPUDetails struct {
	User   *float64 `json:"user_percent,omitempty"`
	System *float64 `json:"system_percent,omitempty"`
	Idle   *float64 `json:"idle_percent,omitempty"`
	IOWait *float64 `json:"iowait_percent,omitempty"`
	Steal  *float64 `json:"steal_percent,omitempty"`
}

type MemoryMetrics struct {
	Free          *uint64 `json:"free_bytes,omitempty"`
	Cached        *uint64 `json:"cached_bytes,omitempty"`
	Buffers       *uint64 `json:"buffers_bytes,omitempty"`
	Active        *uint64 `json:"active_bytes,omitempty"`
	Inactive      *uint64 `json:"inactive_bytes,omitempty"`
	Wired         *uint64 `json:"wired_bytes,omitempty"`
	Committed     *uint64 `json:"committed_bytes,omitempty"`
	CommitLimit   *uint64 `json:"commit_limit_bytes,omitempty"`
	Total         uint64  `json:"total_bytes"`
	Available     uint64  `json:"available_bytes"`
	Used          uint64  `json:"used_bytes"`
	SwapTotal     uint64  `json:"swap_total_bytes"`
	SwapUsed      uint64  `json:"swap_used_bytes"`
	SwapSupported bool    `json:"swap_supported"`
	Estimated     bool    `json:"available_estimated,omitempty"`
}

type PhysicalDisk struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size uint64 `json:"size_bytes,omitempty"`
}

type DiskMetrics struct {
	PhysicalDisks []PhysicalDisk `json:"physical_disks,omitempty"`
	VolumeID      string         `json:"volume_id,omitempty"`
	Device        string         `json:"device,omitempty"`
	Label         string         `json:"label,omitempty"`
	Filesystem    string         `json:"filesystem,omitempty"`
	CapacityGroup string         `json:"capacity_group,omitempty"`
	PoolTotal     *uint64        `json:"pool_total_bytes,omitempty"`
	PoolAvailable *uint64        `json:"pool_available_bytes,omitempty"`
	MountCount    int            `json:"mount_count,omitempty"`
	Mount         string         `json:"mount"`
	Total         uint64         `json:"total_bytes"`
	Available     uint64         `json:"available_bytes"`
	Used          uint64         `json:"used_bytes"`
}

type NetworkMetrics struct {
	rxRate, txRate float64  // Backing values for optional rates; owned by this snapshot.
	Name           string   `json:"name"`
	RXBytes        uint64   `json:"rx_bytes"`
	TXBytes        uint64   `json:"tx_bytes"`
	RXPerSec       *float64 `json:"rx_bytes_per_second,omitempty"`
	TXPerSec       *float64 `json:"tx_bytes_per_second,omitempty"`
	CounterReset   bool     `json:"counter_reset,omitempty"`
}

type Snapshot struct {
	CPU         *CPUDetails      `json:"cpu_detail,omitempty"`
	Time        time.Time        `json:"time"`
	CPUPercent  *float64         `json:"cpu_percent,omitempty"`
	Memory      *MemoryMetrics   `json:"memory,omitempty"`
	Uptime      *float64         `json:"uptime_seconds,omitempty"`
	Disks       []DiskMetrics    `json:"disks"`
	Networks    []NetworkMetrics `json:"networks"`
	RSSBytes    uint64           `json:"agent_rss_bytes,omitempty"`
	Goroutines  int              `json:"agent_goroutines"`
	Unavailable []string         `json:"unavailable,omitempty"`
}

type JoinRequest struct {
	Protocol  int      `json:"protocol"`
	NodeID    string   `json:"node_id"`
	Group     string   `json:"group"`
	Name      string   `json:"name,omitempty"`
	DeviceKey string   `json:"device_key,omitempty"`
	PublicKey string   `json:"public_key,omitempty"`
	Ticket    string   `json:"ticket,omitempty"` // Optional only for the legacy local devserver.
	Host      HostInfo `json:"host"`
}

type ControlResponse struct {
	Access          *AccessCredentials `json:"access,omitempty"`
	State           string             `json:"state"`
	Code            string             `json:"code,omitempty"`
	Interval        int                `json:"interval_seconds,omitempty"`
	Transport       string             `json:"transport,omitempty"`
	UpdateRequestID string             `json:"update_request_id,omitempty"`
}

type ReportRequest struct {
	UpdateControl int      `json:"update_control,omitempty"`
	Protocol      int      `json:"protocol"`
	NodeID        string   `json:"node_id"`
	Session       string   `json:"session"`
	Sequence      uint64   `json:"sequence"`
	Host          HostInfo `json:"host"`
	Metrics       Snapshot `json:"metrics"`
}
