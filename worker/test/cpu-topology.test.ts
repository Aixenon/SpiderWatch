import { expect, it } from "vitest";
import { validHost } from "../src/model";

const host = { hostname: "topology-test", os: "linux", arch: "arm64", cpus: 2, agent_version: "0.2.0" };

it("keeps legacy process counts compatible while validating optional system core counts", () => {
  expect(validHost(host)).toBe(true);
  expect(validHost({ ...host, physical_cpus: 4 })).toBe(true);
  expect(validHost({ ...host, physical_cpus: 4, logical_cpus: 8 })).toBe(true);
  expect(validHost({ ...host, logical_cpus: 8 })).toBe(true);
  for (const logical_cpus of [0, -1, 0.5, 65537, Infinity, "8", null]) expect(validHost({ ...host, logical_cpus })).toBe(false);
  expect(validHost({ ...host, physical_cpus: 8, logical_cpus: 4 })).toBe(false);
});
