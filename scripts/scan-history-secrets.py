#!/usr/bin/env python3
"""Scan every blob in git history for committed secrets.

`docs/SECURITY.md` claims no private key, mnemonic or provider token is present in any commit.
This script is what that claim rests on, committed so a reader can reproduce or falsify it instead
of trusting a number in a document. A hardcoded count would be stale the moment it was recorded --
the commit that records it adds a blob -- so the doc points here and this prints the current figures.

Two properties matter more than the pattern list:

  * It enumerates with `git rev-list --objects --all`, so it covers every ref, including branches
    not merged into main and blobs no longer reachable from any tree. A working-tree grep would
    miss exactly the case this exists to catch: a secret committed once and later deleted.
  * It reports how many blobs it skipped for size rather than passing over them silently. A scan
    that quietly ignores part of its input reads as a clean bill of health it did not earn.

Exit status is 1 if anything matched, so this is usable as a gate.

Usage:  python scripts/scan-history-secrets.py [--max-bytes N]
"""

import argparse
import re
import subprocess
import sys

# A 64-hex run is the shape of an EVM private key. It is also the shape of a sha256 digest, a git
# object id and a compiled-bytecode fragment, so this pattern is deliberately over-broad. It happens
# to produce no false positives on this repository -- build artifacts are gitignored and the tests
# compute their keccak values rather than hardcoding them -- so no allowlist exists yet. If one
# becomes necessary, add it here with a reason per entry rather than narrowing the pattern: tightening
# the regex to cut noise is how a real key gets missed.
PATTERNS = {
    "64-hex private key": re.compile(rb"(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])"),
    "supabase jwt": re.compile(rb"eyJ[A-Za-z0-9_-]{20,}"),
    "supabase secret": re.compile(rb"sbp_[0-9a-f]{40}"),
    "openai key": re.compile(rb"sk-[A-Za-z0-9]{20,}"),
    "github token": re.compile(rb"ghp_[A-Za-z0-9]{36}"),
    "aws access key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "google api key": re.compile(rb"AIza[0-9A-Za-z_-]{35}"),
    "slack token": re.compile(rb"xox[baprs]-[0-9A-Za-z-]{10,}"),
}

# These two fields are deliberately public chain evidence, not credentials. Keep this exception
# structural and path-scoped: a 64-hex value anywhere else remains a hit, and the exception does not
# allowlist arbitrary hashes or weaken the token/mnemonic patterns.
PUBLIC_DEPLOYMENT_HASH_FIELDS = re.compile(
    rb'"(?:deploymentTransaction|monitorRole)"\s*:\s*"(?:0x)?[0-9a-fA-F]{64}"'
)

# BIP-39 phrases start from a fixed 2048-word list. Twelve-plus lowercase words in a row beginning
# with one of the early entries is the signature of a committed seed phrase.
MNEMONIC = re.compile(
    rb"\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident)\b"
    rb"(?:\s+[a-z]{3,8}){11,}"
)


def git(*args: str, text: bool = True):
    return subprocess.run(["git", *args], capture_output=True, text=text, check=True).stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--max-bytes",
        type=int,
        default=8_000_000,
        help="skip blobs larger than this; skips are reported, never silent",
    )
    args = ap.parse_args()

    # Refuse to run against a shallow clone. `actions/checkout` defaults to `fetch-depth: 1`, and on a
    # shallow clone this scan would read the blobs of a single commit, find nothing, and print a clean
    # result -- a false green precisely where a false green is most costly. Fail loudly instead.
    if git("rev-parse", "--is-shallow-repository").strip() == "true":
        print(
            "REFUSING TO RUN: shallow clone.\n"
            "This scan is only meaningful over full history. A shallow clone would report a clean\n"
            "result after reading almost nothing. Use `actions/checkout` with `fetch-depth: 0`, or\n"
            "run `git fetch --unshallow` locally.",
            file=sys.stderr,
        )
        return 2

    # Object id -> path, for naming a hit. A blob can appear under several paths; last wins, which
    # is fine because the id in the output is what identifies it.
    names: dict[str, str] = {}
    for line in git("rev-list", "--objects", "--all").splitlines():
        oid, _, path = line.partition(" ")
        names[oid] = path

    commits = git("rev-list", "--all").split()

    blobs: list[tuple[str, int]] = []
    for line in git("cat-file", "--batch-check", "--batch-all-objects").splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[1] == "blob":
            blobs.append((fields[0], int(fields[2])))

    scanned = skipped = 0
    hits: list[tuple[str, str, str]] = []

    for oid, size in blobs:
        if size > args.max_bytes:
            skipped += 1
            print(f"SKIPPED (size {size}): {names.get(oid, oid)}", file=sys.stderr)
            continue
        data = subprocess.run(
            ["git", "cat-file", "blob", oid], capture_output=True, check=True
        ).stdout
        scanned += 1
        for label, rx in PATTERNS.items():
            for m in rx.finditer(data):
                if (
                    label == "64-hex private key"
                    and names.get(oid) == "deployments/base-sepolia.json"
                    and any(m.start() >= field.start() and m.end() <= field.end() for field in PUBLIC_DEPLOYMENT_HASH_FIELDS.finditer(data))
                ):
                    continue
                hits.append((label, names.get(oid, oid), m.group(0)[:16].decode("latin-1")))
        if MNEMONIC.search(data):
            hits.append(("bip39 mnemonic", names.get(oid, oid), "<phrase>"))

    print(f"commits scanned : {len(commits)}")
    print(f"blobs found     : {len(blobs)}")
    print(f"blobs scanned   : {scanned}")
    print(f"blobs skipped   : {skipped}")
    print(f"matches         : {len(hits)}")

    for label, path, sample in hits:
        print(f"  {label:20s} {path[:70]:70s} {sample}...")

    if skipped:
        print("\nA skipped blob is not a clean result. Re-run with a higher --max-bytes.")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
