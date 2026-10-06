import { MAX_MESSAGE_BYTES } from "./model";

// Binary agent frames contain an independent gzip stream. Bound both sides of
// decompression; never assemble an unbounded Response(...).arrayBuffer().
export async function decodeMessage(message: string | ArrayBuffer): Promise<string> {
  if (typeof message === "string") {
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
    return message;
  }
  if (message.byteLength > MAX_MESSAGE_BYTES || message.byteLength < 18) throw new Error("invalid_compression");
  const input = new Uint8Array(message);
  if (input[0] !== 0x1f || input[1] !== 0x8b) throw new Error("invalid_compression");
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(input); controller.close(); } });
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_MESSAGE_BYTES) { await reader.cancel().catch(() => {}); throw new Error("message_too_large"); }
      chunks.push(next.value);
    }
    const output = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(output);
  } finally { reader.releaseLock(); }
}
