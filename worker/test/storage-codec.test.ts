import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { STORAGE_COMPRESSION_MIN_BYTES, STORAGE_MAX_BYTES, decodeStorageText, encodeStorageText } from "../src/storage-codec";

const encoder = new TextEncoder();
afterEach(async () => { await reset(); });

it("preserves serialized numbers, Unicode, BOM and empty text without reserialization", () => {
  const values = ["", "\uFEFF中文 😀 café", '{"cpu":0.12345678901234567,"bytes":9007199254740991,"zero":-0,"tiny":1e-300,"text":"\\ud800"}'];
  for (const text of values) {
    const encoded = encodeStorageText(text);
    expect(encoded.codec).toBe("utf8-v1");
    expect(encoded.rawBytes).toBe(encoder.encode(text).byteLength);
    expect(decodeStorageText(encoded.codec, encoded.payload, Math.max(1, encoded.rawBytes))).toBe(text);
  }
});

it("compresses repetitive batches losslessly only above the byte threshold", () => {
  const small = "x".repeat(STORAGE_COMPRESSION_MIN_BYTES - 1);
  expect(encodeStorageText(small).codec).toBe("utf8-v1");
  const threshold = encodeStorageText("x".repeat(STORAGE_COMPRESSION_MIN_BYTES));
  expect(threshold.codec).toBe("gzip-v1");
  const text = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
    id: String(i).padStart(32, "0"), time: 1791244800123 + i, cpu: i / 7,
    networks: [["网卡 😀", i * 1048576 + 0.123456789, null]],
  })));
  const encoded = encodeStorageText(text);
  expect(encoded.codec).toBe("gzip-v1");
  expect(encoded.payload.byteLength).toBeLessThanOrEqual(encoded.rawBytes * 0.875);
  expect(decodeStorageText(encoded.codec, encoded.payload, encoded.rawBytes)).toBe(text);
  expect(() => decodeStorageText(encoded.codec, encoded.payload, encoded.rawBytes - 1)).toThrow();
});

it("keeps poorly compressible text as raw UTF-8", () => {
  // Deterministic 7-bit data; gzip framing prevents reaching 12.5% savings.
  let state = 0x71a20f19;
  const text = Array.from({ length: STORAGE_COMPRESSION_MIN_BYTES }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return String.fromCharCode((state >>> 0) % 128);
  }).join("");
  const encoded = encodeStorageText(text);
  expect(encoded.codec).toBe("utf8-v1");
  expect(decodeStorageText(encoded.codec, encoded.payload, encoded.rawBytes)).toBe(text);
});

it("accepts SQL ArrayBuffers and respects byte offsets on typed-array views", () => {
  for (const text of ["原文", "中文/😀/exact/".repeat(200)]) {
    const encoded = encodeStorageText(text), padded = new Uint8Array(encoded.payload.byteLength + 8);
    padded.fill(0xff); padded.set(new Uint8Array(encoded.payload), 4);
    const view = padded.subarray(4, padded.byteLength - 4);
    expect(decodeStorageText(encoded.codec, view, encoded.rawBytes)).toBe(text);
    expect(decodeStorageText(encoded.codec, Uint8Array.from(view).buffer, encoded.rawBytes)).toBe(text);
  }
});

it("rejects unknown codecs, invalid output limits and oversized raw input", () => {
  const input = encoder.encode("ok");
  expect(() => decodeStorageText("gzip-v2", input, 2)).toThrow("unsupported_storage_codec");
  for (const limit of [0, -1, 1.5, NaN, Infinity, STORAGE_MAX_BYTES + 1]) {
    expect(() => decodeStorageText("utf8-v1", input, limit)).toThrow("invalid_storage_output_limit");
  }
  expect(() => decodeStorageText("utf8-v1", input, 1)).toThrow("storage_payload_too_large");
  expect(() => encodeStorageText("x".repeat(STORAGE_MAX_BYTES + 1))).toThrow("storage_payload_too_large");
  expect(() => encodeStorageText("中".repeat(Math.floor(STORAGE_MAX_BYTES / 3) + 1))).toThrow("storage_payload_too_large");
  for (const codec of ["utf8-v1", "gzip-v1"]) {
    expect(() => decodeStorageText(codec, new Uint8Array(STORAGE_MAX_BYTES + 1), STORAGE_MAX_BYTES)).toThrow("storage_payload_too_large");
  }
});

it("rejects truncated/corrupt gzip and invalid UTF-8 in either codec", () => {
  const encoded = encodeStorageText("data/数据".repeat(300));
  expect(encoded.codec).toBe("gzip-v1");
  expect(() => decodeStorageText(encoded.codec, encoded.payload.slice(0, -1), encoded.rawBytes)).toThrow();
  const badChecksum = new Uint8Array(encoded.payload.slice(0)); badChecksum[badChecksum.length - 8] ^= 0x80;
  expect(() => decodeStorageText(encoded.codec, badChecksum, encoded.rawBytes)).toThrow();
  expect(() => decodeStorageText("gzip-v1", encoder.encode("not gzip"), 100)).toThrow();
  const invalidUTF8 = Uint8Array.of(0xc3, 0x28);
  expect(() => decodeStorageText("utf8-v1", invalidUTF8, 2)).toThrow();
  expect(() => decodeStorageText("gzip-v1", gzipSync(invalidUTF8), 2)).toThrow();
});

it("bounds inflated data for high-ratio payloads and concatenated gzip members", () => {
  const bomb = gzipSync("x".repeat(STORAGE_MAX_BYTES * 8), { level: 1 });
  expect(bomb.byteLength).toBeLessThan(64 * 1024);
  expect(() => decodeStorageText("gzip-v1", bomb, 512 * 1024)).toThrow();
  const member = gzipSync("x".repeat(64 * 1024)), joined = new Uint8Array(member.length * 2);
  joined.set(member); joined.set(member, member.length);
  expect(() => decodeStorageText("gzip-v1", joined, 64 * 1024)).toThrow();
  expect(decodeStorageText("gzip-v1", joined, 128 * 1024).length).toBe(128 * 1024);
});

it("persists both codec forms as SQLite BLOBs and reads them after eviction", async () => {
  const stub = env.MONITOR.getByName("storage-codec-runtime");
  const texts = ["原文 😀", JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, cpu: i / 7, rx: 987654321.1234567 })))];
  await runInDurableObject(stub, (_, ctx) => {
    ctx.storage.sql.exec("CREATE TABLE codec_test (id INTEGER PRIMARY KEY, codec TEXT NOT NULL, payload BLOB NOT NULL)");
    for (let i = 0; i < texts.length; i++) {
      const encoded = encodeStorageText(texts[i]);
      ctx.storage.sql.exec("INSERT INTO codec_test (id,codec,payload) VALUES (?,?,?)", i, encoded.codec, encoded.payload);
    }
  });
  await evictDurableObject(stub);
  const rows = await runInDurableObject(stub, (_, ctx) => ctx.storage.sql.exec<{ id: number; codec: string; payload: ArrayBuffer; kind: string }>(
    "SELECT id,codec,payload,typeof(payload) AS kind FROM codec_test ORDER BY id",
  ).toArray().map(row => ({ codec: row.codec, kind: row.kind, text: decodeStorageText(row.codec, row.payload, 512 * 1024) })));
  expect(rows.map(row => row.codec)).toEqual(["utf8-v1", "gzip-v1"]);
  expect(rows.map(row => row.kind)).toEqual(["blob", "blob"]);
  expect(rows.map(row => row.text)).toEqual(texts);
});
