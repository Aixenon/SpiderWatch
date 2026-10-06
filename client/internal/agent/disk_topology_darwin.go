//go:build darwin

package agent

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var darwinDiskTopology struct {
	sync.Mutex
	until    time.Time
	deadline time.Time
	rows     map[string][]PhysicalDisk
	pools    map[string]*apfsPool
	lookups  int
}

type diskutilOutput struct{ bytes.Buffer }

func (b *diskutilOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 1<<20 {
		return 0, errors.New("diskutil output exceeds limit")
	}
	return b.Buffer.Write(data)
}

func readDiskutil(ctx context.Context, args ...string) (diskPlist, error) {
	cmd := exec.CommandContext(ctx, "/usr/sbin/diskutil", args...)
	var out diskutilOutput
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return diskPlist{}, err
	}
	return decodeDiskPlist(bytes.NewReader(out.Bytes()))
}

func darwinVolumeInfo(source string) ([]PhysicalDisk, *apfsPool) {
	name := strings.TrimPrefix(source, "/dev/")
	if name == source || name == "" || strings.ContainsAny(name, `/\\`) || len(name) > 128 {
		return nil, nil
	}
	c := &darwinDiskTopology
	c.Lock()
	defer c.Unlock()
	now := time.Now()
	if c.rows == nil || !now.Before(c.until) {
		c.until, c.lookups = now.Add(5*time.Minute), 0
		c.deadline = now.Add(3 * time.Second)
		ctx, cancel := context.WithDeadline(context.Background(), c.deadline)
		defer cancel()
		data, _ := readDiskutil(ctx, "list", "-plist", "physical")
		c.rows = physicalDiskPlist(data)
		c.pools = make(map[string]*apfsPool)
		if apfs, err := readDiskutil(ctx, "apfs", "list", "-plist"); err == nil {
			addAPFSPhysicalDisks(c.rows, apfs)
			c.pools = apfsPoolPlist(apfs)
		}
	}
	if disks, ok := c.rows[name]; ok {
		return disks, c.pools[name]
	}
	if pool := c.pools[name]; pool != nil {
		return nil, pool
	}
	// Mounted APFS snapshots can have identifiers absent from `apfs list`.
	// Resolve their recorded parent via info, never by trimming disk names.
	// Bound fallback commands to four per refresh even on unusual mount tables.
	if (len(c.rows) == 0 && len(c.pools) == 0) || c.lookups >= 4 || !time.Now().Before(c.deadline) {
		return nil, nil
	}
	ctx, cancel := context.WithDeadline(context.Background(), c.deadline)
	defer cancel()
	c.lookups++
	c.rows[name] = nil
	if info, err := readDiskutil(ctx, "info", "-plist", source); err == nil {
		for _, key := range []string{"APFSVolumeDisk", "ParentWholeDisk"} {
			parent := info.dict[key].text
			if pool := c.pools[parent]; pool != nil {
				c.pools[name] = pool
			}
			if disks := c.rows[parent]; len(disks) != 0 {
				c.rows[name] = disks
			}
			if c.pools[name] != nil || len(c.rows[name]) != 0 {
				break
			}
		}
	}
	return c.rows[name], c.pools[name]
}
