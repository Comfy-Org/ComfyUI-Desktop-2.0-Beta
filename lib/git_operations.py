"""
pygit2-based git operations for Comfy Desktop Launcher.

Provides git subcommands for standalone installs where system git is not
available.  Each subcommand prints structured output that the TypeScript
caller (src/main/lib/git.ts) can parse.

Usage: python git_operations.py <subcommand> <repo_path> [args...]

Subcommands:
  healthcheck
  rev-parse          <repo_path> <ref>
  describe-tags      <repo_path> [commit]
  tag-list           <repo_path>
  rev-list-count     <repo_path> <tag_or_ref> [commit]
  cherry-pick-count  <repo_path> <ref1> <ref2>
  merge-base         <repo_path> <ref1> <ref2>
  is-ancestor        <repo_path> <ancestor> <descendant>
  fetch-tags         <repo_path>
  fetch-commit       <repo_path> <sha>
  clone              <url> <dest>
  checkout           <repo_path> <commit>
  fetch-and-checkout <repo_path> <commit>
  ls-remote-tags     <url>
  ls-remote-ref      <url> <ref>
"""

import os
import re
import sys
import time
from collections import deque

import pygit2

from pygit2_compat import harden_pygit2_config


# ---------------------------------------------------------------------------
# pygit2 API compatibility shims
# ---------------------------------------------------------------------------
#
# pygit2 1.15+ moved the legacy module-level constants (`pygit2.GIT_OBJ_*`,
# `pygit2.GIT_SORT_*`, etc.) onto the typed `pygit2.enums` module, and 1.19
# removed `GIT_OBJ_COMMIT` entirely.  Recent standalone-env builds ship
# pygit2 1.19+ which means any code path that still references the old
# constant crashes with `AttributeError: module 'pygit2' has no attribute
# 'GIT_OBJ_COMMIT'` — silently breaking version resolution and causing the
# launcher to overwrite good `comfyVersion.baseTag` with bare commit SHAs.
#
# Resolve once at import-time, preferring the new enum API but falling
# back to the legacy attribute when running against an older pygit2.

try:
    from pygit2.enums import ObjectType as _ObjectType
    GIT_OBJ_COMMIT = int(_ObjectType.COMMIT)
except (ImportError, AttributeError):
    GIT_OBJ_COMMIT = pygit2.GIT_OBJ_COMMIT  # pre-1.15

try:
    from pygit2.enums import SortMode as _SortMode
    GIT_SORT_TOPOLOGICAL = int(_SortMode.TOPOLOGICAL)
except (ImportError, AttributeError):
    GIT_SORT_TOPOLOGICAL = pygit2.GIT_SORT_TOPOLOGICAL  # pre-1.15


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Snapshot of the user's global `http.proxy` (captured before the config
# search path is blanked) so corporate proxy settings survive and can be
# passed explicitly to fetch/clone. None means "no proxy".
HTTP_PROXY = None


def to_https_url(url):
    """Rewrite an SSH-form git URL to its anonymous HTTPS equivalent.

    Handles `git@host:owner/repo(.git)` and `ssh://git@host/owner/repo(.git)`.
    Returns the URL unchanged if it is not SSH-form, so launcher-managed
    clones of public repos never require SSH credentials even when a repo's
    own config stores an SSH origin.
    """
    if not url:
        return url
    m = re.match(r"^(?:ssh://)?git@([^:/]+)[:/](.+)$", url)
    if m:
        return "https://%s/%s" % (m.group(1), m.group(2))
    return url


