"""Exercise the real POSIX installer detector without installing or networking."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
SHELL = os.environ.get('SPIDER_TEST_SHELL') or shutil.which('sh')
SHELL_ENV = dict(os.environ)
if os.name == 'nt' and SHELL:
    shell_directory = Path(SHELL).resolve().parent
    tool_directories = [shell_directory, shell_directory.parent / 'usr' / 'bin']
    SHELL_ENV['PATH'] = os.pathsep.join([str(path) for path in tool_directories if path.is_dir()]
                                      + [SHELL_ENV.get('PATH', '')])

@unittest.skipUnless(SHELL,'requires a POSIX shell')
class InstallerDetectionTests(unittest.TestCase):
    def detect(self, system, machine, bits=2, endian=1, features=''):
        # Shell functions shadow only the probes. The installer itself is sourced
        # unchanged and --detect exits before downloads or filesystem mutations.
        probes = r'''uname() { if [ "$1" = -s ]; then printf "%s\n" "$TEST_OS"; else printf "%s\n" "$TEST_MACHINE"; fi; }
od() { printf "127 69 76 70 %s %s\n" "$TEST_BITS" "$TEST_ENDIAN"; }
grep() { case "$*" in *vfpv3*) [ "$TEST_FEATURES" = vfpv3 ];; *vfp*) [ "$TEST_FEATURES" = vfp ];; *) return 1;; esac; }
script=$1
set -- --detect
. "$script"
'''
        env={**SHELL_ENV,'TEST_OS':system,'TEST_MACHINE':machine,'TEST_BITS':str(bits),
             'TEST_ENDIAN':str(endian),'TEST_FEATURES':features}
        return subprocess.run([SHELL,'-c',probes,'installer-test',str(SCRIPT).replace('\\','/')],env=env,text=True,capture_output=True)
    def test_cpu_abi_detection(self):
        rows=[
            ('Linux','x86_64',2,1,'','linux-amd64'),('Linux','x86_64',1,1,'','linux-386'),
            ('Linux','i686',1,1,'','linux-386'),('Linux','aarch64',2,1,'','linux-arm64'),
            ('Linux','aarch64',1,1,'','linux-armv5'),('Linux','armv7l',1,1,'','linux-armv5'),
            ('Linux','armv7l',1,1,'vfpv3','linux-armv7'),('Linux','armv6l',1,1,'vfp','linux-armv6'),
            ('Linux','mips',1,2,'','linux-mips-softfloat'),('Linux','mips',1,1,'','linux-mipsle-softfloat'),
            ('Linux','mips64',2,2,'','linux-mips64-softfloat'),('Linux','mips64',2,1,'','linux-mips64le-softfloat'),
            ('Linux','mips64',1,1,'','linux-mipsle-softfloat'),('Linux','riscv64',2,1,'','linux-riscv64'),
            ('Linux','loongarch64',2,1,'','linux-loong64'),('Linux','ppc64le',2,1,'','linux-ppc64le'),
            ('Linux','s390x',2,2,'','linux-s390x'),('Darwin','x86_64',2,1,'','darwin-amd64'),
            ('Darwin','arm64',2,1,'','darwin-arm64'),
        ]
        for *args,target in rows:
            with self.subTest(target=target,args=args):
                result=self.detect(*args)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(result.stdout.strip(),'spider-watch-'+target)
    def test_unsupported_target_is_rejected(self):
        for args in [('Linux','riscv64',1),('FreeBSD','amd64'),('Linux','unknown')]:
            self.assertNotEqual(self.detect(*args).returncode,0)

if __name__=='__main__': unittest.main()
