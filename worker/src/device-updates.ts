export type DeviceUpdate = {
  request_id: string; version: string; revision: string;
  state: "requested" | "accepted" | "updating" | "installed" | "up_to_date" | "failed" | "timeout";
  updated_at: number; expires_at: number; code?: string; claimed?: boolean;
};

export function activeUpdate(job: DeviceUpdate | null): job is DeviceUpdate {
  return !!job && ["requested", "accepted", "updating"].includes(job.state) && job.expires_at > Date.now();
}

export function publicUpdate(job: DeviceUpdate | null): Omit<DeviceUpdate, "claimed"> | null {
  if (!job) return null;
  const {claimed: _, ...result} = job;
  if (["requested", "accepted", "updating"].includes(result.state) && result.expires_at <= Date.now()) {
    result.state = "timeout"; result.code = "update_request_expired";
  }
  return result;
}
