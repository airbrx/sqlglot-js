"""Harvest, per GENERATE-oracle row, the set of generator units CPython actually executes.

    PYTHONHASHSEED=0 python3 tools/harvest/trace_generate_demand.py > corpus/generate_demand.json

Why this exists
---------------
The generator half of the port needs the same honest scheduling signal
`tools/harvest/trace_parse_demand.py` built for the parser. Generate-oracle row
closure is CONJUNCTIVE exactly as parse-oracle closure is: a row is closed only when
EVERY unit its generation touches is ported, so "method M blocks N rows" is not
"porting M opens N rows", and ranking a stub queue by blocking counts mis-sizes every
brief. This script harvests the raw material — the exact unit set per row — so
`tools/closure_generator.mjs` can compute the marginal instead.

Three deliberate divergences from the parser tracer, each one a recorded defect class
--------------------------------------------------------------------------------
1. IT WRAPS EVERY METHOD, NOT JUST `*_sql`. R13 (PORT_PLAN.md) is precisely the bug of
   a demand tracer with a name-prefix filter: `trace_parse_demand.py` only wrapped
   `_parse_*`, so `_can_parse_limit_or_offset`, `_match_l_paren` and friends were
   invisible, and `closure_parser.mjs` reported closure 49.68% -> 93.99% while the
   honest probe showed EXACT completely unchanged. `Generator` has 484 functions of
   which 432 end in `_sql`; the other 52 (`expressions`, `func`, `format_args`,
   `column_parts`, `query_modifiers`, `table_parts`, `binary`, `prepend_ctes`,
   `format_time`, `sep`, `seg`, `indent`, `wrap`, ...) are exactly the hot-path helper
   shape that bit R13. Filtering on `_sql` here would reproduce that bug knowingly.

2. IT RECORDS `TRANSFORMS` ENTRIES AS FIRST-CLASS UNITS. R14/R17/R19 are three
   successive findings that a dispatch TABLE, a table ENTRY, and a table's READER are
   each invisible to method-level counters. A generator row that routes through
   `TRANSFORMS[exp.Ceil]` does not need a `ceil_sql` method — it needs that table entry,
   and `Generator.TRANSFORMS` in the port is an empty Map (0 of 143). A method-only
   tracer would score those rows as needing nothing and report them closed.

3. IT ATTRIBUTES EACH UNIT TO THE CLASS THAT ACTUALLY DEFINED IT. A row written with
   `write="snowflake"` may resolve `select_sql` to `Snowflake.Generator`, not to the
   base. Recording that as bare `select_sql` would claim `src/generator.js` can close
   the row when it cannot: `src/generators/` does not exist at all. Dialect-owned units
   are therefore namespaced (`Snowflake.Generator.select_sql`) and the closure tool
   reports them as the separate, unstarted component they are — R15's "never scoped"
   lesson, made countable instead of assumed.

Unit naming
-----------
    select_sql                              base `Generator` method
    TRANSFORMS[Ceil]                        base `Generator.TRANSFORMS` entry
    Snowflake.Generator.select_sql          dialect generator method override
    Snowflake.Generator.TRANSFORMS[Ceil]    dialect `TRANSFORMS` override
    transforms.unqualify_unnest             `sqlglot/transforms.py` function

Base-owned units are BARE so that `--brief select_sql` reads naturally and so the
closure tool can map a unit to `src/generator.js` by name alone, the way
`closure_parser.mjs` maps to `src/parser.js`.

`transforms.py` reachability, and the one boundary that remains
---------------------------------------------------------------
`TRANSFORMS` values built by `transforms.preprocess([f, g])` close over the transform
LIST at class-creation time, so wrapping `sqlglot.transforms.f` after import would
never be seen — the closure still holds the original object. This script reaches into
`_to_sql.__closure__`, finds that list, and wraps its elements IN PLACE, so
`transforms.py` demand is recorded rather than silently missing. That module is
unported (`src/transforms.js` does not exist; `Generator.preprocess` in the port says
so), which makes it a real closure blocker, not a curiosity.

The boundary that REMAINS, stated rather than left to be discovered: units are
Generator-class methods, `TRANSFORMS` entries and `transforms.py` functions. Helper
calls into `sqlglot/helper.py`, `sqlglot/expressions.py` (`expression.args`, `.copy()`,
`.key`) and `sqlglot/jsonpath.py`'s internals are NOT recorded as units — jsonpath is
visible only at the granularity of the ten `JSON_PATH_PART_TRANSFORMS` entries that
pull it in. Those files are separately tracked components; the point of writing this
down is that R13's cost came from a blindness nobody had stated, not from one that had.

Reconstruction is self-checked
------------------------------
Each row is regenerated from its atom (`parse_one(atom.sql, read=atom.read)` then
`.sql(write, pretty=, identify=)`) and the result is compared BYTE-FOR-BYTE against the
row's own `sql` field. A row that does not reproduce is counted and DROPPED rather than
recorded, because its traced unit set would describe a different generation than the
one the oracle pins. Measured at the pin: 15,540 of 15,540 reproduce.

Output schema
-------------
Unit names are interned into `units` (descending frequency); `per_row` stores indices.

    {"upstream_commit": "...", "python_version": "...",
     "units": ["sql", "select_sql", ...],
     "freq":  [<rows calling units[0]>, ...],
     "dialects": ["", "bigquery", ...],
     "row_dialect": {"<atom_id>": <index into dialects>, ...},
     "row_flags":   {"<atom_id>": "p"|"i"|"pi", ...},   # only non-default rows
     "per_row":     {"<atom_id>": [<index into units>, ...], ...}}
"""

