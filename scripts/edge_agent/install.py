#!/usr/bin/env python3
"""One-time administrator installation of the BeeHave device agent.

Run on the Pi as: sudo python3 install.py --api-url http://192.168.1.27:3001
Use --dry-run first to see every change without making it. Nothing existing is
edited: only the files listed in docs/PI_AGENT_PLAN.md are created.
"""
import argparse
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
from urllib.parse import urlparse

USER = "beehave-agent"
MONITOR_RUNS = Path("/home/beehave-host/raspberry_pi_continuous_monitor_20261008/runs")
PAIRING = Path("/var/lib/beehave-setup/pairing.json")
FILES = {
    "agent.py": (Path("/opt/beehave-agent/agent.py"), 0o644),
    "sync.py": (Path("/opt/beehave-agent/sync.py"), 0o644),
    "audio_sync.py": (Path("/opt/beehave-agent/audio_sync.py"), 0o644),
    "load_key.py": (Path("/opt/beehave-agent/load_key.py"), 0o644),
    "beehave-agent.service": (Path("/etc/systemd/system/beehave-agent.service"), 0o644),
    "50-beehave-agent.rules": (Path("/etc/polkit-1/rules.d/50-beehave-agent.rules"), 0o644),
}
ENV = Path("/etc/beehave-agent/agent.env")


def main():
    parser = argparse.ArgumentParser(description="Install the BeeHave device agent.")
    parser.add_argument("--api-url", required=True, help="BeeHave API origin, e.g. http://192.168.1.27:3001")
    parser.add_argument("--dry-run", action="store_true", help="Show the changes without making them")
    args = parser.parse_args()
    parsed = urlparse(args.api_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/") or parsed.username:
        sys.exit("Use an http(s) origin without a path or credentials.")
    source = Path(__file__).resolve().parent
    problems = [f"missing bundled file {name}" for name in FILES if not (source / name).is_file()]
    # Normal users often lack /usr/sbin in PATH; sudo includes it.
    search = os.environ.get("PATH", "") + ":/usr/sbin:/sbin"
    for tool in ("systemctl", "useradd"):
        if not shutil.which(tool, path=search):
            problems.append(f"missing {tool}")
    if not Path("/etc/polkit-1/rules.d").is_dir():
        problems.append("polkit rules directory not found")
    if not MONITOR_RUNS.is_dir():
        problems.append(f"monitor output folder not found: {MONITOR_RUNS}")
    targets = [path for path, _ in FILES.values()] + [ENV]
    existing = [str(path) for path in targets if present(path)]
    unchecked = [str(path) for path in targets if present(path) is None]
    if existing:
        problems.append("already installed (remove first): " + ", ".join(existing))
    if problems:
        sys.exit("No changes were made: " + "; ".join(problems))

    steps = [f"create system user {USER} (no login, no home)" if not user_exists() else f"reuse existing user {USER}"]
    steps += [f"copy {name} -> {path} (mode {oct(mode)})" for name, (path, mode) in FILES.items()]
    steps += [f"write {ENV} with BEEHAVE_API_URL={args.api_url.rstrip('/')}", "systemctl daemon-reload",
              "systemctl enable --now beehave-agent.service"]
    if unchecked:
        steps.append("note: without sudo these could not be checked for an earlier install: " + ", ".join(unchecked))
    if os.geteuid() != 0:
        steps.append("note: pairing can only be checked with sudo; an unpaired Pi makes the agent wait")
    elif not PAIRING.exists():
        steps.append("note: this Pi is not paired yet; the agent will wait until it is")
    print("\n".join(("Would " if args.dry_run else "Will ") + step for step in steps))
    if args.dry_run:
        return
    if os.geteuid() != 0:
        sys.exit("Run with sudo to install. No changes were made.")

    if not user_exists():
        run("useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent",
            "--shell", "/usr/sbin/nologin", USER)
    for name, (path, mode) in FILES.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, path)
        os.chmod(path, mode)
    ENV.parent.mkdir(parents=True, exist_ok=True)
    ENV.write_text(
        "# BeeHave agent settings. The device key is loaded from pairing, never stored here.\n"
        f"BEEHAVE_API_URL={args.api_url.rstrip('/')}\nBEEHAVE_HEARTBEAT_SECONDS=30\nBEEHAVE_POLL_SECONDS=10\n"
    )
    os.chmod(ENV, 0o644)
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", "beehave-agent.service")
    print("BeeHave agent installed. Monitoring, pairing, and data were not changed.")
    print("Check it with: systemctl status beehave-agent   and   journalctl -u beehave-agent -n 20")


def present(path):
    """True or False, or None when only an administrator can tell."""
    try:
        path.stat()
        return True
    except FileNotFoundError:
        return False
    except PermissionError:
        return None


def user_exists():
    try:
        pwd.getpwnam(USER)
        return True
    except KeyError:
        return False


def run(*args):
    subprocess.run(args, check=True)


if __name__ == "__main__":
    main()
