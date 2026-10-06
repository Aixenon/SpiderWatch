//go:build linux

package agent

func AvailableMemory() (uint64, error) {
	data, err := ReadBounded("/proc/meminfo", 32<<10)
	if err != nil {
		return 0, err
	}
	memory, err := parseMemory(data)
	if err != nil {
		return 0, err
	}
	return memory.Available, nil
}