import collections
import functools
import glob
import json
import os
import sys
import types

REF = os.environ.get("SQLGLOT_REF", "/tmp/sqlglot-ref")
sys.path.insert(0, REF)

import sqlglot  # noqa: E402
from sqlglot.dialects.dialect import Dialect  # noqa: E402
from sqlglot.generator import Generator  # noqa: E402
import sqlglot.generator as generator_mod  # noqa: E402

CURRENT: set = set()


def _recorder(unit, fn):
    """Wrap `fn` so that calling it records `unit`. Signature-transparent."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        CURRENT.add(unit)
        return fn(*args, **kwargs)

    return wrapper


def _generator_classes():
    """Base `Generator` first, then every dialect's generator class, deduped.

    Base first matters: `_transform_units` attributes an inherited `TRANSFORMS` value to
    the base by object identity, which requires the base's own dict to be snapshotted
    before any subclass copy of it is rewritten.
    """
    classes = [Generator]
    seen = {id(Generator)}
    for dialect_cls in Dialect.classes.values():
        gen_cls = dialect_cls.generator_class
        # Walk the generator's own MRO: `Databricks.Generator` extends `Spark.Generator`,
        # and an intermediate link may not itself be any dialect's `generator_class`.
        for cls in gen_cls.__mro__:
            if not issubclass(cls, Generator) or id(cls) in seen:
                continue
            seen.add(id(cls))
            classes.append(cls)
    return classes


def _unit_name(cls, name):
    """`select_sql` for the base, `Snowflake.Generator.select_sql` for a dialect."""
    return name if cls is Generator else f"{cls.__qualname__}.{name}"


def _wrap_methods(classes):
    """Wrap every function each class DEFINES ITSELF.

    Walking `cls.__dict__` rather than `dir(cls)` is what makes attribution correct: the
    MRO already routes a call to the most-derived definition, so the wrapper that fires
    is by construction the one belonging to the class that really ran.
    """
    count = 0
    for cls in classes:
        for name, fn in list(vars(cls).items()):
            if not isinstance(fn, types.FunctionType) or name.startswith("__"):
                continue
            setattr(cls, name, _recorder(_unit_name(cls, name), fn))
            count += 1
    return count


def _wrap_transforms_list(fn, seen_lists):
    """Wrap the transform functions closed over by a `transforms.preprocess` result.

    `preprocess(transforms, generator)` returns a `_to_sql` closure holding the list; the
    list is mutated in place so every already-built reference to it sees the wrappers.
    `seen_lists` guards against double-wrapping when the same `_to_sql` object appears in
    several classes' TRANSFORMS (inherited entries are copied by reference).
    """
    if not isinstance(fn, types.FunctionType) or not fn.__closure__:
        return
    for cell in fn.__closure__:
        try:
            contents = cell.cell_contents
        except ValueError:  # empty cell
            continue
        if not isinstance(contents, list) or id(contents) in seen_lists:
            continue
        if not contents or not all(callable(f) for f in contents):
            continue
        seen_lists.add(id(contents))
        contents[:] = [
            _recorder(f"transforms.{getattr(f, '__name__', repr(f))}", f) for f in contents
        ]


def _wrap_transforms(classes):
    """Wrap every `TRANSFORMS` value, attributing inherited entries to the base."""
    base_orig = dict(Generator.TRANSFORMS)
    seen_lists: set = set()
    count = 0
    for cls in classes:
        table = vars(cls).get("TRANSFORMS")
        if not isinstance(table, dict):
            continue  # inherits the base dict object outright; nothing of its own
        for key, value in list(table.items()):
            if not callable(value):
                continue
            # Identity against the pre-wrap base snapshot: a subclass that spreads
            # `**Generator.TRANSFORMS` holds the very same function object for every
            # entry it did not override, and those are base units, not dialect units.
            owner = Generator if base_orig.get(key) is value else cls
            unit = _unit_name(owner, f"TRANSFORMS[{key.__name__}]")
            _wrap_transforms_list(value, seen_lists)
            table[key] = _recorder(unit, value)
            count += 1
    return count


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        # Same rule as every other oracle script here: dict/set iteration order is
        # observable in generated SQL (property order, `dir()`-driven dispatch), so an
        # unpinned seed makes runs disagree.
        print("refusing to run without PYTHONHASHSEED=0", file=sys.stderr)
        return 2

    classes = _generator_classes()
    n_methods = _wrap_methods(classes)
    n_transforms = _wrap_transforms(classes)
    # Upstream memoises the resolved dispatch per class in `_DISPATCH_CACHE`, and each
    # entry holds the RESOLVED function object. Anything cached before wrapping would
    # dispatch straight past every wrapper. Nothing should have built a generator during
    # import, but clearing is one line and the failure it prevents is silent.
    generator_mod._DISPATCH_CACHE.clear()
    print(
        f"wrapped {n_methods} methods and {n_transforms} TRANSFORMS entries "
        f"across {len(classes)} generator classes",
        file=sys.stderr,
    )

    atoms = {}
    with open("corpus/atoms.jsonl") as fh:
        for line in fh:
            if line.strip():
                atom = json.loads(line)
                atoms[atom["atom_id"]] = atom

    freq: collections.Counter = collections.Counter()
    per_row: dict = {}
    row_dialect: dict = {}
    row_flags: dict = {}
    dialect_index: dict = {}
    parse_failures = 0
    generate_failures = 0
    reconstruction_failures = 0

    for path in sorted(glob.glob("corpus/gen/*.jsonl")):
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                atom = atoms.get(row["ast_ref"])
                if not atom:
                    continue

                try:
                    expression = sqlglot.parse_one(atom["sql"], read=atom["read"] or None)
                except Exception:
                    # A row upstream itself cannot parse carries no generate demand.
                    parse_failures += 1
                    continue

                flags = row["flags"]
                CURRENT.clear()
                try:
                    out = expression.sql(
                        dialect=atom["write"] or None,
                        pretty=flags["pretty"],
                        identify=flags["identify"],
                    )
                except Exception:
                    generate_failures += 1
                    continue

                if out != row["sql"]:
                    # The trace would describe a generation the oracle does not pin.
                    reconstruction_failures += 1
                    continue

                units = sorted(CURRENT)
                per_row[row["atom_id"]] = units
                for unit in units:
                    freq[unit] += 1

                dialect = row["dialect"]
                if dialect not in dialect_index:
                    dialect_index[dialect] = len(dialect_index)
                row_dialect[row["atom_id"]] = dialect_index[dialect]

                mark = ("p" if flags["pretty"] else "") + ("i" if flags["identify"] else "")
                if mark:
                    row_flags[row["atom_id"]] = mark

    provenance = json.load(open("corpus/PROVENANCE.json"))
    units = [u for u, _ in freq.most_common()]
    index = {u: i for i, u in enumerate(units)}
    json.dump(
        {
            "upstream_commit": provenance["upstream_commit"],
            "python_version": provenance["python_version"],
            "rows": len(per_row),
            "parse_failures": parse_failures,
            "generate_failures": generate_failures,
            "reconstruction_failures": reconstruction_failures,
            "units": units,
            "freq": [freq[u] for u in units],
            "dialects": list(dialect_index),
            "row_dialect": row_dialect,
            "row_flags": row_flags,
            "per_row": {k: [index[u] for u in v] for k, v in per_row.items()},
        },
        sys.stdout,
        separators=(",", ":"),
    )
    print(
        f"traced {len(per_row)} rows, {len(freq)} distinct units "
        f"(parse_failures={parse_failures}, generate_failures={generate_failures}, "
        f"reconstruction_failures={reconstruction_failures})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
