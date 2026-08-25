#!/usr/bin/env python3
"""The structure channel — per-upstream-bump method manifest diff.

PORT_PLAN.md §3.7. Detecting breakage is not the same as propagating change:
corpus diffs tell us THAT something broke, this tells us WHAT to port.

  python3 tools/sync_report.py --snapshot          # record the current manifest
  python3 tools/sync_report.py                     # diff working tree vs snapshot

Emits, per ported file: methods added / renamed / deleted / body-changed, with line
anchors on both sides. That is the work-item generator for maintenance (§5.1).
"""

import argparse
import ast
import hashlib
import json
import os
import sys

SNAPSHOT = "corpus/manifest.json"


def norm_body(src_lines, node):
    """Body hash that ignores the `def ...:` signature line, a leading docstring,
    comments and blank lines, so a reflow -- or a RENAME -- does not read as a change,
    but a real edit does.

    Codex review, PR #1: the signature line was previously included in the hashed
    segment (`src_lines[node.lineno - 1 : ...]`, where `node.lineno` is the `def` line
    itself on Python 3.8+). That meant renaming a method while leaving its body
    identical still changed the hash -- `diff()`'s rename detector matches purely on
    hash equality, so every rename was silently reported as an unrelated add+remove
    instead of the promised rename work item. The bug was invisible to the old
    selftest because it constructed synthetic manifest entries with pre-chosen hash
    values instead of calling `manifest_for`/`norm_body` on real source (see
    `selftest()` below, which now does).
    """
    body = node.body
    start = node.lineno  # 0-indexed position of the line AFTER `def ...:` (1-indexed
    # node.lineno IS the def line on Python 3.8+, even for decorated functions).
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(getattr(body[0].value, "value", None), str)
    ):
        start = max(start, body[0].end_lineno)  # also skip a leading docstring
    seg = src_lines[start : node.end_lineno]
    out = []
    for line in seg:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(s)
    text = "\n".join(out)
    return hashlib.sha256(text.encode("utf8")).hexdigest()[:12]


def manifest_for_source(src, label="<string>"):
    """{qualname: {line, end, hash}} for every function/method in Python source text."""
    lines = src.splitlines()
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return {"__parse_error__": f"{label}: {e}"}

    out = {}

    def walk(node, prefix):
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = f"{prefix}{child.name}"
                out[name] = {
                    "line": child.lineno,
                    "end": child.end_lineno,
                    "hash": norm_body(lines, child),
                }
            elif isinstance(child, ast.ClassDef):
                walk(child, f"{prefix}{child.name}.")

    walk(tree, "")
    return out


def manifest_for(path):
    """{qualname: {line, end, hash}} for every function/method in a module file."""
    with open(path, encoding="utf8") as f:
        src = f.read()
    return manifest_for_source(src, label=path)


def collect(ref, subdir="sqlglot"):
    root = os.path.join(ref, subdir)
    man = {}
    for dirpath, _dirs, files in os.walk(root):
        for fn in sorted(files):
            if not fn.endswith(".py"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ref)
            man[rel] = manifest_for(full)
    return man


def diff(old, new):
    report = {"files_added": [], "files_removed": [], "changed": {}}
    for f in sorted(set(new) - set(old)):
        report["files_added"].append(f)
    for f in sorted(set(old) - set(new)):
        report["files_removed"].append(f)

    for f in sorted(set(old) & set(new)):
        o, n = old[f], new[f]
        added = sorted(set(n) - set(o))
        removed = sorted(set(o) - set(n))
        body_changed = sorted(
            m for m in set(o) & set(n) if o[m].get("hash") != n[m].get("hash")
        )
        # A method that vanished and one that appeared with an identical body hash is
        # a rename, not a delete+add. Reporting it as two work items would be wrong.
        renames = []
        by_hash_removed = {}
        for m in removed:
            by_hash_removed.setdefault(o[m].get("hash"), []).append(m)
        for m in list(added):
            h = n[m].get("hash")
            cands = by_hash_removed.get(h)
            if cands:
                old_name = cands.pop(0)
                renames.append([old_name, m])
                added.remove(m)
                removed.remove(old_name)

        moved = sorted(
            m
            for m in set(o) & set(n)
            if o[m].get("hash") == n[m].get("hash") and o[m].get("line") != n[m].get("line")
        )
        if added or removed or body_changed or renames:
            report["changed"][f] = {
                "added": [[m, n[m]["line"]] for m in added],
                "removed": [[m, o[m]["line"]] for m in removed],
                "renamed": renames,
                "body_changed": [[m, o[m]["line"], n[m]["line"]] for m in body_changed],
                "moved_only": len(moved),
            }
    return report


