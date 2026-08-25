#!/usr/bin/env python3
"""Generate the CPython-side oracle for the `_py/re.js` differential test.

This is the P0 prep for `tools/fuzz_regex.py` (PORT_PLAN.md §3.4 item 2). It does
three things:

  1. **Harvests** every regex pattern sqlglot actually uses, by AST-walking the
     pinned upstream checkout for `re.compile` / `re.fullmatch` / `re.escape` calls
     and for the class attributes that hold compiled patterns. Patterns are recorded
     with their `file:line` so a divergence can be cited, not guessed at.
  2. **Models** the two *runtime-constructed* patterns that cannot be rewritten at
     build time -- `generator.py:1667` and `parsers/bigquery.py:127` -- by feeding
     them the same user-controlled strings the real call sites would see.
  3. **Runs** every (pattern, subject) pair through CPython's `re` and writes the
     result to JSONL for `spike/fuzz_regex.mjs` to diff against `_py/re.js`.

Subjects are drawn from upstream's own test tree (identifiers, string literals,
interval strings, format strings, JSON path keys), not invented, per the plan's
"cite real code, don't guess" standard.

Usage:
    python3 spike/py/gen_regex_cases.py --ref /tmp/sqlglot-ref-regex \\
                                        --out spike/regex/corpus
    python3 spike/py/gen_regex_cases.py --sweep --out spike/regex/corpus
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
import unicodedata

# ----------------------------------------------------------------- harvesting

RE_FUNCS = {"compile", "fullmatch", "match", "search", "sub", "subn", "findall", "split"}

FLAG_VALUES = {
    "IGNORECASE": 2, "I": 2,
    "LOCALE": 4, "L": 4,
    "MULTILINE": 8, "M": 8,
    "DOTALL": 16, "S": 16,
    "UNICODE": 32, "U": 32,
    "VERBOSE": 64, "X": 64,
    "ASCII": 256, "A": 256,
}


def _flag_value(node: ast.AST) -> int | None:
    """Fold `re.I | re.DOTALL` style flag expressions to an int, or None."""
    if isinstance(node, ast.Attribute) and node.attr in FLAG_VALUES:
        return FLAG_VALUES[node.attr]
    if isinstance(node, ast.Name) and node.id in FLAG_VALUES:
        return FLAG_VALUES[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        lo, hi = _flag_value(node.left), _flag_value(node.right)
        return None if lo is None or hi is None else lo | hi
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    return None


def harvest_patterns(ref: str) -> list[dict]:
    """Every statically-known regex literal in sqlglot/, with provenance."""
    out: list[dict] = []
    root = os.path.join(ref, "sqlglot")
    for dirpath, _dirs, files in os.walk(root):
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            path = os.path.join(dirpath, fname)
            rel = os.path.relpath(path, ref)
            try:
                tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                if not (isinstance(fn, ast.Attribute) and fn.attr in RE_FUNCS):
                    continue
                if not (isinstance(fn.value, ast.Name) and fn.value.id == "re"):
                    continue
                if not node.args:
                    continue
                pat = node.args[0]
                if not (isinstance(pat, ast.Constant) and isinstance(pat.value, str)):
                    # Runtime-constructed (f-string / name). Recorded separately.
                    continue
                flags = 0
                for kw in node.keywords:
                    if kw.arg == "flags":
                        flags = _flag_value(kw.value) or 0
                # positional flags argument, e.g. re.fullmatch(p, s, re.IGNORECASE)
                tail = node.args[2:] if fn.attr in ("fullmatch", "match", "search") else []
                for extra in tail:
                    flags |= _flag_value(extra) or 0
                out.append(
                    {
                        "pattern": pat.value,
                        "flags": flags,
                        "py": f"{rel}:{node.lineno}",
                        "call": f"re.{fn.attr}",
                    }
                )
    # De-duplicate on (pattern, flags), keeping the first citation.
    seen: dict[tuple[str, int], dict] = {}
    for item in out:
        seen.setdefault((item["pattern"], item["flags"]), item)
    return list(seen.values())


def harvest_class_attr_patterns(ref: str) -> list[dict]:
    """`SAFE_JSON_PATH_KEY_RE = re.compile(...)` inside a class body is already
    covered by harvest_patterns; this picks up bare-string regex constants that
    are compiled elsewhere (none today, but the resync should notice new ones)."""
    return []


def harvest_subjects(ref: str, limit_per_bucket: int = 4000) -> dict[str, list[str]]:
    """Strings drawn from upstream's own tests, bucketed by what they feed."""
    buckets: dict[str, set[str]] = {
        "identifier": set(),
        "string_literal": set(),
        "interval": set(),
        "time_format": set(),
        "json_path_key": set(),
        "regex_literal": set(),
        "class_name": set(),
    }

    ident_re = re.compile(r"[A-Za-z_-\U0010FFFF][\w-\U0010FFFF]*", re.UNICODE)
    quoted_re = re.compile(r"'([^'\\\n]{0,80})'|\"([^\"\\\n]{0,80})\"")
    interval_re = re.compile(r"INTERVAL\s+'([^']{0,40})'", re.IGNORECASE)
    regexarg_re = re.compile(r"REGEXP_[A-Z_]*\(\s*[^,()]*?,\s*r?(['\"])(.*?)\1", re.S)

    tests_root = os.path.join(ref, "tests")
    for dirpath, _dirs, files in os.walk(tests_root):
        for fname in sorted(files):
            if not fname.endswith((".py", ".sql", ".json")):
                continue
            path = os.path.join(dirpath, fname)
            try:
                text = open(path, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for m in regexarg_re.finditer(text):
                buckets["regex_literal"].add(m.group(2))
            for m in interval_re.finditer(text):
                buckets["interval"].add(m.group(1))
            for m in quoted_re.finditer(text):
                val = m.group(1) if m.group(1) is not None else m.group(2)
                if val:
                    buckets["string_literal"].add(val)
            for m in ident_re.finditer(text):
                buckets["identifier"].add(m.group(0))

    # Expression class names are the real input to helper.py:161's
    # CAMEL_CASE_PATTERN.sub("_", name).upper().
    exp_dir = os.path.join(ref, "sqlglot", "expressions")
    for dirpath, _dirs, files in os.walk(exp_dir):
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            try:
                tree = ast.parse(open(os.path.join(dirpath, fname), encoding="utf-8").read())
            except (OSError, SyntaxError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    buckets["class_name"].add(node.name)

    # JSON path keys from the CTS fixture drive SAFE_JSON_PATH_KEY_RE
    # (generator.py:5366, hive.py:237, bigquery.py:279) and include astral chars.
    cts = os.path.join(ref, "tests", "fixtures", "jsonpath", "cts.json")
    if os.path.exists(cts):
        try:
            doc = json.load(open(cts, encoding="utf-8"))
            stack = [doc]
            while stack:
                cur = stack.pop()
                if isinstance(cur, dict):
                    for k, v in cur.items():
                        buckets["json_path_key"].add(k)
                        stack.append(v)
                elif isinstance(cur, list):
                    stack.extend(cur)
        except (OSError, ValueError):
            pass

    # Time formats: sqlglot's own dialect TIME_MAPPING keys/values feed
    # generators/hive.py:55 CANONICAL_TIME_FORMAT and parsers/tsql.py:49 DATE_FMT_RE.
    dialects_dir = os.path.join(ref, "sqlglot", "dialects")
    fmt_re = re.compile(r"['\"](%[^'\"]{0,20}|[yMdHhmsf][yMdHhmsf:/\- .]{0,20})['\"]")
    for dirpath, _dirs, files in os.walk(dialects_dir):
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            try:
                text = open(os.path.join(dirpath, fname), encoding="utf-8").read()
            except OSError:
                continue
            for m in fmt_re.finditer(text):
                buckets["time_format"].add(m.group(1))

    # Non-ASCII material that upstream's tests exercise, kept explicitly so the
    # bucket never silently loses it (tests/test_transpile.py:25,
    # tests/test_tokens.py:210, tests/fixtures/optimizer/normalize_identifiers.sql:83,
    # tests/fixtures/jsonpath/cts.json:2819).
    for extra in [
        "café", unicodedata.normalize("NFD", "café"), "Êß", "0Êß", "FoÄ", "BaÜ",
        "ж", "Ж", "жЖ", "☺", "☺☺", "\U0001D11E", "\U0001F600", "Jølster",
        "a　b", "ab", "ab", "a﻿b", "ſ", "İ", "ı",
        "aⅣ", "a½", "a٠", "naïve_col", "_x", "1abc", "", " ", "a b",
    ]:
        buckets["identifier"].add(extra)
        buckets["string_literal"].add(extra)

    return {k: sorted(v)[:limit_per_bucket] for k, v in buckets.items()}


# ------------------------------------------------------- dynamic pattern models

def dynamic_patterns(subjects: dict[str, list[str]]) -> list[dict]:
    """The two runtime-constructed patterns, fed realistic user input.

    generator.py:1667  escape_pattern = re.compile(rf"{escape.name}(\\d+)")
        `escape.name` is the UESCAPE character from user SQL, e.g.
        U&'\\0041' UESCAPE '!'  ->  pattern  "!(\\d+)"

    parsers/bigquery.py:127  re.compile(args[1].name).groups == 1
        `args[1].name` is the entire user regex literal from
        REGEXP_EXTRACT(x, '<pattern>').
    """
    out: list[dict] = []

    # UESCAPE takes a single character. ASCII punctuation is the reachable set;
    # every one of these is a legal SQL string body.
    for ch in "!@#$%^&*()-_=+[]{}|\\;:'\",.<>/?~`" + "abcXYZ019":
        out.append(
            {
                "pattern": f"{ch}(\\d+)",
                "flags": 0,
                "py": "sqlglot/generator.py:1667",
                "call": "re.compile",
                "note": f"UESCAPE {ch!r}",
            }
        )

    for lit in subjects["regex_literal"]:
        out.append(
            {
                "pattern": lit,
                "flags": 0,
                "py": "sqlglot/parsers/bigquery.py:127",
                "call": "re.compile",
                "note": "REGEXP_EXTRACT pattern argument (oracle only: .groups)",
            }
        )
    return out


# ------------------------------------------------------------------ structural

def structural_patterns() -> list[dict]:
    """A bounded, deliberately adversarial sweep of Python regex *syntax*.

    Secondary to the harvested corpus; its job is to pin the parser's validity and
    group-counting behaviour on constructs the real corpus happens not to contain,
    because `bigquery.py:127` will happily hand us any of them from user SQL.
    """
    pats = [
        # grouping and numbering
        "(a)", "(?:a)", "(?P<n>a)", "(?P<n>a)(?P=n)", "((a)(b))", "(a)|(b)",
        "(?P<a>x)(?P<b>y)", "(?P<n>a)(?P<n>b)", "(a", "a)", "()", "(?)",
        # backreferences
        r"(a)\1", r"\1(a)", r"(a\1)", r"(a)(b)\2", r"(a)\2", r"\0", r"\08", r"\777",
        r"(((((((((((a)))))))))))\11", r"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)\12",
        # escapes
        r"\A", r"\Z", r"\z", r"\b", r"\B", r"\d", r"\D", r"\s", r"\S", r"\w", r"\W",
        r"\q", r"\p{L}", r"\N{BULLET}", r"\N{NO SUCH NAME}", r"\x41", r"\x4", r"A",
        r"\u004", r"\U0001F600", r"\UFFFFFFFF", r"\a\f\n\r\t\v\\", r"\-", r"\&", r"\#",
        r"\ ", "\\\t",
        # classes
        "[]", "[]]", "[^]]", "[a-z]", "[z-a]", r"[a-\w]", r"[\w-]", r"[-a]", r"[a-]",
        r"[\W]", r"[a\W]", r"[^a\W]", r"[\d\s]", r"[^\d]", "[[:alpha:]]", "[[b]", "[a",
        r"[\b]", r"[\A]", "[^]", r"[\]]", "[.]", "[$^]",
        # quantifiers
        "a*", "a+", "a?", "a*?", "a{2}", "a{2,}", "a{,3}", "a{2,3}", "a{3,2}", "a{}",
        "a{x}", "{,3}", "*a", "+a", "?a", "a**", "a*+", "^*", "(?=a)*", "a{0,}",
        # anchors and dots
        ".", ".*", "^a$", r"a\Z", "(?m)^a$", "(?s).", "(?i)A", "(?x) a  b # c",
        "a(?x)b c", "a(?i)b", "(?ai)a", "(?u)a", "(?L)a", "(?i-s:a)", "(?i:a)",
        # lookaround
        "(?=a)", "(?!a)", "(?<=a)b", "(?<!a)b", "(?<=a*)b", "(?<)", "(?<n>a)",
        # extensions
        "(?#comment)a", "(?#unterminated", "(?(1)a|b)", "(a)(?(1)b|c)", "(?>a)",
        "(?P=n)", "(?P<n>a)(?P=m)", "(?P>n)", "(?Pfoo)",
        # empty / degenerate
        "", "|", "a|", "|a", "(|)", "^", "$", "^$",
    ]
    return [
        {"pattern": p, "flags": 0, "py": "spike:structural", "call": "re.compile"}
        for p in pats
    ]


# ----------------------------------------------------------------- case emission

def jsonable(value):
    """Tuples -> lists so findall results survive the JSON round-trip."""
    if isinstance(value, tuple):
        return [jsonable(v) for v in value]
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    return value


def oracle_case(pat: dict) -> dict:
    """`re.compile(p).groups` / validity -- the bigquery.py:127 contract."""
    rec = {
        "kind": "oracle",
        "pattern": pat["pattern"],
        "flags": pat["flags"],
        "py": pat["py"],
    }
    if "note" in pat:
        rec["note"] = pat["note"]
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            compiled = re.compile(pat["pattern"], pat["flags"])
        rec["valid"] = True
        rec["groups"] = compiled.groups
        rec["groupindex"] = dict(compiled.groupindex)
    except re.error as exc:
        rec["valid"] = False
        rec["groups"] = None
        rec["error"] = str(exc)
    except (RecursionError, OverflowError, MemoryError) as exc:
        rec["valid"] = False
        rec["groups"] = None
        rec["error"] = f"{type(exc).__name__}: {exc}"
    return rec


def match_cases(pat: dict, subjects: list[str]) -> list[dict]:
    """search / match / fullmatch / findall behaviour on real subjects."""
    import warnings

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            compiled = re.compile(pat["pattern"], pat["flags"])
    except (re.error, RecursionError, OverflowError, MemoryError):
        return []

    out = []
    for subject in subjects:
        rec = {
            "kind": "match",
            "pattern": pat["pattern"],
            "flags": pat["flags"],
            "subject": subject,
            "py": pat["py"],
        }
        try:
            m = compiled.search(subject)
            rec["search"] = None if m is None else [m.start(), m.end(), jsonable(m.groups())]
            m = compiled.match(subject)
            rec["match"] = None if m is None else [m.start(), m.end(), jsonable(m.groups())]
            m = compiled.fullmatch(subject)
            rec["fullmatch"] = None if m is None else [m.start(), m.end(), jsonable(m.groups())]
            rec["findall"] = jsonable(compiled.findall(subject))
        except (RecursionError, OverflowError, MemoryError) as exc:
            rec["runtime_error"] = f"{type(exc).__name__}"
        out.append(rec)
    return out


def sub_cases() -> list[dict]:
    """`re.sub` template semantics.

    The two live templates are sqlglot/generator.py:1660 (r"\\\\\\1") and :1663
    (r"\\\\u\\1"), reached from unicodestring_sql. The rest pin the translation
    edge cases the plan calls out: literal backslash-digit, \\g<0>, named vs
    unnamed mixing, and a literal `$` (which JS replacement strings treat as
    special and Python does not).
    """
    cases: list[tuple[str, str, str, int]] = [
        # (pattern, repl, subject, count) -- the two real ones first
        (r"\\(\d+)", r"\\\1", r"a\0041b", 0),
        (r"\\(\d+)", r"\\u\1", r"a\0041b", 0),
        (r"!(\d+)", r"\\\1", r"a!0041b", 0),
        (r"!(\d+)", r"\\u\1", r"a!0041b!0042c", 0),
        # helper.py:161 camel_to_snake_case
        ("(?<!^)(?=[A-Z])", "_", "DateAdd", 0),
        ("(?<!^)(?=[A-Z])", "_", "TsOrDsToDate", 0),
        ("(?<!^)(?=[A-Z])", "_", "JSONBExtract", 0),
        ("(?<!^)(?=[A-Z])", "_", "X", 0),
        # template edge cases
        (r"(a)(b)", r"\2\1", "ab", 0),
        (r"(a)(b)", r"\g<2>\g<1>", "ab", 0),
        (r"(a)", r"[\g<0>]", "a", 0),
        (r"(a)", r"[\g<1>]", "a", 0),
        (r"(?P<x>a)", r"<\g<x>>", "a", 0),
        (r"(?P<x>a)(?P<y>b)", r"\g<y>\g<x>", "ab", 0),
        (r"(?P<x>a)(b)", r"\g<x>\2", "ab", 0),
        (r"(a)", r"\1\1", "a", 0),
        (r"(a)", r"$1", "a", 0),            # literal '$1' in Python, group in JS
        (r"(a)", r"cost: $\1", "a", 0),
        (r"(a)", r"$$", "a", 0),
        (r"(a)", r"\\", "a", 0),
        (r"(a)", r"\\\\", "a", 0),
        (r"(a)", r"\n\t", "a", 0),
        (r"(a)", r"\b", "a", 0),            # backspace in a template, not \b
        (r"(a)", r"\-", "a", 0),            # keeps the backslash
        (r"(a)", r"\q", "a", 0),            # bad escape
        (r"(a)", r"\0", "a", 0),
        (r"(a)", r"\101", "a", 0),
        (r"(a)", r"\2", "a", 0),            # invalid group reference
        (r"(a)", r"\g<3>", "a", 0),
        (r"(a)", r"\g<>", "a", 0),
        (r"(a)", r"\g<x>", "a", 0),
        # the $nn greedy-read trap: 12 groups, \1 followed by a literal '2'
        (r"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", r"\g<1>2", "abcdefghijkl", 0),
        (r"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", r"\g<12>", "abcdefghijkl", 0),
        (r"(a)(b)", r"\g<1>2", "ab", 0),   # only 2 groups: JS falls back correctly
        # counts and zero-width matches
        (r"a", "X", "aaa", 2),
        (r"a*", "-", "abc", 0),
        (r"x*", "-", "abc", 0),
        (r"", "-", "ab", 0),
        (r"\b", "|", "ab cd", 0),
        (r"(?=b)", "-", "abc", 0),
        # unmatched optional group expands to empty, not to "None"
        (r"(a)?b", r"[\1]", "b", 0),
    ]
    out = []
    for pattern, repl, subject, count in cases:
        rec = {
            "kind": "sub",
            "pattern": pattern,
            "repl": repl,
            "subject": subject,
            "count": count,
            "flags": 0,
        }
        try:
            rec["result"], rec["n"] = re.subn(pattern, repl, subject, count=count)
        except re.error as exc:
            rec["error"] = str(exc)
        out.append(rec)
    return out


def escape_cases(subjects: dict[str, list[str]]) -> list[dict]:
    """`re.escape` output, plus proof that escaping round-trips as a matcher.

    py: sqlglot/optimizer/qualify_columns.py:1176,1182 -- the ILIKE-pattern builder
    escapes one character at a time and concatenates the results into a new regex.
    """
    seen: set[str] = set()
    inputs: list[str] = []
    for bucket in ("string_literal", "identifier", "regex_literal", "json_path_key"):
        for s in subjects.get(bucket, [])[:400]:
            if s not in seen:
                seen.add(s)
                inputs.append(s)
    # Every character CPython's re.escape treats specially, one at a time --
    # this is literally what qualify_columns.py:1176 does.
    for ch in "()[]{}?*+-|^$\\.&~# \t\n\r\v\f/'\"`!@%,;:<>=":
        if ch not in seen:
            seen.add(ch)
            inputs.append(ch)
    for s in ["a-b", "%foo%", "_x_", "a.b", "é", "\U0001F600", "a\tb"]:
        if s not in seen:
            seen.add(s)
            inputs.append(s)

    out = []
    for s in inputs:
        escaped = re.escape(s)
        rec = {"kind": "escape", "input": s, "output": escaped}
        # The escaped form must match the original literally and nothing longer.
        try:
            m = re.fullmatch(escaped, s)
            rec["roundtrip"] = m is not None
        except re.error as exc:
            rec["roundtrip"] = False
            rec["error"] = str(exc)
        out.append(rec)

    # The real qualify_columns.py ILIKE construction, end to end.
    for pattern in ["%foo%", "a_c", "100%", "a\\%b", "_", "%", "café%", "[x]%"]:
        chars = []
        for ch in pattern:
            if ch == "_":
                chars.append(".")
            elif ch == "%":
                chars.append(".*")
            else:
                chars.append(re.escape(ch))
        built = "".join(chars)
        rec = {
            "kind": "escape_build",
            "input": pattern,
            "built": built,
            "py": "sqlglot/optimizer/qualify_columns.py:1176",
        }
        try:
            rec["matches"] = {
                s: bool(re.fullmatch(built, s, re.IGNORECASE))
                for s in ["foo", "xfoox", "abc", "a_c", "aXc", "100%", "café", "CAFÉ", ""]
            }
        except re.error as exc:
            rec["error"] = str(exc)
        out.append(rec)
    return out


# ----------------------------------------------------------------- unicode sweep

def sweep(out_dir: str) -> None:
    """Full 0..0x10FFFF sweep of `\\w`, `\\d`, `\\s` (both Unicode and ASCII mode).

    This is what establishes the class mappings in `_py/re.js` empirically instead
    of assuming PORT_PLAN.md §4.6's `[\\p{L}\\p{Nd}\\p{Nl}\\p{No}_]` is right.
    """
    maxcp = 0x110000
    res: dict[str, dict] = {}
    for name, pattern, flags in [
        ("w", r"\w", 0), ("d", r"\d", 0), ("s", r"\s", 0),
        ("w_ascii", r"\w", re.ASCII), ("d_ascii", r"\d", re.ASCII), ("s_ascii", r"\s", re.ASCII),
    ]:
        compiled = re.compile(pattern, flags)
        ranges: list[list[int]] = []
        start = None
        for cp in range(maxcp):
            hit = bool(compiled.match(chr(cp)))
            if hit and start is None:
                start = cp
            elif not hit and start is not None:
                ranges.append([start, cp - 1])
                start = None
        if start is not None:
            ranges.append([start, maxcp - 1])
        res[name] = {
            "ranges": ranges,
            "count": sum(b - a + 1 for a, b in ranges),
            "nranges": len(ranges),
        }
        print(f"  \\{name}: {res[name]['count']} code points in {len(ranges)} ranges", file=sys.stderr)
    res["_provenance"] = {
        "python_version": sys.version.split()[0],
        "unidata_version": unicodedata.unidata_version,
    }
    path = os.path.join(out_dir, "py_unicode_classes.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    print(f"wrote {path}", file=sys.stderr)


# ------------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref-regex")
    ap.add_argument("--out", default="spike/regex/corpus")
    ap.add_argument("--sweep", action="store_true", help="regenerate the Unicode class sweep")
    ap.add_argument("--max-subjects", type=int, default=220,
                    help="subjects paired with each harvested pattern")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if args.sweep:
        sweep(args.out)
        return 0

    if not os.path.isdir(os.path.join(args.ref, "sqlglot")):
        print(f"error: {args.ref} is not a sqlglot checkout", file=sys.stderr)
        return 2

    harvested = harvest_patterns(args.ref)
    subjects = harvest_subjects(args.ref)
    dynamic = dynamic_patterns(subjects)
    structural = structural_patterns()

    print(f"harvested {len(harvested)} static patterns from {args.ref}/sqlglot", file=sys.stderr)
    print(f"modelled  {len(dynamic)} runtime-constructed patterns", file=sys.stderr)
    print(f"structural {len(structural)} adversarial syntax patterns", file=sys.stderr)
    for name, values in subjects.items():
        print(f"  subjects[{name}] = {len(values)}", file=sys.stderr)

    # Which subject buckets each harvested pattern is actually fed in production.
    bucket_for = {
        "sqlglot/expressions/core.py": ["identifier", "class_name", "json_path_key"],
        "sqlglot/expressions/builders.py": ["interval", "string_literal"],
        "sqlglot/generator.py": ["string_literal", "identifier"],
        "sqlglot/generators/hive.py": ["json_path_key", "time_format", "identifier"],
        "sqlglot/generators/bigquery.py": ["json_path_key", "identifier"],
        "sqlglot/generators/duckdb.py": ["string_literal", "time_format"],
        "sqlglot/parsers/tsql.py": ["time_format", "string_literal"],
        "sqlglot/parser.py": ["string_literal", "time_format"],
        "sqlglot/helper.py": ["class_name"],
        "sqlglot/optimizer/qualify_columns.py": ["identifier", "string_literal"],
    }

    generic = (
        subjects["identifier"][: args.max_subjects // 3]
        + subjects["string_literal"][: args.max_subjects // 3]
        + subjects["json_path_key"][: args.max_subjects // 3]
    )

    records: list[dict] = []
    for pat in harvested + dynamic + structural:
        records.append(oracle_case(pat))

    for pat in harvested:
        key = pat["py"].rsplit(":", 1)[0]
        buckets = bucket_for.get(key, ["identifier", "string_literal"])
        subs: list[str] = []
        for bucket in buckets:
            subs.extend(subjects.get(bucket, []))
        subs = subs[: args.max_subjects] or generic
        records.extend(match_cases(pat, subs))

    # The runtime-constructed generator.py:1667 pattern against real U&'' bodies.
    unicode_bodies = [
        r"a\0041b", r"\0041", r"\+01F600", r"!0041", r"a!0041b", "plain",
        r"\1\2\3", r"\\0041", "", r"\0041\0042",
    ]
    for pat in dynamic:
        if pat["py"] == "sqlglot/generator.py:1667":
            records.extend(match_cases(pat, unicode_bodies))

    records.extend(sub_cases())
    records.extend(escape_cases(subjects))

    out_path = os.path.join(args.out, "cases.jsonl")
    with open(out_path, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=True) + "\n")

    meta = {
        "python_version": sys.version.split()[0],
        "unidata_version": unicodedata.unidata_version,
        "ref": args.ref,
        "counts": {
            "total": len(records),
            "oracle": sum(1 for r in records if r["kind"] == "oracle"),
            "match": sum(1 for r in records if r["kind"] == "match"),
            "sub": sum(1 for r in records if r["kind"] == "sub"),
            "escape": sum(1 for r in records if r["kind"] == "escape"),
            "escape_build": sum(1 for r in records if r["kind"] == "escape_build"),
        },
        "harvested_patterns": harvested,
    }
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=True)

    print(f"wrote {out_path}: {len(records)} cases", file=sys.stderr)
    print(json.dumps(meta["counts"], indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
