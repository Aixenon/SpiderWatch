import { expect, it } from "vitest";
import { ActiveDuration } from "../src/active-duration";
import { hourOf, splitSpan } from "../src/usage";

function meter() {
  const spans: [number, number][] = [];
  const duration = new ActiveDuration((start,end)=>spans.push([start,end]));
  return { duration, spans, total:()=>spans.reduce((sum,[start,end])=>sum+end-start,0) };
}
it("counts overlapping handlers and their awaited I/O once", () => {
  const {duration,total}=meter();
  duration.begin(1000);duration.begin(1100);duration.end(1400);duration.end(1600);
  expect(total()).toBe(600);
});
it("excludes the idle gap between events", () => {
  const {duration,total}=meter();
  duration.begin(1000);duration.end(1100);duration.checkpoint(500000);
  duration.begin(600000);duration.end(600050);
  expect(total()).toBe(150);
});
it("does not count a snapshot or persistence checkpoint twice", () => {
  const {duration,total}=meter();
  duration.begin(1000);duration.checkpoint(1200);duration.checkpoint(1200);
  duration.begin(1300);duration.checkpoint(1400);duration.end(1500);duration.end(1600);
  expect(total()).toBe(600);
});
it("splits a span crossing midnight into the correct UTC buckets", () => {
  const midnight=Date.parse("2026-10-06T00:00:00Z"),buckets=new Map<number,number>();
  const duration=new ActiveDuration((start,end)=>splitSpan(start,end,(hour,seconds)=>buckets.set(hour,(buckets.get(hour)||0)+seconds*1000)));
  duration.begin(midnight-250);duration.checkpoint(midnight+100);duration.end(midnight+750);
  expect(buckets.get(hourOf(midnight)-1)).toBe(250);
  expect(buckets.get(hourOf(midnight))).toBe(750);
});
it("does not produce negative time when the clock moves backwards", () => {
  const {duration,total}=meter();
  duration.begin(1000);duration.checkpoint(1200);duration.checkpoint(1100);duration.end(1300);
  expect(total()).toBe(300);
});
it("an error or early exit can end the span without a lingering timer", () => {
  const {duration,total}=meter();
  duration.begin(1000);
  try { throw new Error("handler failed"); } catch { /* expected */ } finally { duration.end(1100); }
  duration.end(1200);duration.checkpoint(500000);
  expect(total()).toBe(100);
});
