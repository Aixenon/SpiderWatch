"""One platform catalogue for CI, local builds and update validation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from repository import resolve_repository

ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = json.loads((ROOT / 'internal/agent/platforms.json').read_text())

def filename(p):
    return f"spider-watch-{p['os']}-{p['arch']}" + ('.exe' if p['os']=='windows' else '')

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--target', default='all')
    parser.add_argument('--version', default=os.environ.get('VERSION','0.7.0-dev'))
    parser.add_argument('--output', type=Path, default=ROOT/'dist')
    parser.add_argument('--matrix', action='store_true')
    parser.add_argument('--assemble', action='store_true')
    parser.add_argument('--repository')
    parser.add_argument('--installers', action='store_true')
    args=parser.parse_args()
    if args.matrix:
        print(json.dumps({'include':[{'target':f"{p['os']}-{p['arch']}"} for p in PLATFORMS]},separators=(',',':'))); return
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?',args.version): parser.error('invalid version')
    targets=[p for p in PLATFORMS if args.target in ('all',f"{p['os']}-{p['arch']}")]
    if not targets: parser.error('unsupported target')
    output=args.output.resolve(); output.mkdir(parents=True,exist_ok=True)
    for p in targets:
        if args.assemble: continue
        env=os.environ.copy()
        for key in ['GOARM','GOARM64','GOMIPS','GOMIPS64','GOAMD64','GO386','GOPPC64','GORISCV64']: env.pop(key,None)
        env.update(p['env']); env.update(CGO_ENABLED='0',GOOS=p['os'],GOARCH=p['goarch'],GOEXPERIMENT='nojsonv2')
        subprocess.run([os.environ.get('GO','go'),'build','-trimpath','-buildvcs=false','-ldflags',
            f"-s -w -X main.version={args.version} -X spiderwatch/client/internal/agent.BuildArch={p['arch']}",
            '-o',str(output/filename(p)),'./cmd/spider-watch'],cwd=ROOT,env=env,check=True)
        print(f"Built {filename(p)}",flush=True)
    assets=[]
    for p in targets:
        file=output/filename(p)
        size=file.stat().st_size
        if not 1024<=size<=16*1024*1024: raise ValueError(f'{file.name}: binary size limit')
        with file.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
        assets.append(dict(os=p['os'],arch=p['arch'],file=file.name,bytes=size,sha256=digest))
    # Per-job fragments cannot collide when Actions merges artifacts.
    if args.target!='all':
        (output/f'{args.target}.json').write_text(json.dumps(dict(version=args.version,asset=assets[0]))+'\n'); return
    if args.assemble:
        for asset in assets:
            metadata=json.loads((output/f"{asset['os']}-{asset['arch']}.json").read_text())
            if metadata.get('version')!=args.version or metadata.get('asset')!=asset:
                raise ValueError('Mixed versions or modified matrix artifacts; rebuild the complete release')
    (output/'manifest.json').write_text(json.dumps(assets,indent=2)+'\n')
    (output/'update-manifest.json').write_text(json.dumps(dict(schema=1,version=args.version,assets=assets),indent=2)+'\n')
    repository=resolve_repository(args.repository)
    extras=[]
    if args.installers:
        for arch in ['amd64','arm64','386']:
            file=output/f'spider-watch-windows-{arch}-setup.exe'
            if not 1024<=file.stat().st_size<=32*1024*1024: raise ValueError('Missing or oversized Windows installer')
            with file.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
            extras.append(dict(file=file.name,sha256=digest))
    for name in ['install.sh','install.ps1']:
        content=(ROOT/'scripts'/name).read_text().replace('__SPIDER_REPOSITORY__',repository).replace('__SPIDER_VERSION__','v'+args.version)
        (output/name).write_text(content,encoding='utf-8',newline='\n')
        with (output/name).open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
        extras.append(dict(file=name,sha256=digest))
    (output/'checksums.txt').write_text(''.join(f"{a['sha256']}  {a['file']}\n" for a in assets+extras))
    (output/'release-info.json').write_text(json.dumps(dict(repository=repository,version=args.version))+'\n')

if __name__=='__main__': main()
