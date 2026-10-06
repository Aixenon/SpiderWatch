"""Derive release ownership from CI or this checkout, never from a fixed owner."""
import os
import re
import subprocess

REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')

def resolve_repository(explicit=None):
    value=explicit or os.environ.get('GITHUB_REPOSITORY','')
    if not value:
        result=subprocess.run(['git','config','--get','remote.origin.url'],capture_output=True,text=True)
        remote=result.stdout.strip()
        for prefix in ['https://github.com/','git@github.com:','ssh://git@github.com/']:
            if remote.startswith(prefix): value=remote[len(prefix):].removesuffix('.git'); break
    if not REPOSITORY.fullmatch(value):
        raise ValueError('Cannot determine GitHub repository: run in a GitHub checkout or pass --repository OWNER/REPO')
    return value
