#!/usr/bin/env python3
"""
Build a minimal bootstrap Python environment with pygit2 for ComfyUI Desktop 2.0.

Downloads python-build-standalone (stripped), installs pygit2, and aggressively
strips unnecessary files to produce a ~15-20 MB environment that provides git
operations via pygit2 before any standalone environment is downloaded.

Usage:
    python build-bootstrap-python.py [--output DIR] [--platform PLATFORM]

Platforms: win-x64, mac-arm64, linux-x64
If --platform is omitted, auto-detects from the current OS/arch.
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

# Match the standalone environment versions
PYTHON_VERSION = "3.13.12"
PBS_RELEASE = "20260211"

PLATFORM_MAP = {
    "win-x64": {
        "archive": f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "python_bin": "python.exe",
    },
    "mac-arm64": {
        "archive": f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "python_bin": os.path.join("bin", "python3"),
    },
    "linux-x64": {
        "archive": f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        "python_bin": os.path.join("bin", "python3"),
    },
}

PBS_URL_BASE = f"https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_RELEASE}"

# Directories/files to remove during stripping
STRIP_DIRS = [
    "test", "tests", "__pycache__",
    "idle_test", "idlelib", "tkinter", "turtledemo",
    "ensurepip", "venv",
    "lib2to3", "pydoc_data",
    "unittest",
    "tcl", "tk",
    "libs",
]

STRIP_TOP_LEVEL = [
    "pip", "pip-*", "setuptools", "setuptools-*",
    "_distutils_hack", "distutils",
    "pkg_resources",
]

STRIP_EXTENSIONS = [".pyc", ".pyo", ".a", ".lib"]

# DLL/pyd files to remove (unused by pygit2)
STRIP_FILES = [
    "tcl86t.dll", "tk86t.dll", "sqlite3.dll",
    "_testcapi.pyd", "_tkinter.pyd", "_sqlite3.pyd",
]


def detect_platform():
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        return "win-x64"
    elif system == "darwin":
        return "mac-arm64"
    elif system == "linux":
        return "linux-x64"
    else:
        raise RuntimeError(f"Unsupported platform: {system} {machine}")


def download_file(url, dest):
    print(f"Downloading {url}")
    urllib.request.urlretrieve(url, dest)
    size_mb = os.path.getsize(dest) / 1048576
    print(f"  -> {size_mb:.1f} MB")


def find_site_packages(env_dir):
    # Check Windows-style layout first (Lib/site-packages)
    win_sp = os.path.join(env_dir, "Lib", "site-packages")
    if os.path.isdir(win_sp):
        return win_sp
    # Unix-style layout (lib/python3.X/site-packages)
    lib_dir = os.path.join(env_dir, "lib")
    if os.path.exists(lib_dir):
        for entry in os.listdir(lib_dir):
            if entry.startswith("python"):
                sp = os.path.join(lib_dir, entry, "site-packages")
                if os.path.isdir(sp):
                    return sp
    return None


def strip_environment(env_dir):
    """Aggressively remove unnecessary files to minimize size."""
    removed_count = 0

    # Remove directories by name anywhere in the tree
    for root, dirs, files in os.walk(env_dir, topdown=False):
        for d in dirs:
            if d in STRIP_DIRS or d == "__pycache__":
                full = os.path.join(root, d)
                shutil.rmtree(full, ignore_errors=True)
                removed_count += 1

    # Remove specific top-level packages from site-packages
    site_packages = find_site_packages(env_dir)
    if site_packages and os.path.isdir(site_packages):
        import fnmatch
        for entry in os.listdir(site_packages):
            for pattern in STRIP_TOP_LEVEL:
                if fnmatch.fnmatch(entry.lower(), pattern.lower()):
                    full = os.path.join(site_packages, entry)
                    if os.path.isdir(full):
                        shutil.rmtree(full, ignore_errors=True)
                    elif os.path.isfile(full):
                        os.remove(full)
                    removed_count += 1
                    break

    # Remove files by extension and by name
    for root, dirs, files in os.walk(env_dir):
        for f in files:
            if any(f.endswith(ext) for ext in STRIP_EXTENSIONS) or f in STRIP_FILES:
                os.remove(os.path.join(root, f))
                removed_count += 1

    # Remove share/ and include/ directories at top level
    for subdir in ["share", "include"]:
        full = os.path.join(env_dir, subdir)
        if os.path.isdir(full):
            shutil.rmtree(full, ignore_errors=True)
            removed_count += 1

    print(f"  Stripped {removed_count} items")


def get_dir_size_mb(path):
    total = 0
    for root, dirs, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return total / 1048576


def main():
    parser = argparse.ArgumentParser(description="Build bootstrap Python with pygit2")
    parser.add_argument("--output", default="bootstrap-python", help="Output directory (default: bootstrap-python)")
    parser.add_argument("--platform", choices=list(PLATFORM_MAP.keys()), help="Target platform (auto-detected if omitted)")
    args = parser.parse_args()

    plat = args.platform or detect_platform()
    plat_info = PLATFORM_MAP[plat]
    output_dir = os.path.join(args.output, plat)

    print(f"Building bootstrap Python for {plat}")
    print(f"  Python {PYTHON_VERSION}, PBS release {PBS_RELEASE}")

    # Clean output
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)

    with tempfile.TemporaryDirectory() as tmpdir:
        # Download
        archive_name = plat_info["archive"]
        archive_path = os.path.join(tmpdir, archive_name)
        download_file(f"{PBS_URL_BASE}/{archive_name}", archive_path)

        # Extract
        print("Extracting...")
        with tarfile.open(archive_path) as tar:
            tar.extractall(tmpdir)

        # The archive extracts to a "python/" directory
        extracted = os.path.join(tmpdir, "python")
        if not os.path.isdir(extracted):
            raise RuntimeError(f"Expected 'python/' directory in archive, not found in {tmpdir}")

        # Set execute permissions on unix
        if plat != "win-x64":
            python_bin = os.path.join(extracted, plat_info["python_bin"])
            os.chmod(python_bin, 0o755)

        # Install pygit2
        print("Installing pygit2...")
        python_path = os.path.join(extracted, plat_info["python_bin"])
        subprocess.run(
            [python_path, "-m", "pip", "install", "--no-cache-dir", "pygit2"],
            check=True,
        )

        # Verify pygit2 import
        python_path = os.path.join(extracted, plat_info["python_bin"])
        result = subprocess.run(
            [python_path, "-c", "import pygit2; print(f'pygit2 {pygit2.__version__}')"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            print(f"ERROR: pygit2 import failed: {result.stderr}")
            sys.exit(1)
        print(f"  {result.stdout.strip()}")

        # Strip
        print("Stripping unnecessary files...")
        pre_size = get_dir_size_mb(extracted)
        strip_environment(extracted)
        post_size = get_dir_size_mb(extracted)
        print(f"  {pre_size:.1f} MB -> {post_size:.1f} MB")

        # Verify pygit2 still works after stripping
        result = subprocess.run(
            [python_path, "-c", "import pygit2; print('OK')"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            print(f"ERROR: pygit2 broken after stripping: {result.stderr}")
            sys.exit(1)

        # Move to output
        os.makedirs(os.path.dirname(output_dir), exist_ok=True)
        shutil.move(extracted, output_dir)

    print(f"\nBootstrap Python ready: {output_dir} ({get_dir_size_mb(output_dir):.1f} MB)")


if __name__ == "__main__":
    main()