def open_repo(repo_path):
    """Open a pygit2 Repository, mirroring update_comfyui.py patterns."""
    repo_path = os.path.abspath(repo_path.rstrip("/\\"))
    git_dir = os.path.join(repo_path, ".git")

    # Ensure required .git subdirectories exist (archive extraction can
    # drop empty directories that libgit2 requires).
    for sub in ["refs/heads", "refs/tags", "refs/remotes"]:
        try:
            os.makedirs(os.path.join(git_dir, sub), exist_ok=True)
        except OSError:
            pass

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
        print("Error: could not open git repository at %s" % repo_path, file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        sys.exit(1)

    return repo


def resolve_ref(repo, ref):
    """Resolve a ref string (tag name, branch, SHA prefix, HEAD) to an Oid."""
    if ref == "HEAD":
        return repo.head.target

    # Try refs/tags/<ref> (annotated or lightweight)
    try:
        tag_ref = repo.lookup_reference("refs/tags/%s" % ref)
        obj = tag_ref.peel(pygit2.Commit)
        return obj.id
    except (KeyError, ValueError):
        pass

    # Try refs/heads/<ref>
    try:
        branch_ref = repo.lookup_reference("refs/heads/%s" % ref)
        return branch_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try refs/remotes/origin/<ref>
    try:
        remote_ref = repo.lookup_reference("refs/remotes/origin/%s" % ref)
        return remote_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try as a full reference name
    try:
        full_ref = repo.lookup_reference(ref)
        return full_ref.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        pass

    # Try as a SHA or abbreviated SHA
    try:
        obj = repo.revparse_single(ref)
        commit = obj.peel(pygit2.Commit)
        return commit.id
    except (KeyError, ValueError):
        pass

    print("Error: could not resolve ref '%s'" % ref, file=sys.stderr)
    sys.exit(1)


def parse_version_tuple(tag_name):
    """Parse a 'vX.Y.Z' tag name into a comparable tuple, or None."""
    name = tag_name
    if name.startswith("v"):
        name = name[1:]
    try:
        return tuple(int(x) for x in name.split("."))
    except (ValueError, IndexError):
        return None


def get_origin(repo):
    """Return the 'origin' remote, or exit with an error.

    A stored SSH origin is left untouched: the bundled pygit2 has no SSH
    transport, so such a fetch fails with an auth error, and the TypeScript
    caller (git.ts) retries the whole operation via system git, which honors
    the user's full git config. We deliberately do not rewrite the remote URL
    on disk.
    """
    for remote in repo.remotes:
        if remote.name == "origin":
            return remote
    print("Error: no 'origin' remote found", file=sys.stderr)
    sys.exit(1)


def build_tag_target_map(repo):
    """Build a dict mapping commit Oid -> tag name for all tags."""
    tag_map = {}
    for ref_name in repo.references:
        if ref_name.startswith("refs/tags/"):
            tag_name = ref_name[len("refs/tags/"):]
            try:
                ref = repo.lookup_reference(ref_name)
                target = ref.peel(pygit2.Commit)
                tag_map[target.id] = tag_name
            except (KeyError, ValueError):
                pass
    return tag_map


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

def cmd_rev_parse(repo_path, ref):
    """Resolve a ref to its SHA. Print the SHA on stdout."""
    repo = open_repo(repo_path)
    oid = resolve_ref(repo, ref)
    print(str(oid))


def cmd_describe_tags(repo_path, commit="HEAD"):
    """Find the nearest ancestor tag (like git describe --tags --abbrev=0).

    Walks ancestors breadth-first, checking each commit against all tag
    targets. Prints the tag name on stdout, or exits 1 if no tags found.
    """
    repo = open_repo(repo_path)
    start_oid = resolve_ref(repo, commit)
    tag_map = build_tag_target_map(repo)

    if not tag_map:
        print("Error: no tags found in repository", file=sys.stderr)
        sys.exit(1)

    # BFS over ancestors
    visited = set()
    queue = deque([start_oid])
    while queue:
        oid = queue.popleft()
        if oid in visited:
            continue
        visited.add(oid)

        if oid in tag_map:
            print(tag_map[oid])
            return

        try:
            commit_obj = repo.get(oid)
            if commit_obj is not None and commit_obj.type == GIT_OBJ_COMMIT:
                for parent_id in commit_obj.parent_ids:
                    if parent_id not in visited:
                        queue.append(parent_id)
        except (KeyError, ValueError):
            pass

    print("Error: no ancestor tag found", file=sys.stderr)
    sys.exit(1)


def cmd_tag_list(repo_path):
    """List all v* tags sorted by version descending (like git tag -l 'v*' --sort=-v:refname)."""
    repo = open_repo(repo_path)

    tags = []
    for ref_name in repo.references:
        if ref_name.startswith("refs/tags/v"):
            tag_name = ref_name[len("refs/tags/"):]
            version = parse_version_tuple(tag_name)
            if version is not None:
                tags.append((version, tag_name))

    tags.sort(reverse=True)
    for _, tag_name in tags:
        print(tag_name)


def cmd_rev_list_count(repo_path, tag_or_ref, commit="HEAD"):
    """Count commits between tag and commit (like git rev-list --count tag..commit).

    Walks from commit back through ancestors, stopping at the tag's commit.
    Counts how many commits are visited before reaching the tag.
    """
    repo = open_repo(repo_path)
    tag_oid = resolve_ref(repo, tag_or_ref)
    commit_oid = resolve_ref(repo, commit)

    if tag_oid == commit_oid:
        print(0)
        return

    walker = repo.walk(commit_oid, GIT_SORT_TOPOLOGICAL)
    walker.hide(tag_oid)
    print(sum(1 for _ in walker))


def cmd_cherry_pick_count(repo_path, ref1, ref2):
    """Count unique commits (approximation of git rev-list --count --cherry-pick --left-only ref1...ref2).

    Uses merge-base to find the common ancestor, then counts commits
    reachable from ref1 but not from the merge-base.

    KNOWN PARITY GAP: libgit2/pygit2 does not expose patch-id comparison,
    so this counts EVERY commit between merge-base and ref1 — including
    commits that were cherry-picked from ref2 onto ref1.  On backport
    branches that cherry-pick from master, the result is therefore
    inflated relative to system git's `--cherry-pick`.

    Callers (see version-resolve.findBestBackportTag) already protect
    against this by bailing out when the count exceeds the ancestor
    distance, falling back to a merge-base-based display.  Not fixable
    without upstream libgit2 changes.
    """
    repo = open_repo(repo_path)
    oid1 = resolve_ref(repo, ref1)
    oid2 = resolve_ref(repo, ref2)

    try:
        base_oid = repo.merge_base(oid1, oid2)
    except Exception:
        print("Error: could not find merge-base", file=sys.stderr)
        sys.exit(1)

    if base_oid is None:
        print("Error: no common ancestor found", file=sys.stderr)
        sys.exit(1)

    walker = repo.walk(oid1, GIT_SORT_TOPOLOGICAL)
    walker.hide(base_oid)
    print(sum(1 for _ in walker))


def cmd_merge_base(repo_path, ref1, ref2):
    """Find the common ancestor of two refs. Print the SHA."""
    repo = open_repo(repo_path)
    oid1 = resolve_ref(repo, ref1)
    oid2 = resolve_ref(repo, ref2)

    try:
        base_oid = repo.merge_base(oid1, oid2)
    except Exception:
        print("Error: could not find merge-base", file=sys.stderr)
        sys.exit(1)

    if base_oid is None:
        print("Error: no common ancestor found", file=sys.stderr)
        sys.exit(1)

    print(str(base_oid))


def cmd_is_ancestor(repo_path, ancestor, descendant):
    """Check if ancestor is reachable from descendant.

    Exit 0 if true, exit 1 if false.
    """
    repo = open_repo(repo_path)
    ancestor_oid = resolve_ref(repo, ancestor)
    descendant_oid = resolve_ref(repo, descendant)

    if ancestor_oid == descendant_oid:
        sys.exit(0)

    try:
        base_oid = repo.merge_base(ancestor_oid, descendant_oid)
    except Exception:
        sys.exit(1)

    if base_oid is not None and base_oid == ancestor_oid:
        sys.exit(0)
    else:
        sys.exit(1)


def cmd_fetch_tags(repo_path):
    """Fetch from origin, including tags.

    Try unshallowing first, fall back to regular fetch.
    Exit 0 on success, 1 on failure.
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    # Try unshallow + tags first
    try:
        origin.fetch(
            ["+refs/tags/*:refs/tags/*"],
            depth=0,  # unshallow
            proxy=HTTP_PROXY,
        )
        print("Fetched tags (unshallowed).", file=sys.stderr)
        return
    except Exception:
        pass

    # Fall back to regular tag fetch
    try:
        origin.fetch(["+refs/tags/*:refs/tags/*"], proxy=HTTP_PROXY)
        print("Fetched tags.", file=sys.stderr)
        return
    except Exception as e:
        print("Error: failed to fetch tags: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_fetch_commit(repo_path, sha):
    """Fetch a single commit SHA from origin so it is available locally.

    Needed when the local repo (e.g. a Stable install on a tag, or a shallow
    standalone clone whose master HEAD has since advanced) doesn't have the
    commit that the 'latest' channel points at.

    Mirrors `git fetch origin <sha>`: explicitly asks the remote for the
    requested object via the `allow-reachable-sha1-in-want` protocol
    extension that GitHub supports.  Without the SHA in the refspec, a
    plain `origin.fetch()` only refreshes default refs (refs/heads/*) and
    can complete successfully without actually bringing in the requested
    object — leaving the next `cmd_rev_list_count` call to silently fail
    on `resolve_ref` because the SHA isn't in the object store.

    Exit 0 only when the SHA is provably in the local object store, 1
    otherwise.  Previously this function claimed success on any
    non-throwing fetch attempt, which manifested upstream as a stuck
    `commitsAhead=undefined` on the picker's Latest card.
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    last_error = None

    # Primary: ask the remote for this exact SHA so the fetch actually
    # delivers what we asked for (GitHub honours this via
    # allow-reachable-sha1-in-want).
    try:
        origin.fetch([sha], proxy=HTTP_PROXY)
    except Exception as e:
        last_error = e
        # Fallback: unshallow so the full default-branch history is
        # local.  Slower but works when the server rejects single-SHA
        # fetches or pygit2/libgit2 can't construct the refspec.
        try:
            origin.fetch(depth=0, proxy=HTTP_PROXY)
        except Exception as e2:
            last_error = e2
            # Final fallback: plain default-refspec fetch.  Doesn't
            # guarantee the SHA arrives, but no worse than the previous
            # behaviour — the post-fetch verification below catches it.
            try:
                origin.fetch(proxy=HTTP_PROXY)
            except Exception as e3:
                last_error = e3

    # Verify the object actually landed.  pygit2 throws on missing
    # objects; treat that as the same failure mode as the network
    # error chain above so callers get an honest exit code.
    try:
        repo[sha]
    except (KeyError, ValueError):
        msg = (
            "fetch did not deliver commit %s" % sha
            if last_error is None
            else "fetch failed for commit %s: %s" % (sha, last_error)
        )
        print("Error: %s" % msg, file=sys.stderr)
        sys.exit(1)

    print("Fetched commit %s." % sha, file=sys.stderr)


def _format_bytes(n):
    """Human-readable bytes (binary units, one decimal)."""
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0


def cmd_clone(url, dest):
    """Clone a repository. Print user-readable progress to stderr.

    The launcher main process captures this stream and surfaces each line
    in the install/migration log, so we emit newline-terminated lines
    (no carriage-return TTY tricks) and throttle to ~1 update per second
    so the UI doesn't get spammed.
    """
    url = to_https_url(url)
    print("Downloading ComfyUI source from %s into %s ..." % (url, dest),
          file=sys.stderr)
    try:
        class Progress(pygit2.RemoteCallbacks):
            def __init__(self):
                super().__init__()
                self._last_emit = 0.0
                self._last_total = 0

            def transfer_progress(self, stats):
                now = time.monotonic()
                total = stats.total_objects or 0
                indexed = stats.indexed_objects or 0
                done = total > 0 and indexed >= total
                # Throttle progress lines to ~1/sec, but always emit on
                # completion and on the first tick where the server has
                # told us the total object count.
                if (not done
                        and self._last_total == total
                        and now - self._last_emit < 1.0):
                    return
                self._last_emit = now
                self._last_total = total
                pct = (indexed * 100 // total) if total else 0
                print("  Downloading: %d%% (%d/%d objects, %s received)" % (
                    pct, indexed, total,
                    _format_bytes(stats.received_bytes)),
                    file=sys.stderr)

        pygit2.clone_repository(url, dest, callbacks=Progress(), proxy=HTTP_PROXY)
        print("Download complete.", file=sys.stderr)
    except Exception as e:
        print("Error: clone failed: %s" % e, file=sys.stderr)
        if "callback" in str(e) or "authentication" in str(e).lower():
            print("Git authentication was required for an anonymous clone. "
                  "This usually means your git config rewrites GitHub HTTPS "
                  "URLs to SSH; the launcher clones over anonymous HTTPS and "
                  "cannot use SSH credentials.", file=sys.stderr)
        sys.exit(1)


def _try_resolve_ref(repo, ref):
    """Non-exiting version of resolve_ref.

    Returns the resolved Oid on success, or None if the ref can't be
    resolved locally (e.g. SHA missing from the object store, tag/branch
    not present).  Used by helpers that need to probe for local
    availability without triggering resolve_ref's `sys.exit(1)` (which
    raises SystemExit and is NOT caught by `except Exception`).
    """
    if ref == "HEAD":
        try:
            return repo.head.target
        except Exception:
            return None

    for full in (
        "refs/tags/%s" % ref,
        "refs/heads/%s" % ref,
        "refs/remotes/origin/%s" % ref,
        ref,
    ):
        try:
            r = repo.lookup_reference(full)
            return r.peel(pygit2.Commit).id
        except (KeyError, ValueError):
            continue

    try:
        obj = repo.revparse_single(ref)
        return obj.peel(pygit2.Commit).id
    except (KeyError, ValueError):
        return None


def _ensure_commit_local(repo, commit):
    """Make a best effort to ensure `commit` is in the local object store.

    Tries (in order): explicit SHA refspec via
    `allow-reachable-sha1-in-want`, unshallow, then a plain default
    fetch.  Returns (ok, last_error) — does NOT exit; caller decides how
    to react.  Mirrors the strict pattern in cmd_fetch_commit so callers
    fail honestly when the fetch chain doesn't actually deliver the
    requested object.

    `commit` may be a full SHA, a SHA prefix, a tag, or a branch name —
    `_try_resolve_ref` handles all of them.  The explicit-SHA fetch step
    is a best effort; if `commit` isn't SHA-shaped, libgit2 will simply
    reject that refspec and we fall through to the unshallow / plain
    fetch.
    """
    # Fast path: ref already resolvable locally.
    if _try_resolve_ref(repo, commit) is not None:
        return True, None

    origin = get_origin(repo)
    last_error = None

    # Primary: ask the remote for this exact SHA.  GitHub honours this
    # via allow-reachable-sha1-in-want; a plain default-refspec fetch
    # can succeed without bringing the requested object.
    try:
        origin.fetch([commit])
    except Exception as e:
        last_error = e
        # Fallback: unshallow so the full default-branch history is local.
        try:
            origin.fetch(depth=0, proxy=HTTP_PROXY)
        except Exception as e2:
            last_error = e2
            # Final fallback: plain default-refspec fetch.
            try:
                origin.fetch(proxy=HTTP_PROXY)
            except Exception as e3:
                last_error = e3

    if _try_resolve_ref(repo, commit) is not None:
        return True, None
    return False, last_error


def _try_checkout_existing(repo, commit, strategy):
    """Attempt to resolve + checkout `commit` from the local object store.

    Returns the oid string on success, None if the ref can't be resolved
    locally so the caller can fall back to fetching.  Re-raises
    unexpected exceptions.
    """
    oid = _try_resolve_ref(repo, commit)
    if oid is None:
        return None
    commit_obj = repo.get(oid)
    repo.checkout_tree(commit_obj, strategy=strategy)
    repo.set_head(oid)
    return str(oid)


def cmd_checkout(repo_path, commit):
    """Checkout a specific commit.

    If the commit is not available locally, fetch from origin first
    (preferring an explicit SHA refspec, then unshallow, then plain
    fetch), verify the object actually landed, then retry.  Fails
    honestly when the fetch chain does not deliver the requested SHA.
    """
    repo = open_repo(repo_path)

    # Try direct checkout first (works for full clones where the commit
    # is already local).
    existing = _try_checkout_existing(repo, commit, pygit2.GIT_CHECKOUT_SAFE)
    if existing is not None:
        print("Checked out %s" % existing, file=sys.stderr)
        return

    # Commit not local — fetch and verify.
    print("Commit not found locally, fetching from origin...", file=sys.stderr)
    ok, last_error = _ensure_commit_local(repo, commit)
    if not ok:
        msg = (
            "fetch did not deliver commit %s" % commit
            if last_error is None
            else "fetch failed for commit %s: %s" % (commit, last_error)
        )
        print("Error: %s" % msg, file=sys.stderr)
        sys.exit(1)

    # Retry checkout — the object is now provably in the store.
    try:
        oid = resolve_ref(repo, commit)
        commit_obj = repo.get(oid)
        repo.checkout_tree(commit_obj, strategy=pygit2.GIT_CHECKOUT_SAFE)
        repo.set_head(oid)
        print("Checked out %s" % str(oid), file=sys.stderr)
    except Exception as e:
        print("Error: checkout failed after fetch: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_fetch_and_checkout(repo_path, commit):
    """Fetch master from origin + checkout a specific commit.

    Ensures local master branch exists (mirrors update_comfyui.py behavior).
    After the master refspec fetch, verifies the requested commit actually
    landed; if not (e.g. the commit is not on master HEAD's reachable
    history), falls back to an explicit SHA fetch before checking out.
    """
    repo = open_repo(repo_path)
    origin = get_origin(repo)

    # Fetch master explicitly + tags (mirroring update_comfyui.py)
    refspecs = [
        "+refs/heads/master:refs/remotes/origin/master",
        "+refs/tags/*:refs/tags/*",
    ]

    # Try unshallow first, fall back to regular fetch
    try:
        origin.fetch(refspecs, depth=0, proxy=HTTP_PROXY)
    except Exception:
        try:
            origin.fetch(refspecs, proxy=HTTP_PROXY)
        except Exception as e:
            print("Error: failed to fetch from origin: %s" % e, file=sys.stderr)
            sys.exit(1)

    # Detach HEAD before modifying master to avoid corrupting state
    # if HEAD is currently attached to master
    try:
        repo.set_head(repo.head.target)
    except Exception:
        pass

    # Ensure local master branch exists, pointing at origin/master
    try:
        remote_ref = repo.lookup_reference("refs/remotes/origin/master")
        remote_id = remote_ref.target
        branch = repo.lookup_branch("master")
        if branch is None:
            repo.create_branch("master", repo.get(remote_id))
        else:
            branch.set_target(remote_id)
    except Exception as e:
        print("Warning: could not update local master branch: %s" % e, file=sys.stderr)

    # Verify the requested commit actually arrived; if not, ask for it
    # explicitly via the same strict-fetch path cmd_fetch_commit uses.
    if _try_resolve_ref(repo, commit) is None:
        print("Requested commit not in fetched history; retrying with explicit SHA...", file=sys.stderr)
        ok, last_error = _ensure_commit_local(repo, commit)
        if not ok:
            msg = (
                "fetch did not deliver commit %s" % commit
                if last_error is None
                else "fetch failed for commit %s: %s" % (commit, last_error)
            )
            print("Error: %s" % msg, file=sys.stderr)
            sys.exit(1)

    # Checkout the target commit
    try:
        oid = resolve_ref(repo, commit)
        commit_obj = repo.get(oid)
        repo.checkout_tree(commit_obj, strategy=pygit2.GIT_CHECKOUT_FORCE)
        repo.set_head(oid)
        print("Checked out %s" % str(oid), file=sys.stderr)
    except Exception as e:
        print("Error: checkout failed: %s" % e, file=sys.stderr)
        sys.exit(1)


def cmd_ls_remote_tags(url):
    """List version tags from a remote repository URL, sorted by version descending.

    Uses a temporary bare repo to query the remote via the Git protocol
    (not the GitHub API), so it is not subject to REST API rate limits.
    Prints one tag name per line on stdout.
    """
    import tempfile

    url = to_https_url(url)
    with tempfile.TemporaryDirectory() as tmpdir:
        repo = pygit2.init_repository(tmpdir, bare=True)
        remote = repo.remotes.create_anonymous(url)
        try:
            heads = remote.list_heads(proxy=HTTP_PROXY)
        except AttributeError:
            heads = remote.ls_remotes()

        tags = []
        for ref in heads:
            name = ref["name"] if isinstance(ref, dict) else ref.name
            if not name.startswith("refs/tags/") or name.endswith("^{}"):
                continue
            tag_name = name[len("refs/tags/"):]
            version = parse_version_tuple(tag_name)
            if version is not None:
                tags.append((version, tag_name))

        tags.sort(reverse=True)
        for _, tag_name in tags:
            print(tag_name)


def cmd_ls_remote_ref(url, ref):
    """Get the SHA of a specific ref on a remote URL.

    Prints the SHA on stdout, or exits with code 1 if not found.
    """
    import tempfile

    url = to_https_url(url)
    with tempfile.TemporaryDirectory() as tmpdir:
        repo = pygit2.init_repository(tmpdir, bare=True)
        remote = repo.remotes.create_anonymous(url)
        try:
            heads = remote.list_heads(proxy=HTTP_PROXY)
        except AttributeError:
            heads = remote.ls_remotes()
        for head in heads:
            name = head["name"] if isinstance(head, dict) else head.name
            oid = head["oid"] if isinstance(head, dict) else head.oid
            if name == ref and oid is not None:
                print(str(oid))
                return
        print("Error: ref %s not found" % ref, file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

USAGE = """\
Usage: python git_operations.py <subcommand> [args...]

Subcommands:
  healthcheck
  rev-parse          <repo_path> <ref>
  describe-tags      <repo_path> [commit]
  tag-list           <repo_path>
  rev-list-count     <repo_path> <tag_or_ref> [commit]
  cherry-pick-count  <repo_path> <ref1> <ref2>
  merge-base         <repo_path> <ref1> <ref2>
  is-ancestor        <repo_path> <ancestor> <descendant>
  fetch-tags         <repo_path>
  fetch-commit       <repo_path> <sha>
  clone              <url> <dest>
  checkout           <repo_path> <commit>
  fetch-and-checkout <repo_path> <commit>
  ls-remote-tags     <url>
  ls-remote-ref      <url> <ref>
"""

if __name__ == "__main__":
    pygit2.option(pygit2.GIT_OPT_SET_OWNER_VALIDATION, 0)
    HTTP_PROXY = harden_pygit2_config()

    if len(sys.argv) < 2:
        print(USAGE, file=sys.stderr)
        sys.exit(1)

    subcmd = sys.argv[1]

    try:
        if subcmd == "healthcheck":
            # Minimal smoke test: prove Python starts, this script loads,
            # and `import pygit2` (at module top) succeeded.  The TS
            # caller probes this before configuring pygit2 as a fallback.
            print("ok pygit2 %s" % getattr(pygit2, "__version__", "unknown"))
            sys.exit(0)

        elif subcmd == "rev-parse":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py rev-parse <repo_path> <ref>", file=sys.stderr)
                sys.exit(1)
            cmd_rev_parse(sys.argv[2], sys.argv[3])

        elif subcmd == "describe-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py describe-tags <repo_path> [commit]", file=sys.stderr)
                sys.exit(1)
            commit = sys.argv[3] if len(sys.argv) > 3 else "HEAD"
            cmd_describe_tags(sys.argv[2], commit)

        elif subcmd == "tag-list":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py tag-list <repo_path>", file=sys.stderr)
                sys.exit(1)
            cmd_tag_list(sys.argv[2])

        elif subcmd == "rev-list-count":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py rev-list-count <repo_path> <tag_or_ref> [commit]", file=sys.stderr)
                sys.exit(1)
            commit = sys.argv[4] if len(sys.argv) > 4 else "HEAD"
            cmd_rev_list_count(sys.argv[2], sys.argv[3], commit)

        elif subcmd == "cherry-pick-count":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py cherry-pick-count <repo_path> <ref1> <ref2>", file=sys.stderr)
                sys.exit(1)
            cmd_cherry_pick_count(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "merge-base":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py merge-base <repo_path> <ref1> <ref2>", file=sys.stderr)
                sys.exit(1)
            cmd_merge_base(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "is-ancestor":
            if len(sys.argv) < 5:
                print("Usage: git_operations.py is-ancestor <repo_path> <ancestor> <descendant>", file=sys.stderr)
                sys.exit(1)
            cmd_is_ancestor(sys.argv[2], sys.argv[3], sys.argv[4])

        elif subcmd == "fetch-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py fetch-tags <repo_path>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_tags(sys.argv[2])

        elif subcmd == "fetch-commit":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py fetch-commit <repo_path> <sha>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_commit(sys.argv[2], sys.argv[3])

        elif subcmd == "clone":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py clone <url> <dest>", file=sys.stderr)
                sys.exit(1)
            cmd_clone(sys.argv[2], sys.argv[3])

        elif subcmd == "checkout":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py checkout <repo_path> <commit>", file=sys.stderr)
                sys.exit(1)
            cmd_checkout(sys.argv[2], sys.argv[3])

        elif subcmd == "fetch-and-checkout":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py fetch-and-checkout <repo_path> <commit>", file=sys.stderr)
                sys.exit(1)
            cmd_fetch_and_checkout(sys.argv[2], sys.argv[3])

        elif subcmd == "ls-remote-tags":
            if len(sys.argv) < 3:
                print("Usage: git_operations.py ls-remote-tags <url>", file=sys.stderr)
                sys.exit(1)
            cmd_ls_remote_tags(sys.argv[2])

        elif subcmd == "ls-remote-ref":
            if len(sys.argv) < 4:
                print("Usage: git_operations.py ls-remote-ref <url> <ref>", file=sys.stderr)
                sys.exit(1)
            cmd_ls_remote_ref(sys.argv[2], sys.argv[3])

        else:
            print("Unknown subcommand: %s" % subcmd, file=sys.stderr)
            print(USAGE, file=sys.stderr)
            sys.exit(1)

    except SystemExit:
        raise
    except Exception as e:
        print("Error: %s" % e, file=sys.stderr)
        sys.exit(1)
