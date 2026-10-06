"""Build the same Windows installer on Linux and Windows with NSIS."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
MINIMUM_NSIS = (3, 13)


def compiler_path(explicit=None):
    if explicit:
        return explicit
    if os.environ.get('MAKENSIS'):
        return os.environ['MAKENSIS']
    found = shutil.which('makensis')
    if found:
        return found
    if os.name == 'nt':
        for variable in ('ProgramFiles(x86)', 'ProgramFiles'):
            base = os.environ.get(variable)
            if base and (Path(base) / 'NSIS/makensis.exe').is_file():
                return str(Path(base) / 'NSIS/makensis.exe')
    raise ValueError('NSIS 3.13 or newer is required; set MAKENSIS to its compiler path')


def build(version, arch, directory, compiler=None):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('Invalid installer version')
    if arch not in ('amd64', 'arm64', '386'):
        raise ValueError('Unsupported installer architecture')
    directory = Path(directory).resolve()
    if any(character in str(directory) for character in '$"\r\n'):
        raise ValueError('Installer build path contains unsupported characters')
    binary = directory / f'spider-watch-windows-{arch}.exe'
    if not binary.is_file() or binary.stat().st_size < 1024:
        raise ValueError('Build the Windows client before its installer')
    compiler = compiler_path(compiler)
    option = '/' if os.name == 'nt' else '-'
    reported = subprocess.check_output([compiler, option + 'VERSION'], text=True).strip()
    match = re.fullmatch(r'v(\d+)\.(\d+)(?:\..*)?(?:-[\w.]+)?', reported)
    if not match or tuple(map(int, match.groups())) < MINIMUM_NSIS:
        raise ValueError('NSIS 3.13 or newer is required for current installer security fixes')
    output = directory / f'spider-watch-windows-{arch}-setup.exe'
    subprocess.run([compiler, option + 'NOCONFIG', option + 'WX', option + 'V3',
                    option + 'INPUTCHARSET', 'UTF8',
                    option + 'DVersion=' + version, option + 'DArch=' + arch,
                    option + 'DBinaryFile=' + str(binary), option + 'DOutputFile=' + str(output),
                    str(ROOT / 'setup.nsi')], check=True)
    if not output.is_file() or not 1024 <= output.stat().st_size <= 25 * 1024 * 1024:
        raise ValueError('Windows installer is missing or exceeds the Static Assets size limit')
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--arch', required=True, choices=('amd64', 'arm64', '386'))
    parser.add_argument('--build-dir', type=Path, default=ROOT.parents[1] / 'dist')
    parser.add_argument('--compiler')
    args = parser.parse_args()
    print(build(args.version, args.arch, args.build_dir, args.compiler))


if __name__ == '__main__':
    main()
