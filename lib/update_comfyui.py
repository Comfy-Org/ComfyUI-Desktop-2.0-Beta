"""
Launcher-owned ComfyUI updater using pygit2.

Performs git operations only — no pip/uv installs, no self-update logic.
The launcher handles requirements sync separately.

Usage: python update_comfyui.py <repo_path> [--stable]

Outputs structured markers that the launcher can parse:
  [BACKUP_BRANCH] <name>
  [PRE_UPDATE_HEAD] <sha>
  [POST_UPDATE_HEAD] <sha>
  [CHECKED_OUT_TAG] <tag>
"""

import os
import re
import pygit2
from datetime import datetime
import sys


def harden_pygit2_config():
    """Ignore system/global/XDG git config for libgit2 operations.

    The launcher manages anonymous HTTPS clones of public repos. A user's
    global git config can carry `insteadOf` rewrites (e.g. https->ssh) or
    credential helpers that force authentication, which libgit2 cannot
    satisfy without a credentials callback ("authentication required but no
    callback set"). Blanking the config search path keeps our operations
    hermetic. We supply our own commit Signature, so dropping global
    user.name/email has no effect here.
    """
    try:
        from pygit2.enums import ConfigLevel
        levels = [ConfigLevel.SYSTEM, ConfigLevel.XDG, ConfigLevel.GLOBAL]
    except (ImportError, AttributeError):
        levels = [
            pygit2.GIT_CONFIG_LEVEL_SYSTEM,
            pygit2.GIT_CONFIG_LEVEL_XDG,
            pygit2.GIT_CONFIG_LEVEL_GLOBAL,
        ]
    for level in levels:
        try:
            pygit2.settings.search_path[level] = ""
        except Exception:
            pass


def to_https_url(url):
    """Rewrite an SSH-form git URL to its anonymous HTTPS equivalent.

    Handles `git@host:owner/repo(.git)` and `ssh://git@host/owner/repo(.git)`.
    Returns the URL unchanged if it is not SSH-form. Used so launcher-managed
    clones of public repos never require SSH credentials even when a repo's
    own config stores an SSH origin (e.g. a legacy-desktop clone).
    """
    if not url:
        return url
    m = re.match(r"^(?:ssh://)?git@([^:/]+)[:/](.+)$", url)
    if m:
        return "https://%s/%s" % (m.group(1), m.group(2))
    return url


def find_latest_stable_tag(repo):
    versions = []
    for ref_name in repo.references:
        prefix = "refs/tags/v"
        if ref_name.startswith(prefix):
            try:
                parts = tuple(map(int, ref_name[len(prefix):].split(".")))
                versions.append((parts, ref_name))
            except (ValueError, IndexError):
                pass
    versions.sort()
    return versions[-1][1] if versions else None


