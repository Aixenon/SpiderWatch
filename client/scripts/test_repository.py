import os
import unittest
from unittest.mock import patch
from repository import resolve_repository

class RepositoryTests(unittest.TestCase):
    def test_fork_owner_is_authoritative(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY':'fork-owner/my-monitor'}):
            self.assertEqual(resolve_repository(),'fork-owner/my-monitor')
    def test_recognizes_https_and_ssh(self):
        for remote in ['https://github.com/my-team/watch.git','git@github.com:my-team/watch.git','ssh://git@github.com/my-team/watch.git']:
            with patch.dict(os.environ,{},clear=True),patch('repository.subprocess.run') as run:
                run.return_value.stdout=remote
                self.assertEqual(resolve_repository(),'my-team/watch')
    def test_unknown_or_malicious_origin_fails_closed(self):
        for remote in ['https://gitlab.com/a/b','https://github.com/a/b/../../c','https://github.com/a/b?token=secret','']:
            with patch.dict(os.environ,{},clear=True),patch('repository.subprocess.run') as run:
                run.return_value.stdout=remote
                with self.assertRaises(ValueError): resolve_repository()

if __name__=='__main__': unittest.main()
