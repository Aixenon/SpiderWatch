import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import bootstrap_nsis as bootstrap


class BootstrapTests(unittest.TestCase):
    def test_pinned_download_is_reused_only_when_digest_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            payload = b'validated compiler archive'
            source = ('https://example.invalid/tool.zip', len(payload), hashlib.sha256(payload).hexdigest())
            (cache / 'tool.zip').write_bytes(b'corrupt cached tool')
            opener = unittest.mock.Mock()
            opener.open.return_value = io.BytesIO(payload)
            with patch.dict(bootstrap.SOURCES, {'tool.zip': source}), patch.object(bootstrap.urllib.request, 'build_opener', return_value=opener):
                self.assertEqual(bootstrap.download(cache, 'tool.zip').read_bytes(), payload)
                bootstrap.download(cache, 'tool.zip')
                self.assertEqual(opener.open.call_count, 1)

    def test_mismatched_or_oversized_download_is_never_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            for data in [b'bad', b'too large']:
                opener = unittest.mock.Mock()
                opener.open.return_value = io.BytesIO(data)
                with patch.dict(bootstrap.SOURCES, {'tool.zip': ('https://example.invalid/tool.zip', 3, 'a' * 64)}), patch.object(bootstrap.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaises(ValueError):
                        bootstrap.download(cache, 'tool.zip')
                self.assertEqual(list(cache.iterdir()), [])

    def test_archive_traversal_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'unsafe.zip'
            with zipfile.ZipFile(archive, 'w') as source:
                source.writestr('../outside.txt', 'bad')
            with self.assertRaises(ValueError):
                bootstrap.unpack(archive, root / 'output')
            archive = root / 'unsafe.tar.bz2'
            with tarfile.open(archive, 'w:bz2') as source:
                member = tarfile.TarInfo('link')
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                source.addfile(member)
            with self.assertRaises(ValueError):
                bootstrap.unpack(archive, root / 'output')
            self.assertFalse((root / 'output').exists())

    def test_insecure_redirect_is_rejected(self):
        with self.assertRaises(ValueError):
            bootstrap.HTTPSRedirect().redirect_request(None, None, 302, '', {}, 'http://example.invalid/tool.zip')


if __name__ == '__main__':
    unittest.main()
