"""Offline tests: incomplete or conflicting drafts must never become latest."""
import copy
from pathlib import Path
import unittest
from unittest.mock import patch

from publish_github_release import GitHub, MAX_RELEASE_PAGES, RELEASES_PER_PAGE, ReleaseError, publish_release, validate_tag


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

    def get_by_id(self, release_id):
        if self.release is None or self.release["id"] != release_id:
            return None
        return copy.deepcopy(self.release)

    def create(self, tag, commit):
        self.release = {"id": 1, "tag_name": tag, "target_commitish": commit, "draft": True, "prerelease": False, "assets": []}
        return copy.deepcopy(self.release)

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
        return copy.deepcopy(self.release)


def assets():
    return {name: {"path": Path(name), "bytes": 1024, "sha256": "a" * 64} for name in [
        "spider-watch-windows-amd64.exe", "spider-watch-windows-arm64.exe", "spider-watch-windows-386.exe", "update-manifest.json", "checksums.txt"]}


class PublishTests(unittest.TestCase):
    def test_all_assets_verified_before_publication(self):
        github = FakeGitHub()
        publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertTrue(github.published)
        self.assertEqual(set(github.uploaded), set(assets()))

    def test_new_draft_is_verified_by_id_when_tag_lookup_hides_it(self):
        github = FakeGitHub()
        # Only the initial lookup may use the tag. Draft responses are obtained
        # by ID after creation and upload, as on GitHub's authenticated API.
        with patch.object(github, "get", return_value=None) as get:
            publish_release(github, "v0.4.0", COMMIT, assets())
        self.assertTrue(github.published)
        get.assert_called_once_with("v0.4.0")

    def test_disappeared_or_changed_draft_is_not_published(self):
        for complete in (None, {"id": 2, "draft": True}, {"id": 1, "draft": False},
                         {"id": 1, "draft": True, "tag_name": "v0.4.0", "target_commitish": "b" * 40}):
            with self.subTest(complete=complete):
                github = FakeGitHub()
                with patch.object(github, "get_by_id", return_value=complete):
                    with self.assertRaises(ReleaseError):
                        publish_release(github, "v0.4.0", COMMIT, assets())
                self.assertFalse(github.published)

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


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.github = GitHub("owner/SpiderWatch", "offline-test-token")
        self.draft = {"id": 42, "tag_name": "v0.7.0", "draft": True}

    def test_existing_tag_response_does_not_list_releases(self):
        with patch.object(self.github, "api", return_value=self.draft) as api:
            self.assertEqual(self.github.get("v0.7.0"), self.draft)
        api.assert_called_once_with("GET", "/releases/tags/v0.7.0", missing=True)

    def test_hidden_draft_is_found_on_later_page_by_exact_tag(self):
        first_page = [{"id": n + 100, "tag_name": f"v0.8.{n}", "draft": True} for n in range(RELEASES_PER_PAGE)]
        with patch.object(self.github, "api", side_effect=[None, first_page, [self.draft]]) as api:
            self.assertEqual(self.github.get("v0.7.0"), self.draft)
        self.assertEqual(api.call_args_list[-1].args, ("GET", f"/releases?per_page={RELEASES_PER_PAGE}&page=2"))

    def test_other_drafts_are_never_selected(self):
        with patch.object(self.github, "api", side_effect=[None, [{"id": 43, "tag_name": "v0.7.00", "draft": True}]]):
            self.assertIsNone(self.github.get("v0.7.0"))

    def test_listing_a_published_matching_tag_still_prevents_overwrite(self):
        published = {**self.draft, "draft": False}
        with patch.object(self.github, "api", side_effect=[None, [published]]):
            with self.assertRaisesRegex(ReleaseError, "already published"):
                publish_release(self.github, "v0.7.0", COMMIT, assets())

    def test_duplicate_matches_are_rejected(self):
        with patch.object(self.github, "api", side_effect=[None, [self.draft, {**self.draft, "id": 43}]]):
            with self.assertRaisesRegex(ReleaseError, "Multiple releases"):
                self.github.get("v0.7.0")

    def test_incomplete_bounded_search_does_not_allow_new_draft(self):
        page = [{"id": n + 100, "tag_name": f"v0.8.{n}", "draft": True} for n in range(RELEASES_PER_PAGE)]
        with patch.object(self.github, "api", side_effect=[None, *[page] * MAX_RELEASE_PAGES]) as api:
            with self.assertRaisesRegex(ReleaseError, "page limit"):
                self.github.get("v0.7.0")
        self.assertEqual(api.call_count, MAX_RELEASE_PAGES + 1)

    def test_release_id_lookup_uses_exact_authenticated_endpoint(self):
        with patch.object(self.github, "api", return_value=self.draft) as api:
            self.assertEqual(self.github.get_by_id(42), self.draft)
        api.assert_called_once_with("GET", "/releases/42", missing=True)
        for invalid in (True, 0, -1, "42", "42/other"):
            with self.assertRaises(ReleaseError):
                self.github.get_by_id(invalid)


if __name__ == "__main__":
    unittest.main()
