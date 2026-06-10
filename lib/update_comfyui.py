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
import subprocess
import pygit2
from datetime import datetime
import sys


def is_auth_error(exc):
    """True when an exception message looks like an auth/transport failure
    that the bundled (SSH-less) pygit2 can't satisfy but system git could."""
    msg = str(exc).lower()
    return (
        "authentication" in msg
        or "callback" in msg
        or "unsupported url protocol" in msg
        or "credential" in msg
    )


def system_git_available():
    """True if a usable system `git` binary is on PATH."""
    try:
        subprocess.run(
            ["git", "--version"], capture_output=True, timeout=10
        )
        return True
    except Exception:
        return False


def system_git_fetch(repo_path, refspecs):
    """Fetch from origin using system git, which honors the user's full git
    config (proxy, insteadOf, ssh keys, credential helpers). Returns True on
    success. `-c safe.directory=*` mirrors pygit2's disabled owner validation
    so launcher-managed repos owned by another user still work."""
    try:
        result = subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", repo_path,
             "fetch", "origin"] + list(refspecs),
            capture_output=True, timeout=900, text=True,
        )
        if result.stdout:
            print(result.stdout)
        if result.stderr:
            print(result.stderr)
        return result.returncode == 0
    except Exception as ex:
        print("System git fetch error: %s" % ex)
        return False


def read_global_http_proxy():
    """Return the user's global `http.proxy` setting, or None.

    Read before the config search path is blanked so corporate proxy
    settings survive and can be passed explicitly to fetch/clone.
    """
    try:
        cfg = pygit2.Config.get_global_config()
    except Exception:
        return None
    try:
        value = cfg["http.proxy"]
    except (KeyError, Exception):
        return None
    return value or None


def harden_pygit2_config():
    """Ignore system/global/XDG git config for libgit2 operations.

    The launcher manages anonymous HTTPS clones of public repos. A user's
    global git config can carry `insteadOf` rewrites (e.g. https->ssh) or
    credential helpers that force authentication, which libgit2 cannot
    satisfy without a credentials callback ("authentication required but no
    callback set"). The bundled pygit2 has no SSH transport, so an SSH
    rewrite can never succeed; blanking the config search path keeps our
    operations on anonymous HTTPS. We supply our own commit Signature, so
    dropping global user.name/email has no effect here.

    Returns the snapshotted `http.proxy` value (or None) so corporate proxy
    config is preserved and re-applied explicitly on fetch/clone.
    """
    proxy = read_global_http_proxy()
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
    return proxy


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
    http_proxy = harden_pygit2_config()

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

    # Fetch master + tags from origin (handles shallow/single-branch clones).
    print("Fetching from origin...")
    refspecs = [
        "+refs/heads/master:refs/remotes/origin/master",
        "+refs/tags/*:refs/tags/*",
    ]
    origin = None
    for remote in repo.remotes:
        if remote.name == "origin":
            origin = remote
            break
    if origin is not None:
        force_pygit2 = os.environ.get("COMFY_FORCE_PYGIT2") == "1"
        try:
            origin.fetch(refspecs, proxy=http_proxy or None)
        except Exception as e:
            print("[WARN] pygit2 fetch from origin failed: %s" % e)
            # The bundled pygit2 has no SSH transport, so a git config that
            # rewrites GitHub HTTPS to SSH (insteadOf) fails here. Retry with
            # system git, which honors the user's full config. Skipped when
            # COMFY_FORCE_PYGIT2=1 (developers exercising the pygit2 path).
            if (not force_pygit2 and is_auth_error(e)
                    and system_git_available()):
                print("Retrying fetch with system git (honors your git config)...")
                if not system_git_fetch(repo_path, refspecs):
                    print("[ERROR] Failed to fetch from origin.")
                    print("Check your internet connection and try again.")
                    sys.exit(1)
                print("System git fetch succeeded.")
            else:
                print("[ERROR] Failed to fetch from origin: %s" % e)
                if is_auth_error(e):
                    print("Git authentication was required for an anonymous "
                          "fetch. This usually means your git config rewrites "
                          "GitHub HTTPS URLs to SSH; the bundled updater "
                          "fetches over anonymous HTTPS and cannot use SSH "
                          "credentials.")
                else:
                    print("Check your internet connection and try again.")
                sys.exit(1)

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
