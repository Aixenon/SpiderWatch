"""Publish a complete immutable GitHub release; retry only unfinished drafts.

Used only by the trusted tag workflow. GH_TOKEN stays in the environment. The
Worker and agents never call this script or trigger builds during downloads.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.error import HTTPError

TAG = re.compile(r"^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$")
REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
MAX_BINARY = 16 * 1024 * 1024
PLATFORMS = json.loads((Path(__file__).resolve().parents[1] / "internal/agent/platforms.json").read_text())
TARGETS = {(p["os"], p["arch"]) for p in PLATFORMS}


class ReleaseError(ValueError):
    pass


def validate_tag(tag):
    if not isinstance(tag, str) or not TAG.fullmatch(tag):
        raise ReleaseError("Release tags must be stable vX.Y.Z, without prerelease or leading zeroes")
    return tag[1:]


def file_hash(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def local_assets(directory, tag):
    version = validate_tag(tag)
    manifest_path = directory / "update-manifest.json"
    if manifest_path.stat().st_size > 64 * 1024:
        raise ReleaseError("Manifest exceeds 64 KiB")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("schema") != 1 or manifest.get("version") != version or len(manifest.get("assets", [])) != len(TARGETS):
        raise ReleaseError("Manifest schema, version or architecture count is invalid")
    result, seen = {}, set()
    for asset in manifest["assets"]:
        arch = asset.get("arch")
        target = (asset.get("os"), arch)
        name = f"spider-watch-{target[0]}-{arch}" + (".exe" if target[0] == "windows" else "")
        if target not in TARGETS or target in seen or asset.get("file") != name:
            raise ReleaseError("Invalid or duplicate release architecture")
        seen.add(target)
        path = directory / name
        size, digest = asset.get("bytes"), asset.get("sha256")
        if type(size) is not int or not 1024 <= size <= MAX_BINARY or not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ReleaseError("Invalid binary length or digest")
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size or file_hash(path) != digest:
            raise ReleaseError("Local binary differs from its manifest")
        result[name] = {"path": path, "bytes": size, "sha256": digest}
    checksums = directory / "checksums.txt"
    if checksums.stat().st_size > 16384:
        raise ReleaseError("Checksum list exceeds its limit")
    parsed = {}
    for line in checksums.read_text(encoding="utf-8-sig").splitlines():
        digest, name = line.split(maxsplit=1)
        if name in parsed:
            raise ReleaseError("Duplicate checksum entry")
        parsed[name] = digest
    for name in ["install.sh", "install.ps1", *[f"spider-watch-windows-{arch}-setup.exe" for arch in ["amd64","arm64","386"]]]:
        path=directory/name
        limit=32*1024*1024 if name.endswith('.exe') else 64*1024
        if path.is_symlink() or not path.is_file() or not 1<=path.stat().st_size<=limit:
            raise ReleaseError("Missing or invalid release installer")
        result[name]={"path":path,"bytes":path.stat().st_size,"sha256":file_hash(path)}
    if parsed != {name: asset["sha256"] for name, asset in result.items()}:
        raise ReleaseError("checksums.txt does not match all release files")
    info_path=directory/"release-info.json"
    info=json.loads(info_path.read_text())
    if info.get("repository")!=os.environ.get("GITHUB_REPOSITORY") or info.get("version")!=version:
        raise ReleaseError("Release ownership or version mismatch")
    for name in ["install.sh","install.ps1"]:
        content=(directory/name).read_text()
        if "__SPIDER_" in content or info["repository"] not in content or tag not in content:
            raise ReleaseError("Installer does not point to this release")
    for path in (manifest_path, checksums, info_path):
        if path.is_symlink() or not path.is_file():
            raise ReleaseError("Release metadata must be regular files")
        result[path.name] = {"path": path, "bytes": path.stat().st_size, "sha256": file_hash(path)}
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError("GitHub API redirect refused")


class GitHub:
    def __init__(self, repository, token):
        if not REPO.fullmatch(repository) or not token:
            raise ReleaseError("GITHUB_REPOSITORY and GH_TOKEN must be provided by the trusted workflow")
        self.repository, self.token = repository, token
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def api(self, method, path, body=None, missing=False):
        data = json.dumps(body).encode() if body is not None else None
        request = Request("https://api.github.com/repos/" + self.repository + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "cf-monitor-draft-publisher",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with self.opener.open(request, timeout=30) as response:
                content = response.read(1024 * 1024 + 1)
                if len(content) > 1024 * 1024:
                    raise ReleaseError("GitHub metadata exceeds its size limit")
                return json.loads(content)
        except HTTPError as error:
            if error.code == 404 and missing:
                return None
            raise ReleaseError(f"GitHub API rejected release operation (HTTP {error.code})") from None

    def get(self, tag):
        return self.api("GET", "/releases/tags/" + quote(tag, safe=""), missing=True)

    def create(self, tag, commit):
        return self.api("POST", "/releases", {"tag_name": tag, "target_commitish": commit, "name": tag, "draft": True, "prerelease": False, "generate_release_notes": True, "body": self.install_instructions(tag)})

    def install_instructions(self, tag):
        base=f"https://github.com/{self.repository}/releases/download/{tag}"
        return ("## Install SpiderWatch\n\nLinux / macOS:\n```sh\n"
                f"curl -fsSL --proto '=https' {base}/install.sh -o install-spider-watch.sh\n"
                "sudo sh install-spider-watch.sh\n```\n\nWindows: download the `windows-ARCH-setup.exe` installer below, or run:\n```powershell\n"
                f"curl.exe -fLsS --proto '=https' {base}/install.ps1 -o install-spider-watch.ps1\n"
                "powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-spider-watch.ps1\n```\n\n"
                "Then copy the registration command from your panel. Linux/macOS: run it with sudo; Windows: use a new Administrator terminal.\n")

    def upload(self, tag, asset):
        # gh inherits GH_TOKEN; no --clobber: an existing asset is immutable.
        result = subprocess.run(["gh", "release", "upload", tag, str(asset["path"]), "--repo", self.repository], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if result.returncode:
            raise ReleaseError("Draft asset upload failed; rerun the same tag to resume without replacing files")

    def verify_asset(self, remote, local):
        if remote.get("state") != "uploaded" or remote.get("size") != local["bytes"]:
            raise ReleaseError("Remote draft asset is not completely uploaded")
        digest = remote.get("digest")
        if digest is not None:
            if digest != "sha256:" + local["sha256"]:
                raise ReleaseError("Existing remote asset content differs; published versions cannot be overwritten")
            return
        # Some GitHub installations omit digest. Verify the full authenticated
        # draft download instead of publishing unverifiable metadata.
        asset_id = remote.get("id")
        if type(asset_id) is not int or asset_id <= 0:
            raise ReleaseError("Remote draft asset has no valid identifier")
        with tempfile.TemporaryFile() as downloaded:
            result = subprocess.run(["gh", "api", f"repos/{self.repository}/releases/assets/{asset_id}", "-H", "Accept: application/octet-stream"], stdout=downloaded, stderr=subprocess.PIPE)
            if result.returncode or downloaded.tell() != local["bytes"]:
                raise ReleaseError("Cannot verify uploaded draft asset")
            downloaded.seek(0)
            if hashlib.file_digest(downloaded, "sha256").hexdigest() != local["sha256"]:
                raise ReleaseError("Uploaded draft digest differs from local release")

    def publish(self, release_id):
        return self.api("PATCH", f"/releases/{release_id}", {"draft": False, "prerelease": False, "make_latest": "true"})


def verify_release_metadata(release, tag, commit, locals):
    if release.get("tag_name") != tag or release.get("prerelease") or release.get("target_commitish") != commit:
        raise ReleaseError("Existing draft does not match this stable tag and exact commit")
    remote = {}
    for asset in release.get("assets", []):
        name = asset.get("name")
        if name not in locals or name in remote:
            raise ReleaseError("Release has unexpected or duplicate assets; review it manually")
        remote[name] = asset
    return remote


def publish_release(github, tag, commit, assets):
    existing = github.get(tag)
    if existing is not None and not existing.get("draft"):
        raise ReleaseError("This tag is already published; bump the version instead of overwriting it")
    release = existing if existing is not None else github.create(tag, commit)
    remote = verify_release_metadata(release, tag, commit, assets)
    # Validate any surviving partial upload before adding missing files. Existing
    # mismatched assets are never deleted or replaced, including on draft retries.
    for name, uploaded in remote.items():
        github.verify_asset(uploaded, assets[name])
    for name, asset in assets.items():
        if name not in remote:
            github.upload(tag, asset)
    complete = github.get(tag)
    if not complete or not complete.get("draft") or complete.get("id") != release.get("id"):
        raise ReleaseError("Draft changed during publication; release not published")
    remote = verify_release_metadata(complete, tag, commit, assets)
    if set(remote) != set(assets):
        raise ReleaseError("Draft is incomplete; release not published")
    for name, asset in assets.items():
        github.verify_asset(remote[name], asset)
    published = github.publish(complete["id"])
    if published.get("draft") or published.get("tag_name") != tag:
        raise ReleaseError("GitHub did not confirm release publication")
    return published


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate-tag")
    parser.add_argument("--tag")
    parser.add_argument("--directory", type=Path, default=Path("client/dist"))
    args = parser.parse_args()
    try:
        if args.validate_tag:
            print(validate_tag(args.validate_tag))
            return 0
        assets = local_assets(args.directory, args.tag)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        tag_commit = subprocess.run(["git", "rev-parse", args.tag + "^{commit}"], capture_output=True, text=True, check=True).stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{40,64}", commit) or commit != tag_commit:
            raise ReleaseError("Checked-out code differs from the release tag")
        github = GitHub(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GH_TOKEN", ""))
        publish_release(github, args.tag, commit, assets)
        print(json.dumps({"published": True, "tag": args.tag, "assets": len(assets)}))
        return 0
    except (ReleaseError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, ReleaseError) else "Release publication failed; no credential-bearing response was logged", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
