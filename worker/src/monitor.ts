import { DurableObject } from "cloudflare:workers";
import { ActiveDuration } from "./active-duration";
import { localQuota } from "./quota";
import type { QuotaSnapshot } from "./quota-model";
import { decodeMessage } from "./compression";
import { timingSafeEqual } from "node:crypto";
import { BATCH_PREVIOUS, BATCH_SELECT, HISTORY_MAX_POINTS, decodeHistoryBatch, encodeHistoryBatch, historyBatchSamples, removeHistoryNode, historyRange, historySnapshot, resourcePoint, storedResourcePoint, type HistoryBatch, type HistoryWindow, type ResourcePoint } from "./history";
import { AUTH_WINDOW_MS, INVITATION_MS, issueInvitation, randomHex, signedHeadersValid, sshPublicBytes, verifyDeviceSignature, verifyInvitation } from "./identity";
import {
  CHECKPOINT_MS, DEFAULT_SETTINGS, HISTORY_RETENTION_DAYS,
  MAX_MESSAGE_BYTES, MAX_NODES, USAGE_RETENTION_DAYS, VIEW_LEASE_MS,
  hash, isDeviceIcon, json, randomNetworkCode, readJSON, settingsInput, validHost, validReport,
  type Device, type Host, type Metrics, type NetworkIdentity, type Settings,
} from "./model";
import { addCounts, countKeys, emptyCounts, forecast, hourOf, splitSpan, sumUsage, type Counts, type HourUsage } from "./usage";
import { emptyUpdateCache, readBundledRelease, updateRepository, UpdateSourceError, type UpdateCache, type UpdateConfig, type UpdateState } from "./update-source";

type Attachment = {
  role: "agent" | "viewer"; id?: string; authExpires: number; expires?: number; closed?: boolean; closedAt?: number;
  interval?: number; version?: number; session?: string; sequence?: number; lastReport?: number; savedAt?: number;
  agentVersion?: string; agentRevision?: string; host?: Host; protocol?: 2;
  epoch: number; hour: number; pending: Counts; exposureAt: number;
};
type Runtime = { created: number; checkpoint: number; epoch: number; viewCursor: number; viewing: boolean; viewExpires: number };

