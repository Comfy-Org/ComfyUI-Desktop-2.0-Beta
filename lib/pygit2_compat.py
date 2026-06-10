"""Shared pygit2 config hardening for the bundled launcher scripts
(git_operations.py and update_comfyui.py).

Both scripts operate on anonymous HTTPS clones of public repos. A user's
global git config can carry `insteadOf` rewrites (e.g. https->ssh) or
credential helpers that force authentication, which libgit2 cannot satisfy
without a credentials callback ("authentication required but no callback
set"). The bundled pygit2 has no SSH transport, so an SSH rewrite can never
succeed; blanking the config search path keeps operations on anonymous HTTPS.
"""

import pygit2


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

    Returns the snapshotted `http.proxy` value (or None) so a corporate
    proxy is preserved and re-applied explicitly on fetch/clone.
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
