import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { emptyCounts, forecast } from "../src/usage";

it.each([[120,720,38160],[300,288,15264],[600,144,7632]])(
  "budgets durable snapshots and network batches for 50 devices at %s seconds",
  (interval,windows,baseWrites)=>{
    const result=forecast({...DEFAULT_SETTINGS,idle_seconds:interval},50,[],0,4096);
    expect(result.history_storage).toMatchObject({
      latest_rows_per_day:50*windows,batch_rows_per_day:windows,
      window_rows_per_day:windows,expired_rows_per_day:windows,
      base_rows_written_per_day:baseWrites,includes_operational_overhead:false,
    });
    expect(result.sql_written_per_day).toBeGreaterThan(baseWrites);
    expect(result.sql_written_per_day).toBeLessThan(result.limits.sql_written);
  },
);

it("does not invent periodic history storage or history alarms for an empty network",()=>{
  const result=forecast(DEFAULT_SETTINGS,0,[],0,0);
  expect(result.history_storage.base_rows_written_per_day).toBe(0);
  expect(result.history_storage.batch_rows_per_day).toBe(0);
});

it("keeps an observed higher write rate instead of hiding administrative or migration work",()=>{
  const counts={...emptyCounts(),device_seconds:50*86400,sql_written:88000,alarms:1};
  const result=forecast(DEFAULT_SETTINGS,50,[{hour:0,...counts}],86400,4096);
  expect(result.sql_written_per_day).toBe(88000);
  // History alarms remain budgeted even before the first pending batch closes.
  expect(result.do_requests_per_day).toBeGreaterThanOrEqual(144);
});

it("changes live request estimates without changing the history checkpoint cadence",()=>{
  const counts={...emptyCounts(),device_seconds:50*86400,view_seconds:3600};
  const slow=forecast({...DEFAULT_SETTINGS,active_seconds:10},50,[{hour:0,...counts}],86400,0);
  const fast=forecast({...DEFAULT_SETTINGS,active_seconds:2},50,[{hour:0,...counts}],86400,0);
  expect(slow.history_storage).toEqual(fast.history_storage);
  expect(slow.sql_written_per_day).toBe(fast.sql_written_per_day);
  expect(fast.do_requests_per_day).toBeGreaterThan(slow.do_requests_per_day);
});