export class MonitorGroup extends DurableObject<Env> {
  private settings: Settings = DEFAULT_SETTINGS;
  private runtime!: Runtime;
  private network!: NetworkIdentity;
  private latest = new Map<string, { metrics: Metrics; host: unknown; seen: number }>();
  private pending = new Map<number, Counts>();
  private duration = new ActiveDuration((start, end) => {
    splitSpan(start, end, (hour, seconds) => { this.counter(hour).handler_ms += seconds * 1000; });
  });
  private closed = new Set<WebSocket>();
  private scheduledAlarm: number | null = null;
  private invitationDeadline: number | null = null;
  private historyWindow: HistoryWindow | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // Schema checks run once per migration, not on every hibernation wake.
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
      const schema = this.query<{value:string}>("SELECT value FROM config WHERE id=4")[0];
      if (!schema || Number(schema.value) < 1) ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, state TEXT NOT NULL, host TEXT NOT NULL, latest TEXT NOT NULL DEFAULT '{}', last_seen INTEGER NOT NULL DEFAULT 0)`);
        const nodeColumns = ctx.storage.sql.exec<{name: string}>("PRAGMA table_info(nodes)").toArray();
        if (!nodeColumns.some(column => column.name === "nickname")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
        if (!nodeColumns.some(column => column.name === "icon")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN icon TEXT NOT NULL DEFAULT 'server'");
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS node_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)`);
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS node_group_members (node_id TEXT PRIMARY KEY, group_id TEXT NOT NULL)`);
        ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS node_group_members_group ON node_group_members(group_id)`);
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage (hour INTEGER PRIMARY KEY, ${countKeys.map(k => k + " REAL NOT NULL DEFAULT 0").join(",")})`);
        ctx.storage.sql.exec(`INSERT OR IGNORE INTO config (id,value) VALUES (1,?)`, JSON.stringify(DEFAULT_SETTINGS));
        const now = Date.now();
        ctx.storage.sql.exec(`INSERT OR IGNORE INTO config (id,value) VALUES (2,?)`, JSON.stringify({ created: now, checkpoint: now, epoch: 1, viewCursor: now, viewing: false, viewExpires: 0 }));
        let network = ctx.storage.sql.exec<{value: string}>("SELECT value FROM config WHERE id=3").toArray()[0];
        if (!network) {
          // MONITOR_GROUP is the stable DO routing name. Keep it as a persisted
          // legacy alias so upgrades never create a new network or reset approval.
          const identity: NetworkIdentity = { code: randomNetworkCode(), legacy_alias: env.MONITOR_GROUP };
          ctx.storage.sql.exec("INSERT INTO config (id,value) VALUES (3,?)", JSON.stringify(identity));
          network = { value: JSON.stringify(identity) };
        }
        ctx.storage.sql.exec("INSERT OR REPLACE INTO config (id,value) VALUES (4,'1')");
      });
      if (!schema || Number(schema.value) < 2) ctx.storage.transactionSync(() => {
        const columns = ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(nodes)").toArray();
        if (!columns.some(column => column.name === "public_key")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN public_key TEXT NOT NULL DEFAULT ''");
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, node_id TEXT, public_key TEXT)");
        ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS invitation_expiry ON invitations(expires_at)");
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS auth_nonces (node_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(node_id,nonce))");
        ctx.storage.sql.exec("INSERT OR REPLACE INTO config (id,value) VALUES (4,'2')");
      });
      if (!schema || Number(schema.value) < 3) ctx.storage.transactionSync(() => {
        // Previous fifteen-minute/multi-device windows must not survive this
        // change. Device identities, permissions and metrics stay untouched.
        ctx.storage.sql.exec("DELETE FROM invitations");
        ctx.storage.sql.exec("INSERT OR REPLACE INTO config (id,value) VALUES (4,'3')");
      });
      if (!schema || Number(schema.value) < 4) ctx.storage.transactionSync(() => {
        const columns = ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(nodes)").toArray();
        if (!columns.some(column => column.name === "auto_update")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0");
        // The former panel-wide switch is replaced by each device's policy.
        const update = ctx.storage.sql.exec<{value:string}>("SELECT value FROM config WHERE id=5").toArray()[0];
        if (update) ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=5", JSON.stringify({...JSON.parse(update.value),enabled:true}));
        ctx.storage.sql.exec("INSERT OR REPLACE INTO config (id,value) VALUES (4,'4')");
      });
      if (!schema || Number(schema.value) < 5) ctx.storage.transactionSync(() => {
        const columns = ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(nodes)").toArray();
        if (!columns.some(column => column.name === "history_window")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN history_window INTEGER NOT NULL DEFAULT 0");
        if (!columns.some(column => column.name === "history_interval_seconds")) ctx.storage.sql.exec("ALTER TABLE nodes ADD COLUMN history_interval_seconds INTEGER NOT NULL DEFAULT 600");
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS history_batches (id INTEGER PRIMARY KEY, until INTEGER NOT NULL, generation TEXT NOT NULL, codec TEXT NOT NULL, payload BLOB NOT NULL)");
        ctx.storage.sql.exec("INSERT OR REPLACE INTO config (id,value) VALUES (4,'5')");
      });
      this.refreshInvitationDeadline();
      const config = new Map(this.query<{id:number;value:string}>("SELECT id,value FROM config WHERE id IN (1,2,3,9)").map(row => [row.id, row.value]));
      this.network = JSON.parse(config.get(3)!);
      this.settings = JSON.parse(config.get(1)!);
      this.runtime = JSON.parse(config.get(2)!);
      const history = config.get(9);
      this.historyWindow = history ? JSON.parse(history) : null;
      // A completed batch itself is the durable commit marker. Keeping the
      // old window metadata avoids a second config write on every flush.
      if (this.historyWindow && this.query("SELECT id FROM history_batches WHERE id=? AND generation=?", this.historyWindow.from, this.historyWindow.generation).length) this.historyWindow = null;
      // Heartbeat lease extensions live in hibernation attachments, avoiding a
      // database write for each heartbeat. Restore their union on every wake.
      if (this.runtime.viewing) for (const ws of ctx.getWebSockets()) {
        const a = this.attachment(ws);
        if (a?.role === "viewer" && !a.closed) this.runtime.viewExpires = Math.max(this.runtime.viewExpires, Math.min(a.expires || 0, a.authExpires));
      }
      this.scheduledAlarm = await ctx.storage.getAlarm();
    });
  }

  private counter(hour = hourOf(Date.now())): Counts {
    let c = this.pending.get(hour);
    if (!c) { c = emptyCounts(); this.pending.set(hour, c); }
    return c;
  }
  private query<T extends Record<string, SqlStorageValue>>(sql: string, ...args: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(sql, ...args);
    const rows = cursor.toArray();
    this.counter().sql_read += cursor.rowsRead;
    this.counter().sql_written += cursor.rowsWritten;
    return rows;
  }
  private flushHistory(now = Date.now(), force = false): void {
    const window = this.historyWindow;
    if (!window || !force && now < window.deadline) return;
    const cutoff = now - HISTORY_RETENTION_DAYS * 86400_000;
    const batch: HistoryBatch = { version: 1, samples: [] };
    // Every accepted checkpoint was persisted in nodes.latest before its ACK.
    // No node is overwritten until this old window has been committed.
    const cursor = this.ctx.storage.sql.exec<{node_id:string;last_seen:number;latest:string;history_interval_seconds:number}>("SELECT node_id,last_seen,latest,history_interval_seconds FROM nodes WHERE history_window=?", window.from);
    for (const node of cursor) {
      if (node.last_seen < cutoff) continue;
      let metrics: Metrics;
      try { metrics = JSON.parse(node.latest); } catch { continue; }
      batch.samples.push([node.node_id, node.last_seen, node.history_interval_seconds, historySnapshot(metrics, node.history_interval_seconds)]);
    }
    this.counter().sql_read += cursor.rowsRead;
    this.counter().sql_written += cursor.rowsWritten;
    this.ctx.storage.transactionSync(() => {
      // Settings can close and reopen a window in the same millisecond. Merge
      // that exceptional collision without dropping either node's sample.
      const existing = this.query<{codec:string;payload:ArrayBuffer}>("SELECT codec,payload FROM history_batches WHERE id=?", window.from)[0];
      if (existing) {
        const samples = new Map(decodeHistoryBatch(existing.codec, existing.payload).samples.map(sample => [sample[0]+":"+sample[1], sample]));
        for (const sample of batch.samples) samples.set(sample[0]+":"+sample[1], sample);
        batch.samples = [...samples.values()];
      }
      const encoded = encodeHistoryBatch(batch), until = Math.max(window.from, ...batch.samples.map(sample => sample[1]));
      this.query("INSERT INTO history_batches(id,until,generation,codec,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET until=excluded.until,generation=excluded.generation,codec=excluded.codec,payload=excluded.payload", window.from, until, window.generation, encoded.codec, encoded.payload);
      // A time key supports a narrow range read plus one predecessor for the
      // partially intersecting window. Expiration adds at most one old batch
      // delete per steady-state flush, and is counted in usage.
      this.query("DELETE FROM history_batches WHERE id<? AND until<?", cutoff, cutoff);
    });
    this.historyWindow = null;
  }
  private attachment(ws: WebSocket): Attachment | null {
    try { return ws.deserializeAttachment() as Attachment | null; } catch { return null; }
  }
  private sockets(role?: Attachment["role"], now = Date.now()): WebSocket[] {
    return this.ctx.getWebSockets().filter(w => {
      const a = this.attachment(w);
      return !!a && !a.closed && !this.closed.has(w) && (!role || a.role === role) && a.authExpires > now
        && (a.role !== "viewer" || (a.expires || 0) > now);
    });
  }
  private send(ws: WebSocket, body: unknown): void {
    try { ws.send(JSON.stringify(body)); } catch { this.closed.add(ws); }
  }
  private viewing(now = Date.now()): boolean { return this.sockets("viewer", now).length > 0; }
  private persistRuntime(): void { this.query("UPDATE config SET value=? WHERE id=2", JSON.stringify(this.runtime)); }
  private stashPendingCounters(): void {
    const socket = this.sockets()[0], current = socket && this.attachment(socket);
    if (socket && current && current.epoch === this.runtime.epoch) {
      const extra = this.pending.get(current.hour);
      if (extra) { addCounts(current.pending, extra); this.pending.delete(current.hour); socket.serializeAttachment(current); }
    }
  }

  // Counters stay in socket attachments between checkpoints, so hibernation
  // does not discard every idle report. SQL writes are never per metrics frame.
  private flushUsage(now = Date.now(), extra?: WebSocket): void {
    this.duration.checkpoint(now);
    const sockets = new Set([...this.ctx.getWebSockets(), ...(extra ? [extra] : [])]);
    for (const ws of sockets) {
      const a = this.attachment(ws); if (!a) continue;
      if (a.epoch === this.runtime.epoch) addCounts(this.counter(a.hour), a.pending);
      const end = Math.min(now, a.authExpires, a.closedAt || now);
      if (a.role === "agent" && a.exposureAt < end) splitSpan(Math.max(a.exposureAt, this.runtime.checkpoint), end, (h, s) => { this.counter(h).device_seconds += s; });
    }
    if (this.runtime.viewing) splitSpan(this.runtime.viewCursor, Math.min(now, this.runtime.viewExpires), (h, s) => { this.counter(h).view_seconds += s; });
    const nextEpoch = this.runtime.epoch + 1;
    const nextRuntime = { ...this.runtime, checkpoint: now, epoch: nextEpoch, viewCursor: now };
    this.counter().sql_written++; // The runtime checkpoint itself.
    this.ctx.storage.transactionSync(() => {
      for (const [hour, c] of this.pending) {
      // Include the metering row itself. Actual SQL counters are application
      // telemetry; Cloudflare billing also includes schema/alarm operations.
      c.sql_written += 1;
      this.ctx.storage.sql.exec(`INSERT INTO usage (hour,${countKeys.join(",")}) VALUES (?,${countKeys.map(() => "?").join(",")}) ON CONFLICT(hour) DO UPDATE SET ${countKeys.map(k => `${k}=${k}+excluded.${k}`).join(",")}`, hour, ...countKeys.map(k => c[k]));
      }
      this.ctx.storage.sql.exec("UPDATE config SET value=? WHERE id=2", JSON.stringify(nextRuntime));
    });
    this.pending.clear();
    this.runtime = nextRuntime;
    // The epoch makes resetting attachments idempotent after a restart in
    // between the SQL commit and resetting individual connections.
    for (const ws of sockets) {
      const a = this.attachment(ws); if (!a) continue;
      a.epoch = nextEpoch; a.pending = emptyCounts(); a.hour = hourOf(now); a.exposureAt = now;
      try { ws.serializeAttachment(a); } catch { /* already removed by runtime */ }
    }
  }
  private async syncViewing(now = Date.now()): Promise<void> {
    const viewers = this.sockets("viewer", now), watching = viewers.length > 0;
    const expires = Math.max(0, ...viewers.map(w => this.attachment(w)?.expires || 0));
    if (watching !== this.runtime.viewing) {
      this.flushUsage(now);
      this.runtime.viewing = watching; this.runtime.viewCursor = now;
      this.runtime.viewExpires = expires; this.persistRuntime();
      for (const ws of this.sockets("agent", now)) this.configureAgent(ws, watching);
    } else {
      this.runtime.viewExpires = expires;
    }
    await this.ensureAlarm(now);
  }
  private configureAgent(ws: WebSocket, watching = this.viewing(), force = false): void {
    const a = this.attachment(ws); if (!a) return;
    const interval = watching ? this.settings.active_seconds : this.settings.idle_seconds;
    if (!force && a.interval === interval && a.version === this.settings.version) return;
    a.interval = interval; a.version = this.settings.version;
    ws.serializeAttachment(a);
    this.send(ws, { type: "config", state: "approved", protocol: 2, compression: "gzip", viewing: watching, interval_seconds: interval, ...this.settings });
  }
  private async ensureAlarm(now = Date.now()): Promise<void> {
    const sockets = this.sockets(undefined, now);
    // A pending historical batch needs one deadline even if all agents leave.
    // No polling alarm exists when there is no pending batch or viewer.
    const deadlines = sockets.flatMap(w => {
      const a = this.attachment(w)!;
      return a.role === "viewer" ? [Math.min(a.authExpires, a.expires || now)] : a.authExpires < Number.MAX_SAFE_INTEGER ? [a.authExpires] : [];
    });
    if (this.invitationDeadline !== null) deadlines.push(Math.max(now + 1, this.invitationDeadline));
    if (this.historyWindow) deadlines.push(Math.max(now + 1, this.historyWindow.deadline));
    const next = deadlines.length ? Math.min(...deadlines) : null;
    if (next === null) {
      if (this.scheduledAlarm !== null) { await this.ctx.storage.deleteAlarm(); this.scheduledAlarm = null; }
    } else if (this.scheduledAlarm === null || this.scheduledAlarm <= now || next < this.scheduledAlarm) {
      await this.ctx.storage.setAlarm(next); this.counter().sql_written += 1; this.scheduledAlarm = next;
    }
  }
  private newAttachment(role: Attachment["role"], expires: number, id?: string): Attachment {
    const now = Date.now();
    return { role, id, authExpires: expires, expires: role === "viewer" ? now + VIEW_LEASE_MS : undefined,
      epoch: this.runtime.epoch, hour: hourOf(now), pending: emptyCounts(), exposureAt: now };
  }

  private async authenticateDevice(request: Request): Promise<Device | Response> {
    const id = request.headers.get("X-Monitor-Node-ID") || "";
    if (!/^[a-f0-9]{32}$/.test(id)) return json({ code: "device_auth_required" }, 401);
    const registered = this.query<Device>("SELECT * FROM nodes WHERE node_id=?", id)[0];
    if (!registered) return json({ state: "revoked", code: "revoked" }, 403);
    if (registered.public_key) {
      if (!await verifyDeviceSignature(request, registered.public_key)) return json({ code: "device_auth_failed" }, 401);
      // Crypto yields; reload permission after it to avoid accepting a device
      // that an administrator deleted or replaced while verification ran.
      const fresh = this.query<Device>("SELECT * FROM nodes WHERE node_id=?", id)[0];
      if (!fresh || fresh.public_key !== registered.public_key || fresh.state === "revoked") return json({ state: "revoked", code: "revoked" }, 403);
      if (!this.consumeNonce(request, id)) return json({ code: "request_replayed_or_rate_limited" }, 409);
      return fresh;
    }
    // A syntactically signed request may bypass machine Access at ingress,
    // but it must never downgrade to an old bearer-only device credential.
    if (request.headers.has("X-Monitor-Signature")) return json({code:"device_auth_failed"},401);
    const key = request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(key)) return json({ code: "device_auth_required" }, 401);
    const digest = await hash(key);
    const n = this.query<Device>("SELECT * FROM nodes WHERE node_id=?", id)[0];
    if (!n) return json({state:"revoked",code:"revoked"},403);
    if (n.public_key) return json({code:"device_auth_failed"},401);
    if (!timingSafeEqual(new TextEncoder().encode(n.key_hash), new TextEncoder().encode(digest))) return json({ code: "device_auth_failed" }, 401);
    return n;
  }
  private responseState(n: Device): Response { return json({ state: n.state, transport: "websocket", interval_seconds: n.state === "approved" ? this.settings.idle_seconds : 300 }); }

  private async updateConfig(request: Request): Promise<Response> {
    if (!["GET", "PUT"].includes(request.method)) return json({ code: "method_not_allowed" }, 405);
    // Read the small network setting only when an update is explicitly requested.
    // Binary contents are streamed by the outer Worker directly from GitHub.
    const input = request.method === "PUT" ? await readJSON(request, 2048) as Record<string, unknown> : undefined;
    const stored = this.query<{value:string}>("SELECT value FROM config WHERE id=5")[0];
    const config: {enabled:boolean;distribution_path:string;aliases:string[]} = stored
      ? JSON.parse(stored.value) : {enabled:true,distribution_path:"agent/stable",aliases:[]};
    if (input !== undefined) {
      const path = input?.distribution_path;
      if (typeof input?.enabled !== "boolean" || typeof path !== "string" || path.length > 64
        || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(path)
        || path.split("/").some(part => ["api","v1","bootstrap","manifest","manifest-json"].includes(part))) {
        return json({code:"invalid_update_config"},400);
      }
      const aliases = new Set(config.aliases);
      if (path !== config.distribution_path) aliases.add(config.distribution_path);
      aliases.delete(path);
      if (aliases.size > 8) return json({code:"update_path_history_full"},409);
      config.enabled = input.enabled; config.distribution_path = path; config.aliases = [...aliases];
      this.query("INSERT INTO config (id,value) VALUES (5,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(config));
    }
    return json(config);
  }
  private consumeNonce(request: Request, id: string): boolean {
    if (!signedHeadersValid(request)) return false;
    const nonce = request.headers.get("X-Monitor-Nonce") || "", now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.query("DELETE FROM auth_nonces WHERE node_id=? AND expires_at<?", id, now);
      if (this.query("SELECT nonce FROM auth_nonces WHERE node_id=? AND nonce=?", id, nonce).length) return false;
      if (this.query<{n:number}>("SELECT COUNT(*) AS n FROM auth_nonces WHERE node_id=?", id)[0].n >= 64) return false;
      this.query("INSERT INTO auth_nonces(node_id,nonce,expires_at) VALUES (?,?,?)", id, nonce, Number(request.headers.get("X-Monitor-Time")) + AUTH_WINDOW_MS);
      return true;
    });
  }
  private refreshInvitationDeadline(): void {
    this.invitationDeadline = this.query<{expires:number|null}>("SELECT MIN(expires_at) AS expires FROM invitations")[0].expires;
  }
  private purgeInvitations(): void {
    this.query("DELETE FROM invitations WHERE expires_at<=?", Date.now());
    this.refreshInvitationDeadline();
  }

  private readUpdateState(): UpdateState {
    const row = this.query<{value:string}>("SELECT value FROM config WHERE id=5")[0];
    const config: UpdateConfig = row ? JSON.parse(row.value) : { enabled: true, distribution_path: "agent/stable", aliases: [] };
    return { config, source: emptyUpdateCache(updateRepository(this.env)) };
  }
  private async checkUpdateSource(source: UpdateCache): Promise<UpdateCache> {
    // Static metadata belongs to this deployment. No SQL cache, polling of
    // GitHub, persisted failure state, or stale URLs across Worker deployments.
    try {
      const { version, revision, release_tag, assets, repository } = await readBundledRelease(this.env);
      const now = Date.now();
      return { repository, current: { version, revision, release_tag, assets }, previous: null,
        checked_at: now, last_attempt_at: now, retry_at: 0, error: null };
    } catch (error) {
      const failure = error instanceof UpdateSourceError ? error : new UpdateSourceError("update_bundle_unavailable", 503);
      return { ...source, error: failure.code, retry_at: Date.now() + failure.retryMs };
    }
  }
  private async updateState(request: Request): Promise<Response> {
    if (!["GET", "POST"].includes(request.method)) return json({ code: "method_not_allowed" }, 405);
    let state = this.readUpdateState();
    if (state.config.enabled) {
      const source = await this.checkUpdateSource(state.source);
      state = { ...this.readUpdateState(), source };
      if (state.config.enabled && source.error) return json({ code: source.error }, source.error === "update_bundle_unavailable" ? 503 : 502);
    }
    return json(state);
  }

  async fetch(request: Request): Promise<Response> {
    const started = Date.now(), url = new URL(request.url);
    const writesBefore = this.counter().sql_written;
    const admin = request.headers.get("X-Monitor-Role") === "admin";
    const authExpires = Number(request.headers.get("X-Monitor-Auth-Expires"));
    if (!Number.isFinite(authExpires) || authExpires <= started) return json({ code: "session_expired" }, 401);
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (!upgrade) this.counter().http_requests++;
    this.duration.begin(started);
    try {
      if (request.headers.get("X-Monitor-Role") === "updates") {
        if (url.hostname !== "do") return json({code:"not_found"},404);
        const original = request.headers.get("X-Monitor-Original-URL");
        if (original) {
          const signedRequest = new Request(original, {method:request.headers.get("X-Monitor-Original-Method") || "GET", headers:request.headers});
          const device = await this.authenticateDevice(signedRequest);
          if (device instanceof Response) return device;
          if (device.state !== "approved") return json({code:device.state},403);
          if (new URL(original).pathname === "/v1/update/automatic" && !device.auto_update) {
            return json({config:{enabled:false,distribution_path:"agent/stable",aliases:[]},source:emptyUpdateCache(updateRepository(this.env))});
          }
        }
        if (url.pathname === "/internal/update-config") return await this.updateConfig(request);
        if (url.pathname === "/internal/update-state") {
          const response = await this.updateState(request);
          // A cold source check yields to other requests. Honor revocation or
          // a policy change made while static metadata was loading.
          if (original) {
            const current = this.query<Device>("SELECT * FROM nodes WHERE node_id=?",request.headers.get("X-Monitor-Node-ID"))[0];
            if (!current || current.state !== "approved") {
              await response.body?.cancel();
              return json({code:"device_not_registered"},403);
            }
            if (new URL(original).pathname === "/v1/update/automatic" && !current.auto_update) {
              await response.body?.cancel();
              return json({config:{enabled:false,distribution_path:"agent/stable",aliases:[]},source:emptyUpdateCache(updateRepository(this.env))});
            }
          }
          return response;
        }
        return json({code:"not_found"},404);
      }
      if (request.headers.get("X-Monitor-Role") === "bootstrap") {
        if (url.pathname === "/bootstrap/enroll" && request.method === "POST") return await this.enroll(request);
        if (url.pathname !== "/bootstrap/status" || request.method !== "POST") return json({ code: "not_found" }, 404);
        const device = await this.authenticateDevice(request);
        if (device instanceof Response) return device;
        if (device.state !== "approved") return this.responseState(device);
        if (device.public_key) return this.responseState(device);
        const local = this.env.LOCAL_DEV === "true";
        if (!local && (!this.env.AGENT_ACCESS_CLIENT_ID || !this.env.AGENT_ACCESS_CLIENT_SECRET)) return json({ code: "agent_access_not_configured" }, 503);
        // These credentials never appear in admin state, metrics or logs.
        return json({ state: "approved", transport: "websocket", interval_seconds: this.settings.idle_seconds,
          access: local ? undefined : { client_id: this.env.AGENT_ACCESS_CLIENT_ID, client_secret: this.env.AGENT_ACCESS_CLIENT_SECRET } });
      }
      if (admin) return await this.admin(request, url, authExpires);
      if (url.pathname === "/v1/enroll" && request.method === "POST") return await this.enroll(request);
      const device = await this.authenticateDevice(request);
      if (device instanceof Response) return device;
      if (request.method === "DELETE" && url.pathname === `/v1/nodes/${device.node_id}`) {
        // Leaving locally does not cancel the administrator's lasting approval.
        this.disconnectDevice(device.node_id); return this.responseState(device);
      }
      if (url.pathname === `/v1/nodes/${device.node_id}/status` && request.method === "GET") return this.responseState(device);
      if (url.pathname === "/v1/live" && upgrade && request.method === "GET") {
        if (device.state !== "approved") return json({ state: device.state, code: device.state }, 403);
        const agentVersion = request.headers.get("X-Monitor-Agent-Version") || undefined;
        if (agentVersion && !/^[A-Za-z0-9._+-]{1,64}$/.test(agentVersion)) return json({ code: "invalid_agent_version" }, 400);
        const agentRevision = request.headers.get("X-Monitor-Agent-Revision") || undefined;
        if (agentRevision && !/^[a-f0-9]{40}$/.test(agentRevision)) return json({ code: "invalid_agent_revision" }, 400);
        for (const old of this.sockets("agent")) if (this.attachment(old)?.id === device.node_id) {
          const previous = this.attachment(old)!; previous.closed = true; previous.closedAt = Date.now(); old.serializeAttachment(previous);
          this.send(old, {type: "superseded"}); old.close(4001, "superseded"); this.flushUsage(Date.now(), old);
        }
        const pair = new WebSocketPair(), a = this.newAttachment("agent", authExpires, device.node_id);
        a.agentVersion = agentVersion; a.agentRevision = agentRevision;
        // Keep the historical checkpoint across reconnects. A reconnect must
        // not multiply the selected historical recording rate.
        a.savedAt = device.last_seen || undefined;
        a.pending.connections++;
        this.ctx.acceptWebSocket(pair[1], ["agent"]); pair[1].serializeAttachment(a);
        this.configureAgent(pair[1], this.viewing(), true); await this.ensureAlarm();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return json({ code: "not_found" }, 404);
    } catch (error) {
      if (error instanceof Error && ["invalid_settings", "invalid_enroll", "invalid_node_group", "invalid_group_members", "empty_body", "body_too_large"].includes(error.message)) return json({ code: error.message }, 400);
      if (error instanceof SyntaxError) return json({ code: "invalid_json" }, 400);
      throw error;
    } finally {
      this.duration.end();
      // Read-only status polling must not turn every HTTP request into SQL
      // writes. Keep counters in a live attachment, or checkpoint at most once
      // per five minutes when no socket exists (then HTTP counts are estimates).
      const changesState = !["GET", "HEAD"].includes(request.method) && url.pathname !== "/bootstrap/status";
      if ((changesState && this.counter().sql_written > writesBefore) || Date.now() - this.runtime.checkpoint >= CHECKPOINT_MS) this.flushUsage();
      else this.stashPendingCounters();
    }
  }
  private async enroll(request: Request): Promise<Response> {
    const invitation = await verifyInvitation(this.env, request.headers.get("X-Monitor-Invitation") || "");
    if (!invitation) return json({code:"invitation_invalid_or_expired"},403);
    if (!this.query("SELECT id FROM invitations WHERE id=? AND expires_at>? AND node_id IS NULL", invitation.id, Date.now()).length) return json({code:"registration_closed"},403);
    const proof = request.clone();
    const body = await readJSON(request);
    if (!body || typeof body !== "object") throw new Error("invalid_enroll");
    const v = body as Record<string, unknown>;
    const ssh = v.protocol === 2;
    if ((!ssh && v.protocol !== 1) || typeof v.group !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.group) || typeof v.node_id !== "string" || !/^[a-f0-9]{32}$/.test(v.node_id)
      || (ssh ? typeof v.public_key !== "string" || !sshPublicBytes(v.public_key) : typeof v.device_key !== "string" || !/^[a-f0-9]{64}$/.test(v.device_key))
      || !validHost(v.host) || (v.name !== undefined && (typeof v.name !== "string" || v.name.length > 128))) throw new Error("invalid_enroll");
    const aliasMatches = v.group === this.network.legacy_alias || (/^[A-Za-z0-9]{16}$/.test(this.network.legacy_alias) && v.group.toLowerCase() === this.network.legacy_alias.toLowerCase());
    if (v.group.toLowerCase() !== this.network.code && !aliasMatches) return json({ code: "network_not_found" }, 404);
    if (ssh && (request.headers.get("X-Monitor-Node-ID") !== v.node_id || !await verifyDeviceSignature(proof, v.public_key as string))) return json({code:"device_auth_failed"},401);
    const digest = ssh ? "" : await hash(v.device_key as string);
    // All reads/claims below are synchronous after crypto/body I/O. Concurrent
    // claims cannot bind the same invitation to two devices.
    const claim = this.query<{id:string;expires_at:number;node_id:string|null;public_key:string|null}>("SELECT * FROM invitations WHERE id=?", invitation.id)[0];
    if (!claim || claim.expires_at <= Date.now() || claim.node_id) return json({code:"registration_closed"},403);
    const identity = ssh ? v.public_key as string : digest;
    const old = this.query<Device>("SELECT * FROM nodes WHERE node_id=?", v.node_id)[0];
    if (old) {
      if (ssh ? old.public_key !== identity : !!old.public_key || old.key_hash !== digest) return json({ code: "identity_conflict" }, 409);
      if (ssh && !this.consumeNonce(request, v.node_id)) return json({code:"request_replayed_or_rate_limited"},409);
      this.ctx.storage.transactionSync(() => {
        this.query("DELETE FROM invitations");
        this.registrationReceipt(invitation.id, v.node_id as string);
        if (old.state === "pending") this.query("UPDATE nodes SET state='approved' WHERE node_id=?", v.node_id as string);
      });
      if (old.state === "pending") old.state = "approved";
      this.refreshInvitationDeadline(); await this.ensureAlarm(); this.refreshViewers();
      return this.responseState(old);
    }
    if (ssh && this.query("SELECT node_id FROM nodes WHERE public_key=?", identity).length) return json({code:"key_already_registered"},409);
    if (this.query<{n: number}>("SELECT COUNT(*) AS n FROM nodes")[0].n >= MAX_NODES) return json({ code: "group_full" }, 409);
    const host = v.host;
    // Issuing the single-device invitation is the administrator's approval.
    // Claim and authorization commit together, with no second panel action.
    this.ctx.storage.transactionSync(() => {
      this.query("INSERT INTO nodes (node_id,name,key_hash,public_key,state,host) VALUES (?,?,?,?,'approved',?)", v.node_id as string, host.hostname, digest, ssh ? identity : "", JSON.stringify(host));
      this.query("DELETE FROM invitations");
      this.registrationReceipt(invitation.id, v.node_id as string);
      if (ssh && !this.consumeNonce(request, v.node_id as string)) throw new Error("invalid_enroll");
    });
    this.refreshInvitationDeadline(); await this.ensureAlarm(); this.refreshViewers();
    return json({ state: "approved", transport: "websocket", interval_seconds: this.settings.idle_seconds });
  }
  private registrationReceipt(invitation: string, node: string): void {
    this.query("INSERT INTO config(id,value) VALUES(7,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      JSON.stringify({id:invitation,node_id:node,expires_at:Date.now()+15*60_000}));
  }
  private refreshViewers(): void {
    for (const w of this.sockets("viewer")) this.send(w, { type: "refresh" });
  }
  private disconnectDevice(id: string): void {
    for (const ws of this.ctx.getWebSockets("agent")) if (this.attachment(ws)?.id === id && !this.attachment(ws)?.closed) {
      const a = this.attachment(ws)!; a.closed = true; a.closedAt = Date.now(); ws.serializeAttachment(a);
      this.send(ws, { type: "revoked", state: "revoked" }); ws.close(1008, "revoked"); this.flushUsage(Date.now(), ws);
    }
    this.refreshViewers();
  }
  private removeDevice(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const node = this.query<{node_id:string}>("SELECT node_id FROM nodes WHERE node_id=?", id)[0];
      if (!node) return;
      this.query("DELETE FROM node_group_members WHERE node_id=?", id);
      const batches = this.ctx.storage.sql.exec<{id:number;codec:string;payload:ArrayBuffer}>("SELECT id,codec,payload FROM history_batches");
      // Remove the actual node payload, not merely its API visibility. Decode
      // one batch at a time so deleting a node never loads a week into memory.
      for (const row of batches) {
        const encoded = removeHistoryNode(row.codec, row.payload, id);
        if (encoded === null) continue;
        if (encoded === "empty") this.query("DELETE FROM history_batches WHERE id=?", row.id);
        // Retain the conservative upper bound after removal; it may cause one
        // harmless extra range candidate, but never needs decoding other nodes.
        else this.query("UPDATE history_batches SET codec=?,payload=? WHERE id=?", encoded.codec, encoded.payload, row.id);
      }
      this.counter().sql_read += batches.rowsRead;
      this.counter().sql_written += batches.rowsWritten;
      this.query("DELETE FROM nodes WHERE node_id=?", id);
      this.query("DELETE FROM auth_nonces WHERE node_id=?", id);
      if (!this.historyWindow || !this.query("SELECT node_id FROM nodes WHERE history_window=? LIMIT 1", this.historyWindow.from).length) {
        this.query("DELETE FROM config WHERE id=9");
        this.historyWindow = null;
      }
    });
    this.latest.delete(id);
    this.disconnectDevice(id);
  }
  private groupName(body: unknown): string {
    const name = body && typeof body === "object" ? (body as {name?: unknown}).name : undefined;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid_node_group");
    return name.trim();
  }
  private async admin(request: Request, url: URL, authExpires: number): Promise<Response> {
    const historyMatch = /^\/api\/nodes\/([a-f0-9]{32})\/history$/.exec(url.pathname);
    if (historyMatch) {
      if (request.method !== "GET") return json({code:"method_not_allowed"},405);
      const range = historyRange(url);
      if (range === null) return json({code:"invalid_history_range"},400);
      const id = historyMatch[1];
      const node = this.query<{last_seen:number;latest:string;history_window:number;history_interval_seconds:number}>("SELECT last_seen,latest,history_window,history_interval_seconds FROM nodes WHERE node_id=?",id)[0];
      if (!node) return json({code:"node_not_found"},404);
      const latest = this.latest.get(id);
      // Every timestamp stays paired with its actual snapshot. Offline ranges
      // end at the last report, not at the time someone opens the panel.
      const seen = latest?.seen || node.last_seen;
      const to = seen || Date.now(), from = to - range * 1000;
      const resolution = Math.ceil(range / (HISTORY_MAX_POINTS - 1));
      const points = new Map<number, ResourcePoint>(), timestamps = new Set<number>();
      const add = (point: ResourcePoint) => {
        const bucket = Math.floor((point.time - from) / (resolution * 1000));
        timestamps.add(point.time);
        const previous = points.get(bucket);
        if (!previous || point.time >= previous.time) points.set(bucket, { ...point, interval_seconds: Math.max(point.interval_seconds || this.settings.idle_seconds, resolution) });
      };
      // Stream each bounded key range. Keeping an entire seven-day array of
      // serialized snapshots alongside parsed points can exceed object memory.
      for (const [sql, args] of [[BATCH_PREVIOUS, [from]], [BATCH_SELECT, [from, to]]] as const) {
        const cursor = this.ctx.storage.sql.exec<{id:number;until:number;codec:string;payload:ArrayBuffer}>(sql, ...args);
        for (const row of cursor) if (row.until >= from) for (const sample of historyBatchSamples(row.codec, row.payload, id)) {
          if (sample[0] === id && sample[1] >= from && sample[1] <= to) add({ ...storedResourcePoint(sample[1], sample[3]), interval_seconds: sample[2] });
        }
        this.counter().sql_read += cursor.rowsRead;
        this.counter().sql_written += cursor.rowsWritten;
      }
      // The current network window is already durable in latest, even before
      // its one shared historical row is committed at the deadline.
      if (node.last_seen >= from && node.last_seen <= to && node.last_seen) add({ ...storedResourcePoint(node.last_seen, node.latest), interval_seconds: node.history_interval_seconds });
      if (seen) {
        const recorded = points.get(Math.floor((seen - from) / (resolution * 1000)));
        const interval = recorded?.time === seen ? recorded.interval_seconds : this.settings.idle_seconds;
        add({ ...(latest ? resourcePoint(seen, latest.metrics) : storedResourcePoint(seen, node.latest)), interval_seconds: interval });
      }
      return json({points:[...points.values()].sort((a,b)=>a.time-b.time),from,to,interval_seconds:this.settings.idle_seconds,resolution_seconds:resolution,raw_points:timestamps.size});
    }
    if (url.pathname === "/api/quota" && request.method === "GET") {
      return json(this.readQuota());
    }
    if (url.pathname === "/api/invitations" && request.method === "POST") {
      const id = randomHex(), expires = Date.now() + INVITATION_MS;
      let token: string;
      try { token = await issueInvitation(this.env, id, expires); }
      catch { return json({code:"invitation_not_configured"},503); }
      this.ctx.storage.transactionSync(() => {
        this.query("DELETE FROM invitations");
        this.query("INSERT INTO invitations(id,expires_at) VALUES (?,?)", id, expires);
      });
      this.refreshInvitationDeadline(); await this.ensureAlarm();
      const fragment = new URLSearchParams({invite:token});
      const server = `${url.origin}/#${fragment}`;
      return json({id,expires_at:expires,server,network:this.network.code,repository:updateRepository(this.env)});
    }
    const invitationMatch = /^\/api\/invitations\/([a-f0-9]{32})$/.exec(url.pathname);
    if (invitationMatch && request.method === "GET") {
      const stored = this.query<{value:string}>("SELECT value FROM config WHERE id=7")[0];
      const receipt = stored ? JSON.parse(stored.value) : null;
      if (receipt?.id === invitationMatch[1] && receipt.expires_at > Date.now()
        && this.query("SELECT node_id FROM nodes WHERE node_id=? AND state='approved'",receipt.node_id).length) {
        return json({state:"registered",node_id:receipt.node_id});
      }
      const invitation = this.query<{expires_at:number}>("SELECT expires_at FROM invitations WHERE id=? AND expires_at>?",invitationMatch[1],Date.now())[0];
      return json(invitation ? {state:"pending",expires_at:invitation.expires_at} : {state:"closed"});
    }
    if (invitationMatch && request.method === "DELETE") {
      this.query("DELETE FROM invitations WHERE id=?",invitationMatch[1]);
      this.refreshInvitationDeadline(); await this.ensureAlarm(); return json({ok:true});
    }
    if (url.pathname === "/api/live" && request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (this.sockets("viewer").length >= 20) return json({ code: "too_many_viewers" }, 429);
      const pair = new WebSocketPair(), a = this.newAttachment("viewer", authExpires);
      a.pending.connections++; a.pending.viewer_connections++;
      this.ctx.acceptWebSocket(pair[1], ["viewer"]); pair[1].serializeAttachment(a);
      await this.syncViewing(); this.send(pair[1], { type: "settings", settings: this.settings });
      for (const [id, x] of this.latest) this.send(pair[1], { type: "metrics", node_id: id, metrics: x.metrics, last_seen: x.seen });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const input = settingsInput(await readJSON(request, 4096));
      const next = { ...input, version: this.settings.version + 1, updated_at: Date.now() };
      this.flushHistory(Date.now(), true);
      this.query("UPDATE config SET value=? WHERE id=1", JSON.stringify(next));
      this.settings = next;
      for (const w of this.sockets("agent")) this.configureAgent(w, this.viewing(), true);
      for (const w of this.sockets("viewer")) this.send(w, { type: "settings", settings: this.settings });
      await this.ensureAlarm();
      return json(this.settings);
    }
    if (url.pathname === "/api/node-groups" && request.method === "POST") {
      const name = this.groupName(await readJSON(request, 4096));
      if (this.query("SELECT id FROM node_groups WHERE name=?", name).length) return json({code: "group_name_exists"}, 409);
      if (this.query<{n:number}>("SELECT COUNT(*) AS n FROM node_groups")[0].n >= 50) return json({code: "too_many_groups"}, 409);
      const id = crypto.randomUUID().replace(/-/g, "");
      this.query("INSERT INTO node_groups (id,name) VALUES (?,?)", id, name); this.refreshViewers();
      return json({id, name});
    }
    const groupMatch = /^\/api\/node-groups\/([a-f0-9]{32})$/.exec(url.pathname);
    if (groupMatch && ["PUT", "DELETE"].includes(request.method)) {
      const id = groupMatch[1];
      if (!this.query("SELECT id FROM node_groups WHERE id=?", id).length) return json({code: "node_group_not_found"}, 404);
      if (request.method === "PUT") {
        const name = this.groupName(await readJSON(request, 4096));
        if (this.query("SELECT id FROM node_groups WHERE name=? AND id<>?", name, id).length) return json({code: "group_name_exists"}, 409);
        this.query("UPDATE node_groups SET name=? WHERE id=?", name, id);
      } else this.ctx.storage.transactionSync(() => {
        this.query("DELETE FROM node_group_members WHERE group_id=?", id);
        this.query("DELETE FROM node_groups WHERE id=?", id);
      });
      this.refreshViewers(); return json({ok: true});
    }
    if (url.pathname === "/api/nodes/groups" && request.method === "PUT") {
      const body = await readJSON(request, 16384) as {node_ids?: unknown; group_id?: unknown} | null;
      if (!body || !Array.isArray(body.node_ids) || !body.node_ids.length || body.node_ids.length > MAX_NODES
        || body.node_ids.some(id => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
        || (body.group_id !== null && (typeof body.group_id !== "string" || !/^[a-f0-9]{32}$/.test(body.group_id)))) throw new Error("invalid_group_members");
      const ids = [...new Set(body.node_ids as string[])], group = body.group_id as string | null;
      if (group && !this.query("SELECT id FROM node_groups WHERE id=?", group).length) return json({code: "node_group_not_found"}, 404);
      const nodes = this.query<{node_id:string}>(`SELECT node_id FROM nodes WHERE node_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      if (nodes.length !== ids.length) return json({code: "node_not_found"}, 404);
      this.ctx.storage.transactionSync(() => {
        for (const id of ids) {
          if (group) this.query("INSERT INTO node_group_members (node_id,group_id) VALUES (?,?) ON CONFLICT(node_id) DO UPDATE SET group_id=excluded.group_id", id, group);
          else this.query("DELETE FROM node_group_members WHERE node_id=?", id);
        }
      });
      this.refreshViewers(); return json({ok: true, changed: ids.length});
    }
    const updateMatch = /^\/api\/nodes\/([a-f0-9]{32})\/update-check$/.exec(url.pathname);
    if (updateMatch && request.method === "POST") {
      let node = this.query<Device>("SELECT * FROM nodes WHERE node_id=? AND state='approved'", updateMatch[1])[0];
      if (!node) return json({code:"node_not_found"},404);
      const state = this.readUpdateState();
      if (!state.config.enabled) return json({code:"updates_disabled"},409);
      try {
        const source = await this.checkUpdateSource(state.source);
        // Never disclose a result for a device deleted while static metadata was loading.
        node = this.query<Device>("SELECT * FROM nodes WHERE node_id=? AND state='approved'", updateMatch[1])[0];
        if (!node) return json({code:"node_not_found"},404);
        if (!this.readUpdateState().config.enabled) return json({code:"updates_disabled"},409);
        if (source.error) return json({code:source.error},502);
        const host = JSON.parse(node.host), current = host.agent_version || "";
        const available = source.current?.assets.some(asset => asset.os === String(host.os).toLowerCase() && asset.arch === host.arch);
        if (!available) return json({code:"update_platform_unavailable"},409);
        const before = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current), after = source.current!.version.split(".").map(Number);
        let newer: boolean | null = null;
        if (before) {
          newer = false;
          for (let i=0;i<3;i++) if (after[i] !== Number(before[i+1])) { newer = after[i] > Number(before[i+1]); break; }
          if (after.every((value,index)=>value===Number(before[index+1])) && (before[4] || host.agent_revision !== source.current!.revision)) newer = true;
        }
        return json({version:source.current!.version,revision:source.current!.revision,current_version:current,available:newer});
      } catch(error) {
        if (error instanceof UpdateSourceError) return json({code:error.code},error.status);
        throw error;
      }
    }
    const deleteMatch = /^\/api\/nodes\/([a-f0-9]{32})$/.exec(url.pathname);
    if (deleteMatch && request.method === "PATCH") {
      const body = await readJSON(request, 2048) as {nickname?: unknown; group_id?: unknown; icon?: unknown; auto_update?: unknown} | null;
      if (!body || typeof body !== "object" || Array.isArray(body) || !("nickname" in body || "group_id" in body || "icon" in body || "auto_update" in body)) return json({ code: "invalid_node_config" }, 400);
      if ("auto_update" in body && typeof body.auto_update !== "boolean") return json({code:"invalid_node_config"},400);
      const hasNickname = "nickname" in body, hasGroup = "group_id" in body, hasIcon = "icon" in body;
      if (hasIcon && !isDeviceIcon(body.icon)) return json({ code: "invalid_icon" }, 400);
      if (hasNickname && (typeof body.nickname !== "string" || body.nickname.trim().length > 128 || /[\x00-\x1f\x7f]/.test(body.nickname))) return json({ code: "invalid_nickname" }, 400);
      if (hasGroup && body.group_id !== null && (typeof body.group_id !== "string" || !/^[a-f0-9]{32}$/.test(body.group_id))) return json({ code: "invalid_group_members" }, 400);
      const group = hasGroup ? body.group_id as string | null : undefined;
      if (group && !this.query("SELECT id FROM node_groups WHERE id=?", group).length) return json({ code: "node_group_not_found" }, 404);
      // Read membership after the body stream has finished, so a concurrent
      // panel deletion cannot be followed by an orphaned group assignment.
      const node = this.query<Device>("SELECT * FROM nodes WHERE node_id=?", deleteMatch[1])[0];
      if (!node) return json({ code: "node_not_found" }, 404);
      // Validate every requested field before applying any change. Changing
      // display settings never touches the lasting membership approval.
      this.ctx.storage.transactionSync(() => {
        if ("auto_update" in body) this.query("UPDATE nodes SET auto_update=? WHERE node_id=?",body.auto_update ? 1 : 0,node.node_id);
        if (hasNickname || hasIcon) {
          const nickname = hasNickname ? (body.nickname as string).trim() : node.nickname;
          const icon = hasIcon ? body.icon as string : node.icon;
          this.query("UPDATE nodes SET nickname=?,name=?,icon=? WHERE node_id=?", nickname, nickname || JSON.parse(node.host).hostname, icon, node.node_id);
        }
        if (hasGroup) {
          if (group) this.query("INSERT INTO node_group_members (node_id,group_id) VALUES (?,?) ON CONFLICT(node_id) DO UPDATE SET group_id=excluded.group_id", node.node_id, group);
          else this.query("DELETE FROM node_group_members WHERE node_id=?", node.node_id);
        }
      });
      this.refreshViewers(); return json({ ok: true });
    }
    if (deleteMatch && request.method === "DELETE") {
      this.removeDevice(deleteMatch[1]); await this.ensureAlarm(); return json({ok: true});
    }
    const match = /^\/api\/nodes\/([a-f0-9]{32})\/revoke$/.exec(url.pathname);
    if (match && request.method === "POST") {
      this.removeDevice(match[1]); await this.ensureAlarm();
      return json({ ok: true });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      await this.syncViewing();
      const includeUsage = url.searchParams.get("view") !== "live";
      const now = Date.now(), days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const start = Math.max(this.runtime.created, now - days * 86400_000);
      // Return daily aggregates, keeping a 90-day response small even after
      // years of use; forecasting still uses the full hourly totals in SQL.
      const rows = includeUsage ? this.query<HourUsage>(`SELECT CAST(hour/24 AS INTEGER)*24 AS hour,${countKeys.map(k => `SUM(${k}) AS ${k}`).join(",")} FROM usage WHERE hour>=? GROUP BY CAST(hour/24 AS INTEGER) ORDER BY hour`, hourOf(start)) : [];
      if (includeUsage) {
        this.duration.checkpoint(now);
        const extra = new Map<number, Counts>();
        const add = (hour: number, counts: Counts) => {
          if (hour < hourOf(start)) return;
          const day = Math.floor(hour / 24) * 24;
          const total = extra.get(day) || emptyCounts(); addCounts(total, counts); extra.set(day, total);
        };
        for (const [hour, counts] of this.pending) add(hour, counts);
        for (const socket of this.ctx.getWebSockets()) {
          const a = this.attachment(socket); if (!a || a.epoch !== this.runtime.epoch) continue;
          add(a.hour, a.pending);
          if (a.role === "agent") splitSpan(Math.max(a.exposureAt, this.runtime.checkpoint), Math.min(now, a.authExpires, a.closedAt || now), (hour, seconds) => { const counts = emptyCounts(); counts.device_seconds = seconds; add(hour, counts); });
        }
        if (this.runtime.viewing) splitSpan(this.runtime.viewCursor, Math.min(now, this.runtime.viewExpires), (hour, seconds) => { const counts = emptyCounts(); counts.view_seconds = seconds; add(hour, counts); });
        for (const [hour, counts] of extra) {
          let row = rows.find(row => row.hour === hour);
          if (!row) { row = {hour,...emptyCounts()}; rows.push(row); }
          addCounts(row, counts);
        }
        rows.sort((a,b) => a.hour - b.hour);
      }
      const groups = this.query<{id:string;name:string}>("SELECT * FROM node_groups ORDER BY name");
      const connected = new Map(this.sockets("agent").map(w => { const a = this.attachment(w)!; return [a.id, a]; }));
      const nodes = this.query<Device & {group_id: string | null}>("SELECT nodes.*, node_group_members.group_id FROM nodes LEFT JOIN node_group_members USING(node_id) ORDER BY nodes.name").map(n => {
        const x = this.latest.get(n.node_id);
        const attachment = connected.get(n.node_id), host = x?.host || attachment?.host || JSON.parse(n.host);
        return { node_id: n.node_id, name: n.nickname || (host as {hostname:string}).hostname, nickname: n.nickname, icon: n.icon, auto_update: !!n.auto_update, group_id: n.group_id, state: n.state, host, metrics: x?.metrics || JSON.parse(n.latest), last_seen: x?.seen || n.last_seen, connected: connected.has(n.node_id) };
      });
      const invitations = this.query("SELECT id,expires_at FROM invitations WHERE node_id IS NULL AND expires_at>? ORDER BY expires_at", now);
      if (!includeUsage) return json({ settings: this.settings, group: this.network.code, node_groups: groups, viewers: this.sockets("viewer").length, nodes, invitations });
      let proposed = this.settings;
      if (url.searchParams.has("active")) proposed = { ...this.settings, ...settingsInput({ active_seconds: Number(url.searchParams.get("active")), idle_seconds: Number(url.searchParams.get("idle")) }) };
      const devices = Math.floor(Math.min(MAX_NODES, Math.max(1, Number(url.searchParams.get("devices")) || nodes.filter(n => n.state === "approved").length || 20)));
      return json({ settings: this.settings, group: this.network.code, node_groups: groups, viewers: this.sockets("viewer").length, nodes, invitations,
        usage: { rows, today: sumUsage(rows.filter(r => r.hour >= hourOf(Math.floor(now / 86400_000) * 86400_000))), since: this.runtime.created },
        forecast: forecast(proposed, devices, rows, (now - start) / 1000, this.ctx.storage.sql.databaseSize) });
    }
    return json({ code: "not_found" }, 404);
  }

  private readQuota(): QuotaSnapshot {
    const now = Date.now(), firstHour = Math.floor(hourOf(now) / 24) * 24, lastHour = hourOf(now);
    this.duration.checkpoint(now);
    const today = (hour: number) => hour >= firstHour && hour <= lastHour;
    // At most 24 indexed rows; do not checkpoint just to display usage.
    const totals = sumUsage(this.query<HourUsage>("SELECT * FROM usage WHERE hour>=? AND hour<=?", firstHour, lastHour));
    for (const [hour, counts] of this.pending) if (today(hour)) addCounts(totals, counts);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      // Older epochs are already included in the persisted hourly totals.
      if (attachment?.epoch === this.runtime.epoch && today(attachment.hour)) addCounts(totals, attachment.pending);
    }
    return localQuota(totals, this.ctx.storage.sql.databaseSize, now);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const started = Date.now(), a = this.attachment(ws); if (!a || a.closed) { ws.close(1008, "invalid connection"); return; }
    if (a.authExpires <= started) { this.send(ws, {type: "session_expired"}); ws.close(1008, "Session expired"); return; }
    if (a.epoch !== this.runtime.epoch) { a.epoch = this.runtime.epoch; a.pending = emptyCounts(); }
    if (a.hour !== hourOf(started)) { this.flushUsage(started); Object.assign(a, this.attachment(ws)); a.hour = hourOf(started); }
    a.pending.other_messages++;
    ws.serializeAttachment(a);
    this.duration.begin(started);
    try {
      if (a.role === "viewer" && typeof message !== "string") { ws.close(1008, "invalid viewer message"); return; }
      let body: unknown;
      try { body = JSON.parse(await decodeMessage(message)); } catch (error) { ws.close(error instanceof Error && error.message === "message_too_large" ? 1009 : 1008, "invalid report encoding"); return; }
      // Decompression yields: deletion or connection replacement may have
      // happened while waiting. Never revive or overwrite a closed attachment.
      const fresh = this.attachment(ws), now = Date.now();
      if (!fresh || fresh.closed || fresh.authExpires <= now) { ws.close(1008, "connection no longer authorized"); return; }
      Object.assign(a, fresh);
      // A viewer can join or leave while decompression yields. Use current
      // membership so an old snapshot cannot undo its new reporting interval.
      const watching = this.viewing(now);
      if (a.role === "viewer") {
        if (!body || (body as {type?: string}).type !== "heartbeat") { ws.close(1008, "invalid viewer message"); return; }
        a.expires = now + VIEW_LEASE_MS; ws.serializeAttachment(a);
        // Keep the persisted union viewing cursor safe through hibernation.
        this.runtime.viewExpires = Math.max(this.runtime.viewExpires, a.expires);
        this.send(ws, { type: "heartbeat_ack" });
        await this.syncViewing(now);
      } else {
        if (body && typeof body === "object" && (body as {type?: string}).type === "hello") {
          const hello = body as {protocol?: number; session?: string; host?: Record<string, unknown>};
          const host = hello.host && { ...hello.host, agent_version: a.agentVersion, agent_revision: a.agentRevision };
          if (a.protocol || hello.protocol !== 2 || !a.agentVersion || typeof hello.session !== "string" || !/^[a-f0-9]{32}$/.test(hello.session) || !validHost(host)) { ws.close(1008, "invalid hello"); return; }
          // Store only bounded host fields: arbitrary client keys must not
          // grow the hibernation attachment or consume database storage.
          a.host = { hostname: host.hostname, os: host.os, arch: host.arch, cpus: host.cpus, agent_version: a.agentVersion };
          if (a.agentRevision) a.host.agent_revision = a.agentRevision;
          if (host.physical_cpus !== undefined) a.host.physical_cpus = host.physical_cpus;
          if (host.logical_cpus !== undefined) a.host.logical_cpus = host.logical_cpus;
          if (host.cpu_model !== undefined) a.host.cpu_model = host.cpu_model;
          if (typeof host.kernel === "string" && host.kernel.length <= 128) a.host.kernel = host.kernel;
          const stored = this.query<{host:string}>("SELECT host FROM nodes WHERE node_id=?", a.id!)[0];
          if (!stored) { ws.close(1008, "device removed"); return; }
          const serializedHost = JSON.stringify(a.host);
          // A version/host change is infrequent and worth persisting once, so
          // the panel still shows the upgraded version after the socket closes.
          if (stored.host !== serializedHost) this.query("UPDATE nodes SET host=? WHERE node_id=?", serializedHost, a.id!);
          a.protocol = 2; a.session = hello.session; a.sequence = 0;
          ws.serializeAttachment(a); this.send(ws, {type: "hello_ack"}); return;
        }
        if (a.protocol === 2) {
          const compact = body as {type?: string; sequence?: number; metrics?: Metrics} | null;
          if (!compact || compact.type !== "metrics" || !a.host || !a.session) { ws.close(1008, "invalid compact report"); return; }
          body = { protocol: 1, node_id: a.id, session: a.session, host: a.host, sequence: compact.sequence, metrics: compact.metrics };
        }
        if (!validReport(body, a.id!)) { ws.close(1008, "invalid report"); return; }
        if (body.session === a.session && body.sequence <= (a.sequence || 0)) { ws.close(1008, "duplicate report"); return; }
        if (a.lastReport && started - a.lastReport < Math.max(1000, (a.interval || this.settings.idle_seconds) * 800)) { ws.close(1008, "report rate exceeded"); return; }
        a.pending.other_messages--;
        if (watching) a.pending.fast_messages++; else a.pending.idle_messages++;
        // Decode can yield to another device. Timestamp accepted checkpoints
        // here so batches stay ordered by their primary-key start time.
        const receivedAt = Date.now();
        a.session = body.session; a.sequence = body.sequence; a.lastReport = receivedAt;
        if (!a.savedAt || receivedAt - a.savedAt >= this.settings.idle_seconds * 1000) {
          this.flushHistory(receivedAt);
          const window = this.historyWindow || { from: receivedAt, deadline: receivedAt + this.settings.idle_seconds * 1000, interval: this.settings.idle_seconds, generation: crypto.randomUUID() };
          const snapshot = JSON.stringify(body.metrics);
          const host = JSON.stringify(body.host);
          this.ctx.storage.transactionSync(() => {
            if (!this.historyWindow) this.query("INSERT INTO config(id,value) VALUES(9,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(window));
            this.query("UPDATE nodes SET latest=?,host=?,last_seen=?,history_window=?,history_interval_seconds=? WHERE node_id=?", snapshot, host, receivedAt, window.from, this.settings.idle_seconds, a.id!);
          });
          this.historyWindow = window;
          a.savedAt = receivedAt;
          ws.serializeAttachment(a);
          await this.ensureAlarm(receivedAt);
          // Alarm storage yields too. A deletion, replacement or metering
          // checkpoint must not be undone by serializing the older attachment.
          const current = this.attachment(ws);
          if (!current || current.closed || current.authExpires <= Date.now()) return;
          Object.assign(a, current);
        }
        this.latest.set(a.id!, { metrics: body.metrics, host: body.host, seen: receivedAt });
        for (const viewer of this.sockets("viewer")) this.send(viewer, { type: "metrics", node_id: a.id, metrics: body.metrics, last_seen: receivedAt });
        ws.serializeAttachment(a); this.configureAgent(ws);
        this.send(ws, { type: "ack", sequence: body.sequence });
      }
    } finally {
      // A viewer transition may checkpoint/reset all attachments. Always add
      // handler duration to the current epoch instead of restoring stale data.
      this.duration.end();
      const current = this.attachment(ws);
      if (current) {
        // Move event accounting into the hibernation attachment as well.
        const extra = this.pending.get(current.hour);
        if (extra) { addCounts(current.pending, extra); this.pending.delete(current.hour); }
        ws.serializeAttachment(current);
      }
      if (Date.now() - this.runtime.checkpoint >= CHECKPOINT_MS) this.flushUsage();
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { await this.closeSocket(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.closeSocket(ws); }
  private async closeSocket(ws: WebSocket): Promise<void> {
    const a = this.attachment(ws); if (!a || a.closed) return;
    this.duration.begin();
    try {
      a.closed = true; a.closedAt = Date.now(); ws.serializeAttachment(a); this.closed.add(ws);
      this.flushUsage(Date.now(), ws);
      this.closed.delete(ws);
      await this.syncViewing();
      if (a.role === "agent") this.refreshViewers();
    } finally {
      this.duration.end();
      this.stashPendingCounters();
    }
  }
  async alarm(): Promise<void> {
    this.duration.begin();
    try {
      this.scheduledAlarm = null; this.counter().alarms++;
      const now = Date.now();
      this.flushHistory(now);
      const invitationExpired = this.invitationDeadline !== null && this.invitationDeadline <= now;
      if (invitationExpired) { this.purgeInvitations(); this.refreshViewers(); }
      for (const ws of this.ctx.getWebSockets()) {
        const a = this.attachment(ws);
        if (a && (a.authExpires <= now || (a.role === "viewer" && (a.expires || 0) <= now))) {
          this.send(ws, { type: "session_expired" }); ws.close(1008, "connection expired");
        }
      }
      await this.syncViewing(now);
      this.query("DELETE FROM usage WHERE hour<?", hourOf(now - USAGE_RETENTION_DAYS * 86400_000));
    } finally {
      this.duration.end();
      this.flushUsage();
    }
  }
}
