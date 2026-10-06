"""Offline tests: incomplete or conflicting drafts must never become latest."""
import copy
from pathlib import Path
import unittest

from publish_github_release import ReleaseError, publish_release, validate_tag


COMMIT = "a" * 40


class FakeGitHub:
    def __init__(self, release=None, fail_upload=None, wrong_digest=None):
        self.release = release
        self.fail_upload = fail_upload
        self.wrong_digest = wrong_digest
        self.uploaded = []
        self.published = False

    def get(self, tag):
        return copy.deepcopy(self.release)

    def create(self, tag, commit):
        self.release = {"id": 1, "tag_name": tag, "target_commitish": commit, "draft": True, "prerelease": False, "assets": []}
        return self.get(tag)

    def upload(self, tag, asset):
        name = asset["path"].name
        if self.fail_upload == name:
            raise ReleaseError("simulated failed upload")
        self.uploaded.append(name)
        self.release["assets"].append({"name": name, "size": asset["bytes"], "state": "uploaded", "digest": "sha256:" + ("b" * 64 if name == self.wrong_digest else asset["sha256"])})

    def verify_asset(self, remote, local):
        if remote["digest"] != "sha256:" + local["sha256"] or remote["size"] != local["bytes"]:
            raise ReleaseError("simulated digest mismatch")

    def publish(self, release_id):
        self.published = True
        self.release["draft"] = False
        return self.get(self.release["tag_name"])


def assets():
    return {name: {"path": Path(name), "bytes": 1024, "sha256": "a" * 64} for name in [
        "spider-watch-windows-amd64.exe", "spider-watch-windows-arm64.exe", "spider-watch-windows-386.exe", "update-manifest.json", "checksums.txt"]}


class PublishTests(unittest.TestCase):
    def test_all_assets_verified_before_publication(self):
        github = FakeGitHub()
        publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertTrue(github.published)
        self.assertEqual(set(github.uploaded), set(assets()))

    def test_failed_upload_stays_draft_and_retry_only_uploads_missing_files(self):
        github = FakeGitHub(fail_upload="update-manifest.json")
        with self.assertRaises(ReleaseError):
            publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertFalse(github.published)
        self.assertTrue(github.release["draft"])
        self.assertEqual(len(github.uploaded), 3)
        github.fail_upload = None
        publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertTrue(github.published)
        self.assertEqual(len(github.uploaded), 5)

    def test_remote_digest_mismatch_never_publishes(self):
        github = FakeGitHub(wrong_digest="update-manifest.json")
        with self.assertRaises(ReleaseError):
            publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertFalse(github.published)
        self.assertTrue(github.release["draft"])

    def test_published_version_is_never_overwritten(self):
        github = FakeGitHub()
        publish_release(github, "v0.4.0", COMMIT, assets())
        github.uploaded.clear()
        with self.assertRaises(ReleaseError):
            publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertFalse(github.uploaded)

    def test_draft_from_other_commit_or_with_unknown_asset_is_not_resumed(self):
        for tamper in ("commit", "unknown-file"):
            github = FakeGitHub()
            github.create("v0.4.0", COMMIT)
            if tamper == "commit":
                github.release["target_commitish"] = "b" * 40
            else:
                github.release["assets"] = [{"name": "surprise.exe"}]
            with self.assertRaises(ReleaseError):
                publish_release(github, "v0.4.0", COMMIT, assets())
            self.assertFalse(github.uploaded)
            self.assertFalse(github.published)

    def test_only_stable_version_tags_are_accepted(self):
        self.assertEqual(validate_tag("v0.4.0"), "0.4.0")
        for tag in ("v0.4.0-rc1", "v01.2.3", "0.4.0", "v1.2", "v1.2.3;echo unsafe"):
            with self.assertRaises(ReleaseError):
                validate_tag(tag)


if __name__ == "__main__":
    unittest.main()
