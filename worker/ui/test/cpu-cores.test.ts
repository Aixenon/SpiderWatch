import { describe, expect, it, vi } from "vitest";
import { cpuCoreCounts } from "../src/format";

vi.mock("../src/monitor", () => ({ state: { groups: [] } }));

describe("CPU core counts", () => {
  it("shows OS logical cores independently of process affinity", () => {
    expect(cpuCoreCounts({ cpus: 2, physical_cpus: 8, logical_cpus: 16 })).toEqual({ physical: "8", logical: "16" });
  });

  it("keeps old-client physical cores unknown while retaining logical compatibility", () => {
    expect(cpuCoreCounts({ cpus: 16 })).toEqual({ physical: "未知", logical: "16" });
    expect(cpuCoreCounts({ cpus: 16, physical_cpus: 8 })).toEqual({ physical: "8", logical: "16" });
  });

  it("does not turn invalid topology into physical or affinity-based counts", () => {
    for (const invalid of [0, -1, 1.5, Infinity, NaN]) {
      expect(cpuCoreCounts({ cpus: 4, physical_cpus: invalid, logical_cpus: invalid })).toEqual({ physical: "未知", logical: "未知" });
    }
  });
});
