import { expect, it } from "vitest";
import { HISTORY_BATCH_MAX_BYTES, HISTORY_CHUNK_NODES, decodeHistoryBatch, encodeHistoryBatch, historyBatchSamples, removeHistoryNode, type HistoryBatch } from "../src/history-batch-codec";
import { encodeStorageText } from "../src/storage-codec";

function fixture(count = 35): HistoryBatch {
  return { version: 1, samples: Array.from({ length: count }, (_, i) => [i.toString(16).padStart(32, "0"), 1791244800000 + i, 120,
    JSON.stringify({ cpu_percent: i / 7, memory: { total_bytes: 9007199254740991, used_bytes: 123456789.12345679 }, networks: [["网卡 😀", 1.2345678901234567, null]] })]) };
}
type Header = { nodes: string[]; codec: string; bytes: number }[];
function blocks(payload: ArrayBuffer) {
  const bytes = new Uint8Array(payload), size = new DataView(payload).getUint32(4);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, size + 8))) as Header;
  let offset = size + 8;
  return header.map(chunk => { const data = bytes.slice(offset, offset + chunk.bytes); offset += chunk.bytes; return { ...chunk, data }; });
}
function withHeader(payload: ArrayBuffer, edit: (header: Header) => void): ArrayBuffer {
  const old = new Uint8Array(payload), oldSize = new DataView(payload).getUint32(4);
  const header = JSON.parse(new TextDecoder().decode(old.subarray(8, oldSize + 8))) as Header;
  edit(header);
  const nextHeader = new TextEncoder().encode(JSON.stringify(header)), next = new Uint8Array(8 + nextHeader.length + old.length - oldSize - 8);
  next.set(old.subarray(0, 4)); new DataView(next.buffer).setUint32(4, nextHeader.length);
  next.set(nextHeader, 8); next.set(old.subarray(oldSize + 8), nextHeader.length + 8);
  return next.buffer;
}

it("round-trips a 200-node batch and reads only the requested device with exact values", () => {
  const batch = fixture(200), encoded = encodeHistoryBatch(batch);
  expect(encoded.codec).toBe("history-chunks-v1");
  expect(encoded.payload.byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(batch)).byteLength);
  expect(HISTORY_CHUNK_NODES).toBe(8);
  expect(blocks(encoded.payload).map(block=>block.nodes.length)).toEqual(Array(25).fill(8));
  expect(decodeHistoryBatch(encoded.codec, encoded.payload)).toEqual(batch);
  for (const index of [0, 7, 8, 15, 16, 31, 199]) expect(historyBatchSamples(encoded.codec, encoded.payload, batch.samples[index][0])).toEqual([batch.samples[index]]);
  expect(historyBatchSamples(encoded.codec, encoded.payload, "f".repeat(32))).toEqual([]);
  const padded = new Uint8Array(encoded.payload.byteLength + 16); padded.set(new Uint8Array(encoded.payload), 8);
  expect(historyBatchSamples(encoded.codec, padded.subarray(8, -8), batch.samples[0][0])).toEqual([batch.samples[0]]);
});

it("removes a node physically while preserving all other compressed block bytes", () => {
  const batch = fixture(), encoded = encodeHistoryBatch(batch), removed = removeHistoryNode(encoded.codec, encoded.payload, batch.samples[3][0]);
  expect(removed).not.toBeNull(); expect(removed).not.toBe("empty");
  if (!removed || removed === "empty") throw new Error("expected updated payload");
  expect(decodeHistoryBatch(removed.codec, removed.payload).samples).toEqual(batch.samples.filter((_, i) => i !== 3));
  const before = blocks(encoded.payload), after = blocks(removed.payload);
  expect(after[0].nodes).toHaveLength(7);
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(after[0].nodes).not.toContain(batch.samples[3][0]);
  expect(removeHistoryNode(removed.codec, removed.payload, batch.samples[3][0])).toBeNull();
  expect(removeHistoryNode(encoded.codec, encoded.payload, "f".repeat(32))).toBeNull();
  const one = encodeHistoryBatch(fixture(1));
  expect(removeHistoryNode(one.codec, one.payload, batch.samples[0][0])).toBe("empty");
});