def selftest():
    checks = []

    def t(name, cond):
        checks.append((name, bool(cond)))

    M = lambda line, h: {"line": line, "end": line + 5, "hash": h}  # noqa: E731

    old = {"a.py": {"f": M(10, "h1"), "g": M(20, "h2"), "gone": M(30, "h3")}}
    new = {
        "a.py": {
            "f": M(10, "h1"),  # unchanged
            "g": M(20, "hX"),  # body changed
            "renamed": M(30, "h3"),  # same body as `gone` -> a rename
            "brand_new": M(40, "h9"),
        },
        "b.py": {"z": M(1, "h0")},
    }
    r = diff(old, new)
    c = r["changed"]["a.py"]

    t("new file detected", r["files_added"] == ["b.py"])
    t("body change detected", [m for m, _, _ in c["body_changed"]] == ["g"])
    # The one that matters: a delete+add with an identical body is ONE work item
    # (a rename), not two. Reporting it as two would send an agent to re-port
    # code that only moved.
    t("rename detected", c["renamed"] == [["gone", "renamed"]])
    t("rename not double-counted as added", [m for m, _ in c["added"]] == ["brand_new"])
    t("rename not double-counted as removed", c["removed"] == [])

    # A pure line shift must not be reported as a change.
    old2 = {"a.py": {"f": M(10, "h1")}}
    new2 = {"a.py": {"f": M(99, "h1")}}
    t("pure move is not a change", "a.py" not in diff(old2, new2)["changed"])

    # Codex review, PR #1: exercise manifest_for_source on REAL code, not synthetic
    # hashes, so a regression in norm_body's line-skipping (signature/docstring) is
    # actually caught by this test instead of being invisible to it.
    src_before = (
        "def _parse_bitwise(self, token):\n"
        '    """Old name."""\n'
        "    return self.this + 1\n"
    )
    src_renamed = (
        "def _parse_binary(self, token):\n"
        '    """New docstring text -- should not affect the hash."""\n'
        "    return self.this + 1\n"
    )
    src_body_changed = (
        "def _parse_binary(self, token):\n"
        '    """New docstring text -- should not affect the hash."""\n'
        "    return self.this + 2\n"
    )
    m_before = manifest_for_source(src_before)
    m_renamed = manifest_for_source(src_renamed)
    m_body_changed = manifest_for_source(src_body_changed)
    t(
        "real rename: identical body, different name+docstring -> same hash",
        m_before["_parse_bitwise"]["hash"] == m_renamed["_parse_binary"]["hash"],
    )
    t(
        "real rename detected end-to-end via diff()",
        diff({"a.py": m_before}, {"a.py": m_renamed})["changed"]["a.py"]["renamed"]
        == [["_parse_bitwise", "_parse_binary"]],
    )
    t(
        "real body edit still changes the hash",
        m_renamed["_parse_binary"]["hash"] != m_body_changed["_parse_binary"]["hash"],
    )

    bad = 0
    for name, ok in checks:
        if not ok:
            bad += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    print("\n  SYNC_REPORT SELFTEST: " + ("GREEN\n" if bad == 0 else f"RED ({bad})\n"))
    return 0 if bad == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref")
    ap.add_argument("--snapshot", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default=SNAPSHOT)
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    new = collect(args.ref)

    if args.snapshot or not os.path.exists(args.out):
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf8") as f:
            json.dump(new, f, separators=(",", ":"), sort_keys=True)
            f.write("\n")
        n = sum(len(v) for v in new.values())
        print(f"  snapshot: {len(new)} files, {n} methods -> {args.out}", file=sys.stderr)
        return

    with open(args.out, encoding="utf8") as f:
        old = json.load(f)

    rep = diff(old, new)
    total_add = sum(len(v["added"]) for v in rep["changed"].values())
    total_rm = sum(len(v["removed"]) for v in rep["changed"].values())
    total_ren = sum(len(v["renamed"]) for v in rep["changed"].values())
    total_body = sum(len(v["body_changed"]) for v in rep["changed"].values())

    print(f"\n  files: +{len(rep['files_added'])} -{len(rep['files_removed'])}, "
          f"{len(rep['changed'])} changed")
    print(f"  methods: +{total_add} -{total_rm} ~{total_body} renamed {total_ren}\n")
    for f, v in sorted(rep["changed"].items()):
        print(f"  {f}")
        for m, ln in v["added"]:
            print(f"    + {m}  (new:{ln})")
        for m, ln in v["removed"]:
            print(f"    - {m}  (was:{ln})")
        for a, b in v["renamed"]:
            print(f"    ~ {a} -> {b}  (rename, body identical)")
        for m, lo, ln in v["body_changed"]:
            print(f"    M {m}  (py:{lo} -> py:{ln})")
    if not rep["changed"] and not rep["files_added"] and not rep["files_removed"]:
        print("  no structural change")


if __name__ == "__main__":
    main()
