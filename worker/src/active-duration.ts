// Tracks the union of active handler spans, including awaited I/O. No timer or
// per-event storage is needed; checkpoints feed the existing hourly counters.
export class ActiveDuration {
  private handlers = 0;
  private cursor = 0;
  constructor(private readonly record: (start: number, end: number) => void) {}

  begin(now = Date.now()): void {
    if (this.handlers++ === 0) this.cursor = now;
  }
  checkpoint(now = Date.now()): void {
    if (this.handlers > 0 && now > this.cursor) {
      this.record(this.cursor, now);
      this.cursor = now;
    }
  }
  end(now = Date.now()): void {
    if (this.handlers === 0) return;
    this.checkpoint(now);
    this.handlers--;
  }
}