it("does not inflate unrelated blocks when selecting or deleting a device", () => {
  const batch = fixture(), encoded = encodeHistoryBatch(batch), corrupted = encoded.payload.slice(0), entries = blocks(encoded.payload);
  const headerSize = new DataView(corrupted).getUint32(4), bytes = new Uint8Array(corrupted);
  const secondEnd = 8 + headerSize + entries[0].bytes + entries[1].bytes;
  expect(entries[1].codec).toBe("gzip-v1");
  bytes[secondEnd - 8] ^= 0x80;
  expect(historyBatchSamples(encoded.codec, corrupted, batch.samples[0][0])).toEqual([batch.samples[0]]);
  expect(() => historyBatchSamples(encoded.codec, corrupted, batch.samples[HISTORY_CHUNK_NODES][0])).toThrow();
  expect(() => decodeHistoryBatch(encoded.codec, corrupted)).toThrow();
  const removed = removeHistoryNode(encoded.codec, corrupted, batch.samples[0][0]);
  if (!removed || removed === "empty") throw new Error("expected updated payload");
  expect(blocks(removed.payload)[1].data).toEqual(blocks(corrupted)[1].data);
});

it("rejects any batch codec other than the current chunk format", () => {
  const batch = fixture(), encoded = encodeHistoryBatch(batch), node = batch.samples[0][0];
  for (const codec of ["", "utf8-v1", "gzip-v1", "history-chunks-v2"]) {
    expect(() => decodeHistoryBatch(codec, encoded.payload)).toThrow("unsupported_history_codec");
    expect(() => historyBatchSamples(codec, encoded.payload, node)).toThrow("unsupported_history_codec");
    expect(() => removeHistoryNode(codec, encoded.payload, node)).toThrow("unsupported_history_codec");
  }
});

it("rejects a nine-node chunk header before selecting or deleting any node", () => {
  const batch = fixture(), encoded = encodeHistoryBatch(batch);
  const oversizedIndex = withHeader(encoded.payload, h => { h[0].nodes.push(batch.samples[8][0]); });
  expect(() => decodeHistoryBatch(encoded.codec, oversizedIndex)).toThrow("invalid_history_chunk_header");
  expect(() => historyBatchSamples(encoded.codec, oversizedIndex, batch.samples[0][0])).toThrow("invalid_history_chunk_header");
  expect(() => removeHistoryNode(encoded.codec, oversizedIndex, batch.samples[0][0])).toThrow("invalid_history_chunk_header");
});

it("rejects inflated chunk output above 64 KiB", () => {
  const batch = fixture(1); batch.samples[0][3] = "x".repeat(64 * 1024);
  const block = encodeStorageText(JSON.stringify(batch));
  const header = new TextEncoder().encode(JSON.stringify([{ nodes: [batch.samples[0][0]], codec: block.codec, bytes: block.payload.byteLength }]));
  const payload = new ArrayBuffer(8 + header.byteLength + block.payload.byteLength), bytes = new Uint8Array(payload);
  bytes.set([83,87,72,49]); new DataView(payload).setUint32(4, header.byteLength);
  bytes.set(header, 8); bytes.set(new Uint8Array(block.payload), 8 + header.byteLength);
  expect(() => decodeHistoryBatch("history-chunks-v1", payload)).toThrow();
  expect(() => historyBatchSamples("history-chunks-v1", payload, batch.samples[0][0])).toThrow();
  expect(() => removeHistoryNode("history-chunks-v1", payload, batch.samples[0][0])).toThrow();
});

it("rejects malformed framing, block indexes, codecs and oversized output", () => {
  const batch = fixture(), encoded = encodeHistoryBatch(batch);
  for (const length of [0, 7, encoded.payload.byteLength - 1]) expect(() => decodeHistoryBatch(encoded.codec, encoded.payload.slice(0, length))).toThrow();
  const badMagic = encoded.payload.slice(0); new Uint8Array(badMagic)[0] = 0;
  expect(() => decodeHistoryBatch(encoded.codec, badMagic)).toThrow();
  const badSize = encoded.payload.slice(0); new DataView(badSize).setUint32(4, 0xffffffff);
  expect(() => decodeHistoryBatch(encoded.codec, badSize)).toThrow();
  const edits: ((header: Header) => void)[] = [
    h => { h[0].bytes = Number.MAX_SAFE_INTEGER; }, h => { h[0].bytes = -1; }, h => { h[0].bytes = 1.5; },
    h => { h[0].codec = "gzip-v9"; }, h => { h[0].nodes = []; }, h => { h[0].nodes = ["invalid"]; },
    h => { h[0].nodes[0] = "f".repeat(32); },
  ];
  for (const edit of edits) expect(() => decodeHistoryBatch(encoded.codec, withHeader(encoded.payload, edit))).toThrow();
  expect(() => decodeHistoryBatch(encoded.codec, new ArrayBuffer(HISTORY_BATCH_MAX_BYTES + 1))).toThrow();
  const oversized = fixture(1); oversized.samples[0][3] = "x".repeat(256 * 1024);
  expect(() => encodeHistoryBatch(oversized)).toThrow("history_chunk_too_large");
});
