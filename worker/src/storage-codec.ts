import { gzipSync, gunzipSync } from "node:zlib";

export type StorageCodec = "utf8-v1" | "gzip-v1";
export type EncodedStorageText = { codec: StorageCodec; payload: ArrayBuffer; rawBytes: number };

// Keep synchronous compression/decompression bounded independently of callers.
// Full live snapshots are not packed. The cap also accommodates JSON escaping
// when a batch contains up to 200 individually bounded historical summaries.
export const STORAGE_MAX_BYTES = 1024 * 1024;
export const STORAGE_COMPRESSION_MIN_BYTES = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Accept already-serialized JSON so compression never rounds or rewrites values.
export function encodeStorageText(text: string): EncodedStorageText {
  // UTF-8 cannot be shorter than the UTF-16 code-unit count for well-formed text.
  if (text.length > STORAGE_MAX_BYTES) throw new Error("storage_payload_too_large");
  const plain = encoder.encode(text), rawBytes = plain.byteLength;
  if (rawBytes > STORAGE_MAX_BYTES) throw new Error("storage_payload_too_large");
  if (rawBytes >= STORAGE_COMPRESSION_MIN_BYTES) {
    const compressed = gzipSync(plain, { level: 1 });
    // Tiny savings are not worth the extra CPU on every future history read.
    if (rawBytes - compressed.byteLength >= Math.max(64, Math.ceil(rawBytes / 8))) {
      // A Node Buffer may be a view into a larger pooled allocation. Return an
      // exact ArrayBuffer accepted by SQL bindings without leaking pool bytes.
      return { codec: "gzip-v1", payload: Uint8Array.from(compressed).buffer, rawBytes };
    }
  }
  return { codec: "utf8-v1", payload: plain.slice().buffer, rawBytes };
}

export function decodeStorageText(codec: string, payload: ArrayBuffer | Uint8Array, maxOutputBytes: number): string {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > STORAGE_MAX_BYTES) {
    throw new Error("invalid_storage_output_limit");
  }
  if (codec !== "utf8-v1" && codec !== "gzip-v1") throw new Error("unsupported_storage_codec");
  if (payload.byteLength > STORAGE_MAX_BYTES) throw new Error("storage_payload_too_large");
  const input = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (codec === "utf8-v1") {
    if (input.byteLength > maxOutputBytes) throw new Error("storage_payload_too_large");
    return decoder.decode(input);
  }
  // Enforce the cap while inflating, including concatenated gzip members. A
  // footer size alone is insufficient because it is untrusted and can wrap.
  const output = gunzipSync(input, { maxOutputLength: maxOutputBytes });
  if (output.byteLength > maxOutputBytes) throw new Error("storage_payload_too_large");
  return decoder.decode(output);
}
