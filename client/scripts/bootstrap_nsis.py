"""Install a pinned native NSIS compiler in a user-owned build cache."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

VERSION = '3.13'
SOURCES = {
    'nsis-3.13.zip': (
        'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip',
        2363925, 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'),
    'nsis-3.13-src.tar.bz2': (
        'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13-src.tar.bz2',
        1819771, 'a8ffe024602d46b6d766f9e1ce30c324ad2a24daeacd3efc2642d436a0c157ac'),
    'scons-4.10.1-py3-none-any.whl': (
        'https://files.pythonhosted.org/packages/ce/bf/931fb9fbb87234c32b8b1b1c15fba23472a10777c12043336675633809a7/scons-4.10.1-py3-none-any.whl',
        4136069, 'bd9d1c52f908d874eba92a8c0c0a8dcf2ed9f3b88ab956d0fce1da479c4e7126'),
}


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        if urllib.parse.urlsplit(url).scheme != 'https':
            raise ValueError('Build tools must use HTTPS, including redirects')
        return super().redirect_request(request, response, code, message, headers, url)


def matches(path, size, digest):
    if not path.is_file() or path.is_symlink() or path.stat().st_size != size:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == digest


def download(cache, name):
    url, size, digest = SOURCES[name]
    target = cache / name
    if matches(target, size, digest):
        return target
    temporary = target.with_suffix(target.suffix + '.partial')
    try:
        opener = urllib.request.build_opener(HTTPSRedirect())
        with opener.open(url, timeout=60) as response, temporary.open('wb') as output:
            remaining = size
            while chunk := response.read(min(remaining + 1, 65536)):
                remaining -= len(chunk)
                if remaining < 0:
                    raise ValueError('Build tool download exceeds its pinned size')
                output.write(chunk)
        if not matches(temporary, size, digest):
            raise ValueError('Build tool download does not match its pinned SHA256')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def safe_member(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or ':' in name or path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe build tool archive path')
    return path


def unpack(archive, destination):
    # Archives are digest-pinned, but paths and entry types are checked before extraction.
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                safe_member(member.filename)
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError('Build tool archives cannot contain symbolic links')
            source.extractall(destination)
    else:
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                safe_member(member.name)
                if not (member.isfile() or member.isdir()):
                    raise ValueError('Build tool archives cannot contain links or special files')
            source.extractall(destination, filter='data')


def bootstrap(cache):
    cache = Path(cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    platform = 'windows' if os.name == 'nt' else 'linux'
    if platform == 'linux' and not sys.platform.startswith('linux'):
        raise ValueError('Full release builds require Linux or Windows')
    target = cache / ('nsis-' + VERSION + '-' + platform)
    compiler = target / ('makensis.exe' if platform == 'windows' else 'bin/makensis')
    marker = target / 'spiderwatch-toolchain.json'
    identity = {'version': VERSION, 'sources': SOURCES, 'platform': platform}
    if marker.is_file() and json.loads(marker.read_text()) == json.loads(json.dumps(identity)) and compiler.is_file():
        return {'compiler': str(compiler), 'directory': str(target)}
    with tempfile.TemporaryDirectory(prefix='nsis-build-', dir=cache) as directory:
        temporary = Path(directory)
        unpack(download(cache, 'nsis-3.13.zip'), temporary)
        bundle = temporary / 'nsis-3.13'
        if platform == 'linux':
            unpack(download(cache, 'nsis-3.13-src.tar.bz2'), temporary)
            scons = temporary / 'scons'
            unpack(download(cache, 'scons-4.10.1-py3-none-any.whl'), scons)
            environment = os.environ.copy()
            environment.update(PYTHONPATH=str(scons), NSISDIR=str(bundle))
            # Official POSIX build: reuse the released Windows stubs and plugins.
            subprocess.run([sys.executable, '-m', 'SCons', '-j2',
                            'SKIPSTUBS=all', 'SKIPPLUGINS=all', 'SKIPUTILS=all',
                            'SKIPMISC=all', 'NSIS_CONFIG_CONST_DATA_PATH=no',
                            'PREFIX=' + str(bundle), 'PREFIX_BIN=' + str(bundle / 'bin'),
                            'install-compiler'],
                           cwd=temporary / 'nsis-3.13-src', env=environment,
                           stdout=sys.stderr, check=True, timeout=300)
        built = bundle / ('makensis.exe' if platform == 'windows' else 'bin/makensis')
        option = '/' if platform == 'windows' else '-'
        reported = subprocess.check_output([str(built), option + 'VERSION'], text=True).strip()
        if reported != 'v' + VERSION:
            raise ValueError('Unexpected native NSIS compiler version')
        (bundle / marker.name).write_text(json.dumps(identity))
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(bundle), target)
    return {'compiler': str(compiler), 'directory': str(target)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', required=True)
    print(json.dumps(bootstrap(parser.parse_args().cache)))
