import { decodeStorageText, encodeStorageText } from "./storage-codec";

export type HistoryBatch = { version: 1; samples: [node: string, time: number, interval: number, snapshot: string][] };
export const HISTORY_BATCH_MAX_BYTES = 1024 * 1024;
export const HISTORY_CHUNK_NODES = 8;
const CHUNK_CODEC = "history-chunks-v1";
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true});
type Encoded = {codec:string;payload:ArrayBuffer};
type Chunk = {nodes:string[];codec:string;data:Uint8Array};

function parseBatch(text:string):HistoryBatch {
  const batch = JSON.parse(text) as HistoryBatch;
  if (batch?.version !== 1 || !Array.isArray(batch.samples)) throw new Error("invalid_history_batch");
  for (const sample of batch.samples) if (!Array.isArray(sample) || sample.length !== 4
    || !/^[a-f0-9]{32}$/.test(sample[0]) || !Number.isSafeInteger(sample[1]) || sample[1]<0
    || !Number.isInteger(sample[2]) || sample[2]<30 || sample[2]>86400 || typeof sample[3]!=="string") throw new Error("invalid_history_sample");
  return batch;
}
function encodeChunk(samples:HistoryBatch["samples"]):Chunk {
  const text=JSON.stringify({version:1,samples});
  if(samples.length>HISTORY_CHUNK_NODES||encoder.encode(text).byteLength>64*1024)throw new Error("history_chunk_too_large");
  const encoded=encodeStorageText(text);
  return {nodes:[...new Set(samples.map(sample=>sample[0]))],codec:encoded.codec,data:new Uint8Array(encoded.payload)};
}
function pack(chunks:Chunk[]):Encoded {
  const header=encoder.encode(JSON.stringify(chunks.map(chunk=>({nodes:chunk.nodes,codec:chunk.codec,bytes:chunk.data.byteLength}))));
  const length=8+header.byteLength+chunks.reduce((sum,chunk)=>sum+chunk.data.byteLength,0);
  if(length>HISTORY_BATCH_MAX_BYTES)throw new Error("history_batch_too_large");
  const payload=new ArrayBuffer(length),bytes=new Uint8Array(payload);
  bytes.set([83,87,72,49]); // SWH1; offsets are relative to the payload section.
  new DataView(payload).setUint32(4,header.byteLength);
  bytes.set(header,8);let offset=8+header.byteLength;
  for(const chunk of chunks){bytes.set(chunk.data,offset);offset+=chunk.data.byteLength;}
  return {codec:CHUNK_CODEC,payload};
}
function unpack(payload:ArrayBuffer|Uint8Array):Chunk[] {
  const bytes=payload instanceof Uint8Array?payload:new Uint8Array(payload);
  if(bytes.byteLength<8||bytes.byteLength>HISTORY_BATCH_MAX_BYTES||bytes[0]!==83||bytes[1]!==87||bytes[2]!==72||bytes[3]!==49)throw new Error("invalid_history_chunks");
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4);
  if(size>65536||size+8>bytes.byteLength)throw new Error("invalid_history_chunk_header");
  const header=JSON.parse(decoder.decode(bytes.subarray(8,8+size)));
  if(!Array.isArray(header)||header.length>256)throw new Error("invalid_history_chunk_header");
  let offset=8+size;
  const chunks:Chunk[]=header.map(chunk=>{
    if(!chunk||!Array.isArray(chunk.nodes)||!chunk.nodes.length||chunk.nodes.length>HISTORY_CHUNK_NODES
      ||chunk.nodes.some((id:unknown)=>typeof id!=="string"||!/^[a-f0-9]{32}$/.test(id))
      ||!["utf8-v1","gzip-v1"].includes(chunk.codec)||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<=0||offset+chunk.bytes>bytes.byteLength)throw new Error("invalid_history_chunk_header");
    const result={nodes:chunk.nodes,codec:chunk.codec,data:bytes.subarray(offset,offset+chunk.bytes)};
    offset+=chunk.bytes;return result;
  });
  if(offset!==bytes.byteLength)throw new Error("invalid_history_chunk_length");
  return chunks;
}
function readChunk(chunk:Chunk):HistoryBatch {
  // Every chunk contains at most eight summaries, including JSON escaping.
  const batch=parseBatch(decodeStorageText(chunk.codec,chunk.data,64*1024));
  if(batch.samples.length>HISTORY_CHUNK_NODES||batch.samples.some(sample=>!chunk.nodes.includes(sample[0]))
    ||chunk.nodes.some(id=>!batch.samples.some(sample=>sample[0]===id)))throw new Error("invalid_history_chunk_index");
  return batch;
}
export function encodeHistoryBatch(batch:HistoryBatch):Encoded {
  if(encoder.encode(JSON.stringify(batch)).byteLength>HISTORY_BATCH_MAX_BYTES)throw new Error("history_batch_too_large");
  const chunks:Chunk[]=[];
  for(let start=0;start<batch.samples.length;start+=HISTORY_CHUNK_NODES)chunks.push(encodeChunk(batch.samples.slice(start,start+HISTORY_CHUNK_NODES)));
  return pack(chunks);
}
// Read only the matching chunk for a device query.
export function historyBatchSamples(codec:string,payload:ArrayBuffer|Uint8Array,node?:string):HistoryBatch["samples"] {
  if(codec!==CHUNK_CODEC)throw new Error("unsupported_history_codec");
  const samples:HistoryBatch["samples"]=[];
  for(const chunk of unpack(payload))if(!node||chunk.nodes.includes(node))samples.push(...readChunk(chunk).samples.filter(sample=>!node||sample[0]===node));
  return samples;
}
export function decodeHistoryBatch(codec:string,payload:ArrayBuffer|Uint8Array):HistoryBatch {
  return {version:1,samples:historyBatchSamples(codec,payload)};
}
// Copy unaffected compressed blocks verbatim. Deletion does not recompress a
// full fleet for each of a week's batches, and remains one SQL update per row.
export function removeHistoryNode(codec:string,payload:ArrayBuffer|Uint8Array,node:string):Encoded|null|"empty" {
  if(codec!==CHUNK_CODEC)throw new Error("unsupported_history_codec");
  const chunks=unpack(payload);let changed=false;const remaining:Chunk[]=[];
  for(const chunk of chunks){
    if(!chunk.nodes.includes(node)){remaining.push(chunk);continue;}
    const samples=readChunk(chunk).samples.filter(sample=>sample[0]!==node);changed=true;
    if(samples.length)remaining.push(encodeChunk(samples));
  }
  return !changed?null:remaining.length?pack(remaining):"empty";
}
