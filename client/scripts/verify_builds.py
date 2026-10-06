"""Inspect release artifacts; no target-platform execution is implied."""
import json
import argparse
import hashlib
from pathlib import Path
import struct

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--release-dir', type=Path, default=root / 'dist')
parser.add_argument('--output', type=Path, help='Write artifact details to a JSON file')
args = parser.parse_args()
result = []
entries = json.loads((args.release_dir / 'manifest.json').read_text(encoding='utf-8-sig'))
updates = json.loads((args.release_dir / 'update-manifest.json').read_text(encoding='utf-8-sig'))
assert updates['schema'] == 1 and updates['assets'] == entries
platforms = json.loads((root / 'internal/agent/platforms.json').read_text())
assert {(e['os'],e['arch']) for e in entries} == {(p['os'],p['arch']) for p in platforms}
for entry in entries:
    path = args.release_dir / entry['file']
    assert path.stat().st_size <= 16 * 1024 * 1024
    assert path.stat().st_size == entry['bytes']
    with path.open('rb') as binary:
        assert hashlib.file_digest(binary, 'sha256').hexdigest() == entry['sha256']
    row = {"file": path.name, "bytes": path.stat().st_size, "sha256": entry["sha256"]}
    if entry['os'] == 'windows':
        with path.open('rb') as binary:
            header = binary.read(64)
            assert header[:2] == b'MZ'
            binary.seek(struct.unpack_from('<I', header, 60)[0])
            signature = binary.read(6)
            assert signature[:4] == b'PE\0\0'
            assert struct.unpack_from('<H', signature, 4)[0] == {'amd64': 0x8664, 'arm64': 0xaa64, '386': 0x14c}[entry['arch']]
            row['pe_architecture'] = entry['arch']
    if entry['os'] == 'darwin':
        with path.open('rb') as binary:
            header=binary.read(32)
            assert header[:4]==b'\xcf\xfa\xed\xfe', 'Not 64-bit Mach-O'
            assert struct.unpack_from('<I',header,4)[0]=={'amd64':0x1000007,'arm64':0x100000c}[entry['arch']]
            row['macho_architecture']=entry['arch']
    if entry["os"] == "linux":
        with path.open("rb") as f:
            header = f.read(64)
            assert header[:4] == b"\x7fELF"
            bits = 64 if header[4] == 2 else 32
            endian = "<" if header[5] == 1 else ">"
            off = struct.unpack_from(endian + ("Q" if bits == 64 else "I"), header, 32 if bits == 64 else 28)[0]
            size, count = struct.unpack_from(endian + "HH", header, 54 if bits == 64 else 42)
            kinds = []
            for index in range(count):
                f.seek(off + index * size)
                kinds.append(struct.unpack(endian + "I", f.read(4))[0])
            assert 2 not in kinds and 3 not in kinds, "ELF requires dynamic loader"
            architecture={'amd64':(62,64,1),'386':(3,32,1),'armv5':(40,32,1),'armv6':(40,32,1),'armv7':(40,32,1),'arm64':(183,64,1),'mips-softfloat':(8,32,2),'mipsle-softfloat':(8,32,1),'mips64-softfloat':(8,64,2),'mips64le-softfloat':(8,64,1),'riscv64':(243,64,1),'loong64':(258,64,1),'ppc64le':(21,64,1),'s390x':(22,64,2)}
            assert (struct.unpack_from(endian+'H',header,18)[0],bits,header[5])==architecture[entry['arch']]
            row.update(static_elf=True, bitness=bits)
    result.append(row)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"targets": len(result), "static_linux": sum("static_elf" in r for r in result),
                  "largest_bytes": max(r["bytes"] for r in result)}))