def main():
    if len(sys.argv) < 2:
        print("Usage: python update_comfyui.py <repo_path> [--stable]")
        sys.exit(1)

    repo_path = os.path.abspath(sys.argv[1].rstrip("/\\"))
    stable = "--stable" in sys.argv

    pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION, 0)
    harden_pygit2_config()

    git_dir = os.path.join(repo_path, '.git')

    # Ensure required .git subdirectories exist — archive extraction
    # can drop empty directories (e.g. refs/) which libgit2 requires.
    for sub in ['refs/heads', 'refs/tags', 'refs/remotes']:
        os.makedirs(os.path.join(git_dir, sub), exist_ok=True)
    repo = None
    errors = []
    for candidate in [git_dir, repo_path]:
        try:
            repo = pygit2.Repository(candidate)
            break
        except Exception as e:
            errors.append("  %s -> %s" % (candidate, e))
    if repo is None:
        # Last resort: forward-slash path (libgit2 sometimes prefers it)
        try:
            repo = pygit2.Repository(git_dir.replace("\\", "/"))
        except Exception as e:
            errors.append("  %s -> %s" % (git_dir.replace("\\", "/"), e))
    if repo is None:
        print("Error: could not open git repository at %s" % repo_path)
        for err in errors:
            print(err)
        print(".git contents: %s" % os.listdir(git_dir))
        sys.exit(1)

    # Emit pre-update HEAD
    pre_head = str(repo.head.target)
    print("[PRE_UPDATE_HEAD] %s" % pre_head)

    # Clean any leftover merge/rebase state from a previous failed update
    repo.state_cleanup()

    # Create backup branch so local modifications can be recovered manually.
    # If there are uncommitted changes in the working tree, commit them onto
    # the backup branch so they are not lost when the hard reset runs.
    backup_name = "backup_branch_%s" % datetime.today().strftime("%Y-%m-%d_%H_%M_%S")
    print("Creating backup branch: %s" % backup_name)
    try:
        repo.branches.local.create(backup_name, repo.head.peel())
        print("[BACKUP_BRANCH] %s" % backup_name)
        repo.index.add_all()
        repo.index.write()
        if repo.index.diff_to_tree(repo.head.peel().tree):
            tree = repo.index.write_tree()
            ident = pygit2.Signature("comfyui", "comfy@ui")
            backup_ref = "refs/heads/%s" % backup_name
            repo.create_commit(
                backup_ref, ident, ident,
                "Backup of uncommitted changes before update",
                tree, [repo.head.target],
            )
            print("Uncommitted changes saved to backup branch.")
    except Exception:
        print("Warning: could not create backup branch.")

    # Fetch master from origin (handles shallow/single-branch clones)
    print("Fetching from origin…")
    for remote in repo.remotes:
        if remote.name == "origin":
            # Force anonymous HTTPS so a stored SSH origin can't demand creds.
            https_url = to_https_url(remote.url)
            if https_url != remote.url:
                repo.remotes.set_url("origin", https_url)
                remote = repo.remotes["origin"]
            refspecs = [
                "+refs/heads/master:refs/remotes/origin/master",
                "+refs/tags/*:refs/tags/*",
            ]
            try:
                remote.fetch(refspecs)
            except Exception as e:
                print("[ERROR] Failed to fetch from origin: %s" % e)
                if "callback" in str(e) or "authentication" in str(e).lower():
                    print("Git authentication was required for an anonymous "
                          "fetch. This usually means your git config rewrites "
                          "GitHub HTTPS URLs to SSH; the updater fetches over "
                          "anonymous HTTPS and cannot use SSH credentials.")
                else:
                    print("Check your internet connection and try again.")
                sys.exit(1)
            break

    # Hard-reset master to origin/master.
    # Launcher-managed installations should not have local modifications to
    # tracked files. Using a hard reset instead of merge/stash avoids merge
    # conflicts and stash-pop conflict markers that can corrupt working-tree
    # files (see issue #245).
    print("Resetting to origin/master…")
    remote_ref = repo.lookup_reference("refs/remotes/origin/master")
    remote_id = remote_ref.target
    branch = repo.lookup_branch("master")
    if branch is None:
        repo.create_branch("master", repo.get(remote_id))
    else:
        branch.set_target(remote_id)
    ref = repo.lookup_reference("refs/heads/master")
    repo.checkout(ref, strategy=pygit2.GIT_CHECKOUT_FORCE)
    repo.reset(remote_id, pygit2.GIT_RESET_HARD)

    # Checkout stable tag if requested
    if stable:
        tag = find_latest_stable_tag(repo)
        if tag is not None:
            print("Checking out stable tag: %s" % tag)
            repo.checkout(tag)
            tag_name = tag.replace("refs/tags/", "")
            print("[CHECKED_OUT_TAG] %s" % tag_name)
        else:
            print("No stable tags found, staying on master.")

    # Emit post-update HEAD
    post_head = str(repo.head.target)
    print("[POST_UPDATE_HEAD] %s" % post_head)

    print("Done!")


if __name__ == "__main__":
    main()
