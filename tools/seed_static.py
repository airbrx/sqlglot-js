#!/usr/bin/env python3
"""Stub- and table-seeder.

PORT_PLAN.md §4.3 ("drafts the literal portion so the human starts from a filled
skeleton"), §8.1 Rule 2 (method stubs) and Rule 2' (per-line table seeding).

  python3 tools/seed_static.py --file sqlglot/generator.py --class Generator
  python3 tools/seed_static.py --file sqlglot/parser.py --class Parser --out src/parser.js

Emits a JS skeleton in which:

  * every method is a stub, IN UPSTREAM SOURCE ORDER, carrying its own
    `// py: <path>:<line>` anchor and throwing `NotPorted`. One task replaces exactly
    one stub, so two agents produce non-adjacent hunks that git merges cleanly, and
    `grep -c NotPorted` is a free burndown.

  * every class-level dict/set/list literal is seeded ONE ENTRY PER LINE, each with its
    own anchor. Rule 2 alone was not enough: `parser.py` is 405 methods / 8,143 LOC,
    leaving 2,337 LOC of class body (FUNCTIONS 648 entries, the precedence maps, ~162
    attributes) where the grammar shards actually collide. A per-line seed makes an
    addition a single non-adjacent line.

Values that are callables (76% of dialect dict entries, 94% in generators/) cannot be
seeded — they are emitted as anchored TODO lines rather than guessed at.
"""

import argparse
import ast
import json
import os
import sys

HEADER = """// py: {path} @ {commit}
// @seeded by tools/seed_static.py — method stubs and class-table skeletons.
//
// Each stub and each table entry carries its own upstream anchor so that one task
// replaces exactly one line/method and two agents never touch adjacent hunks
// (PORT_PLAN.md §8.1 Rules 2 and 2'). Table ORDER is CI-asserted against a _gen/
// snapshot, because §4.6 establishes that insertion order is observable in output SQL.

{imports}
"""

# Emitted only when the seeded body actually references the symbol, and NEVER when the
# symbol's name collides with the class being seeded — `tokens.py::Tokenizer` seeds a
# class called `Tokenizer`, and an unconditional `import { Tokenizer }` made the output
# fail to parse with "Identifier 'Tokenizer' has already been declared". That is exactly
# the failure mode spike/check_seed.sh exists to catch.
IMPORT_SOURCES = [
    ("NotPorted", "./errors.js", None),
    ("TokenType", "./tokens.js", "TokenType."),
    ("Tokenizer", "./tokens.js", "Tokenizer."),
    ("newTrie", "./trie.js", "newTrie("),
]


def build_imports(body, cls_name):
    """Emit `import` lines for the symbols `body` uses, grouped by module."""
    by_module = {}
    for name, module, marker in IMPORT_SOURCES:
        if name == cls_name:
            continue
        if marker is not None and marker not in body:
            continue
        by_module.setdefault(module, []).append(name)

    lines = [f'import {{ {", ".join(names)} }} from "{module}";'
             for module, names in by_module.items()]
    if "exp." in body and cls_name != "exp":
        lines.append('import * as exp from "./expressions/index.js";')
    return "\n".join(lines) + "\n"


SET_ALGEBRA_HELPERS = """// Upstream computes several class tables with set algebra evaluated once at
// class-definition time (`TABLE_ALIAS_TOKENS = ID_VAR_TOKENS - {...}`). These reproduce
// that, preserving insertion order: a Python set literal is unordered, but the derived
// JS Set's iteration order still has to be deterministic, so it follows the base's.
function setDiff(base, remove) {
  const out = new Set();
  for (const x of base) if (!remove.has(x)) out.add(x);
  return out;
}

function setUnion(a, b) {
  const out = new Set(a);
  for (const x of b) out.add(x);
  return out;
}
"""


# Python parameter names are not constrained by JS's grammar, and upstream really does
# use some: `parser.py:3253` is `_parse_mergeblockratio(self, no, default)`. Emitting
# those verbatim produces a file that does not parse.
JS_RESERVED = {
    "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
    "interface", "let", "new", "null", "package", "private", "protected", "public",
    "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "var", "void", "while", "with", "yield", "arguments", "eval",
}


def js_param(name):
    """Return (js_name, renamed?) for a Python parameter name."""
    if name in JS_RESERVED:
        return name + "_", True
    return name, False


def render_js(v):
    """Render a Python value as JS source. Distinguishes the container kinds that
    json.dumps flattens or rejects: set -> new Set, tuple -> array, dict -> new Map.
    Map/Set (not object/array) because Python dict keys are not all strings and key
    ORDER is observable in output SQL (§4.6)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(render_js(x) for x in v) + "]"
    if isinstance(v, (set, frozenset)):
        # Sets are unordered in Python; sort so the seed is deterministic.
        try:
            items = sorted(v, key=lambda x: (type(x).__name__, x))
        except TypeError:
            items = sorted(v, key=lambda x: repr(x))
        return "new Set([" + ", ".join(render_js(x) for x in items) + "])"
    if isinstance(v, dict):
        return "new Map([" + ", ".join(
            f"[{render_js(k)}, {render_js(val)}]" for k, val in v.items()
        ) + "])"
    return None


# Attribute bases that are pure symbol lookups in the port too, so a reference can be
# transliterated 1:1 instead of being dropped on the floor as a TODO. Measured on
# `parser.py`'s class body: 420 `TokenType.X` + 75 `exp.X` + 3 `exp.X.from_arg_list`
# entries, i.e. the clear majority of every table that the parse path actually reads
# (TYPE_TOKENS, ID_VAR_TOKENS, the eight precedence maps, ...). Emitting those as
# comments left Rule 2' unenforceable: you cannot CI-assert the ORDER of a table whose
# entries are all commented out.
SYMBOLIC_BASES = {"TokenType", "exp", "Tokenizer"}


def symbolic_js(node, known_attrs=()):
    """See `_symbolic_js`; `known_attrs` may be a set or a name->kind mapping."""
    return _symbolic_js(node, known_attrs)


def _symbolic_js(node, known_attrs=()):
    """Render a *symbolic* (non-literal) reference as JS, or None if not mechanical.

    Handles exactly the forms that are a rename-free lookup on the JS side:

      TokenType.SELECT          -> TokenType.SELECT
      exp.Array                 -> exp.Array
      exp.StrPosition.from_arg_list -> exp.StrPosition.from_arg_list
      ID_VAR_TOKENS             -> this.ID_VAR_TOKENS   (a sibling class attribute)

    Anything else -- lambdas, `binary_range_parser(...)`, `dict.fromkeys(...)`,
    comprehensions -- is NOT mechanical and returns None so the caller emits an
    anchored TODO. Guessing at those is how a seeder starts lying.
    """
    if isinstance(node, ast.Attribute):
        base = node.value
        if isinstance(base, ast.Name) and base.id in SYMBOLIC_BASES:
            return f"{base.id}.{node.attr}"
        # exp.StrPosition.from_arg_list — one more level, same rule.
        if isinstance(base, ast.Attribute):
            inner = _symbolic_js(base, known_attrs)
            if inner is not None:
                return f"{inner}.{node.attr}"
        return None

    # `Tokenizer.SINGLE_TOKENS.values()` — an explicit view over a mapping.
    if isinstance(node, ast.Call) and not node.args and not node.keywords:
        f = node.func
        if isinstance(f, ast.Attribute) and f.attr in ("values", "keys"):
            inner = _symbolic_js(f.value, known_attrs)
            if inner is not None:
                return f"{inner}.{f.attr}()"
        return None

    # A bare name that is a sibling class attribute (`ALIAS_TOKENS = ID_VAR_TOKENS`).
    # `this.X` inside a static field initializer is the faithful rendering: it resolves
    # in the declaring class's scope and is computed once, exactly like Python's class
    # body. A subclass that redeclares the base gets its own value; one that doesn't
    # inherits the already-computed set -- both matching Python.
    if isinstance(node, ast.Name):
        if node.id in known_attrs:
            return f"this.{node.id}"
        return None

    return None


def js_literal(node, known_attrs=()):
    """Render a Python AST literal (or mechanical symbolic reference) as JS."""
    try:
        v = ast.literal_eval(node)
    except Exception:  # noqa: BLE001
        # `tuple()` / `set()` / `frozenset({...})` in a VALUE position — a constructor
        # call, so literal_eval refuses it, but the contents are still literal.
        # `OPTIONS_TYPE` tables use `tuple()` as "this keyword takes no argument".
        inner = unwrap_container_call(node)
        if inner is not None:
            try:
                return render_js(ast.literal_eval(inner))
            except Exception:  # noqa: BLE001
                return None
        return symbolic_js(node, known_attrs)
    return render_js(v)


def describe_value(node):
    """A short, honest description of a non-literal value."""
    if isinstance(node, ast.Lambda):
        return "lambda"
    if isinstance(node, ast.Call):
        f = node.func
        name = getattr(f, "id", None) or getattr(f, "attr", None) or "call"
        return f"{name}(...)"
    if isinstance(node, ast.Attribute):
        return ast.unparse(node) if hasattr(ast, "unparse") else "attr"
    if isinstance(node, ast.Name):
        return node.id
    return type(node).__name__


def unwrap_container_call(node):
    """`frozenset({...})` / `set(...)` / `tuple(...)` -> the inner container node.

    Upstream wraps 13 of `parser.py`'s tables this way. The wrapper is a Python typing
    nicety with no JS counterpart (a `Set` is a `Set`); the ENTRIES are what Rule 2'
    cares about, so unwrap rather than emitting the whole table as one TODO.
    Argument-less `set()` / `tuple()` unwrap to an empty container of the right kind.
    """
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        return None
    fname = node.func.id
    if fname not in ("frozenset", "set", "tuple", "list"):
        return None
    if not node.args:
        empty = ast.Set(elts=[]) if fname in ("frozenset", "set") else ast.List(elts=[])
        empty.lineno = node.lineno
        return empty
    inner = node.args[0]
    if isinstance(inner, (ast.Set, ast.List, ast.Tuple, ast.Dict)):
        return inner
    return None


def fromkeys_pairs(node):
    """`dict.fromkeys(keys, value)` -> [(key_node_or_const, value_node)], else None.

    Nine `parser.py` tables are built this way (`CONFLICT_ACTIONS`, `CREATE_SEQUENCE`,
    `USABLES`, ...). It is a pure literal expansion, so seeding it costs nothing and
    keeps those tables assertable. Python shares ONE value object across every key;
    the values here are immutable tuples or a shared builder function, so per-key
    re-rendering is equivalent.
    """
    if not isinstance(node, ast.Call):
        return None
    f = node.func
    if not (isinstance(f, ast.Attribute) and f.attr == "fromkeys"
            and isinstance(f.value, ast.Name) and f.value.id == "dict"):
        return None
    if not node.args:
        return None
    keys = node.args[0]
    if not isinstance(keys, (ast.Tuple, ast.List, ast.Set)):
        return None
    value = node.args[1] if len(node.args) > 1 else ast.Constant(value=None)
    if not hasattr(value, "lineno"):
        value.lineno = node.lineno
    return [(k, value) for k in keys.elts]


def seed_entries(node, path, out, indent, known_attrs, as_map):
    """Emit one anchored line per entry. Returns True if every entry was seedable."""
    complete = True
    if as_map:
        pairs = []
        for k, v in zip(node.keys, node.values):
            if k is None:
                expanded = fromkeys_pairs(v)
                if expanded is not None:
                    pairs.extend(expanded)
                    continue
            pairs.append((k, v))

        for k, v in pairs:
            if k is None:  # {**other} that is not a fromkeys call
                out.append(f"{indent}// py:{getattr(v, 'lineno', node.lineno)}  SPREAD: "
                           f"{describe_value(v)} — merge manually (§4.4 MRO)")
                complete = False
                continue
            kl = js_literal(k, known_attrs)
            vl = js_literal(v, known_attrs)
            ln = getattr(k, "lineno", node.lineno)
            if kl is None:
                kl = f'"{describe_value(k)}"'
                complete = False
            if vl is None:
                out.append(f"{indent}// py:{ln}  [{kl}, /* TODO {describe_value(v)} */],")
                complete = False
            else:
                out.append(f"{indent}/* py:{ln} */ [{kl}, {vl}],")
        return complete

    for el in node.elts:
        ln = getattr(el, "lineno", node.lineno)
        # `*STRUCT_TYPE_TOKENS` inside a set literal — a spread of a sibling table.
        #
        # HAZARD (found by tools/parity/check_parser_tables.mjs, not by reading):
        # Python's `{*some_dict}` spreads a mapping's KEYS, but JS's `[...someMap]`
        # spreads its `[key, value]` PAIRS. `ID_VAR_TOKENS` really does splat two dicts
        # (`*SUBQUERY_PREDICATES`, `*NO_PAREN_FUNCTIONS`), so a literal transliteration
        # silently produced a set of 2-element arrays that no `.has(TokenType.X)` would
        # ever match — and `len()` still looked plausible. Emit `.keys()` explicitly.
        if isinstance(el, ast.Starred):
            inner = _symbolic_js(el.value, known_attrs)
            if inner is not None:
                if (
                    isinstance(el.value, ast.Name)
                    and isinstance(known_attrs, dict)
                    and known_attrs.get(el.value.id) == "map"
                ):
                    inner += ".keys()"
                out.append(f"{indent}/* py:{ln} */ ...{inner},")
            else:
                out.append(f"{indent}// py:{ln}  ...TODO {describe_value(el.value)},")
                complete = False
            continue
        el_l = js_literal(el, known_attrs)
        if el_l is None:
            out.append(f"{indent}// py:{ln}  /* TODO {describe_value(el)} */,")
            complete = False
        else:
            out.append(f"{indent}/* py:{ln} */ {el_l},")
    return complete


def table_kind(node, known_attrs):
    """The JS container kind a table will be seeded as: map / set / seq / other.

    Needed before seeding the NEXT table, because a later table can splat this one and
    the spread form depends on the kind (a Map must splat `.keys()`, a Set must not).
    """
    node = unwrap_container_call(node) or node
    if fromkeys_pairs(node) is not None:
        return "map"
    if isinstance(node, ast.Dict):
        return "map"
    if isinstance(node, ast.Set):
        return "set"
    if isinstance(node, (ast.List, ast.Tuple)):
        return "seq"
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Sub, ast.BitOr)):
        return "set"
    if isinstance(node, ast.Name) and isinstance(known_attrs, dict):
        return known_attrs.get(node.id, "other")
    return "other"


def seed_table(name, node, path, out, known_attrs=()):
    """Seed one class-level dict/set/list, one entry per line, each anchored."""
    unwrapped = unwrap_container_call(node)
    if unwrapped is not None:
        node = unwrapped

    # A whole table that IS a `dict.fromkeys(...)` (USABLES, CAST_ACTIONS,
    # EXECUTE_AS_OPTIONS) — synthesize the equivalent Dict so it seeds per entry
    # instead of being dropped as one opaque TODO.
    # `set(QUERY_MODIFIER_PARSERS)` — iterating a dict yields its KEYS, so this is a
    # keyset view of a sibling table, not a copy of it. Derive it rather than freezing
    # a snapshot, so it stays correct as the stub queue fills the source table in.
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id in ("set", "frozenset") and len(node.args) == 1
            and isinstance(node.args[0], ast.Name)
            and isinstance(known_attrs, dict)
            and known_attrs.get(node.args[0].id) == "map"):
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = new Set(this.{node.args[0].id}.keys());")
        return True

    # `new_trie(key.split(" ") for key in SHOW_PARSERS)` — same story: a derived view.
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "new_trie" and len(node.args) == 1
            and isinstance(node.args[0], (ast.GeneratorExp, ast.ListComp))):
        comp = node.args[0]
        src_name = None
        if len(comp.generators) == 1 and isinstance(comp.generators[0].iter, ast.Name):
            src_name = comp.generators[0].iter.id
        if src_name and isinstance(known_attrs, dict) and known_attrs.get(src_name) == "map":
            out.append(f"  /** py: {path}:{node.lineno} */")
            out.append(
                f'  static {name} = newTrie([...this.{src_name}.keys()]'
                f'.map((key) => key.split(" ")));'
            )
            return True

    whole = fromkeys_pairs(node)
    if whole is not None:
        synth = ast.Dict(keys=[k for k, _ in whole], values=[v for _, v in whole])
        synth.lineno = node.lineno
        node = synth

    if isinstance(node, ast.Dict):
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = new Map([")
        complete = seed_entries(node, path, out, "    ", known_attrs, as_map=True)
        out.append("  ]);")
        return complete

    if isinstance(node, (ast.Set, ast.List, ast.Tuple)):
        is_set = isinstance(node, ast.Set)
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = {'new Set([' if is_set else '['}")
        complete = seed_entries(node, path, out, "    ", known_attrs, as_map=False)
        out.append(f"  {']);' if is_set else '];'}")
        return complete

    # `A - {x, y}` / `{*A, b} - {c}` — set algebra evaluated once at class-definition
    # time, exactly as Python does it. Each subtracted member keeps its own anchor so an
    # addition stays a single non-adjacent line (Rule 2').
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Sub, ast.BitOr)):
        left = unwrap_container_call(node.left) or node.left
        right = unwrap_container_call(node.right) or node.right
        left_js = symbolic_js(left, known_attrs)
        op = "setDiff" if isinstance(node.op, ast.Sub) else "setUnion"
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = {op}(")
        complete = True
        if left_js is not None:
            out.append(f"    {left_js},")
        elif isinstance(left, (ast.Set, ast.List, ast.Tuple)):
            out.append("    new Set([")
            complete &= seed_entries(left, path, out, "      ", known_attrs, as_map=False)
            out.append("    ]),")
        else:
            out.append(f"    /* TODO {describe_value(left)} */ new Set([]),")
            complete = False
        if isinstance(right, (ast.Set, ast.List, ast.Tuple)):
            out.append("    new Set([")
            complete &= seed_entries(right, path, out, "      ", known_attrs, as_map=False)
            out.append("    ]),")
        else:
            rjs = symbolic_js(right, known_attrs)
            if rjs is not None:
                out.append(f"    {rjs},")
            else:
                out.append(f"    /* TODO {describe_value(right)} */ new Set([]),")
                complete = False
        out.append("  );")
        return complete

    lit = js_literal(node, known_attrs)
    if lit is not None:
        out.append(f"  /** py: {path}:{node.lineno} */")
        out.append(f"  static {name} = {lit};")
        return True

    out.append(f"  // py:{node.lineno}  static {name} = /* TODO {describe_value(node)} */;")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="/tmp/sqlglot-ref")
    ap.add_argument("--file", required=True, help="upstream path, e.g. sqlglot/generator.py")
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--out", default=None, help="write here instead of stdout")
    ap.add_argument("--commit", default=None)
    args = ap.parse_args()

    full = os.path.join(args.ref, args.file)
    with open(full, encoding="utf8") as f:
        tree = ast.parse(f.read())

    commit = args.commit
    if commit is None:
        try:
            with open("UPSTREAM.txt", encoding="utf8") as f:
                for line in f:
                    if line.startswith("commit:"):
                        commit = line.split(":", 1)[1].strip()
        except OSError:
            commit = "unknown"

    target = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == args.cls:
            target = node
            break
    if target is None:
        sys.exit(f"class {args.cls} not found in {args.file}")

    # The header is prepended AFTER the body exists, so its imports can be derived
    # from what the body actually references (see build_imports).
    out = [SET_ALGEBRA_HELPERS, f"export class {args.cls} {{"]

    n_tables = 0
    n_tables_partial = 0
    n_methods = 0
    n_renamed_params = 0
    n_entries = 0
    n_entries_todo = 0

    # Names already bound in the class body, so a later table can reference an earlier
    # one (`ALIAS_TOKENS = ID_VAR_TOKENS`). Python resolves those in class-body scope;
    # `this.X` in a static field initializer is the JS equivalent. Mapped to the
    # container KIND, because splatting a Map is not the same as splatting a Set.
    known_attrs = {}

    # Class body in SOURCE ORDER — that order is the contract (§8.1 Rule 2').
    for node in target.body:
        name = None
        value = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(
            node.targets[0], ast.Name
        ):
            name, value = node.targets[0].id, node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name, value = node.target.id, node.value

        if name is not None:
            if name.startswith("_") or value is None:
                continue
            before = len(out)
            kind = table_kind(value, known_attrs)
            complete = seed_table(name, value, args.file, out, known_attrs)
            known_attrs[name] = kind
            for line in out[before:]:
                s = line.strip()
                if s.startswith("// py:"):
                    n_entries += 1
                    n_entries_todo += 1
                elif s.startswith("/* py:"):
                    n_entries += 1
            n_tables += 1
            if not complete:
                n_tables_partial += 1
            out.append("")
            continue

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # `@t.overload`/`@overload` decorated defs are type-checking-only signatures
            # with no runtime body (just `...`) -- typing.overload's own convention is
            # that only the final, undecorated definition sharing the name is real.
            # Seeding these as JS stubs produces duplicate method names (JS silently
            # keeps the last), which also breaks Rule 2's claim key uniqueness
            # (`parser.js#_parse_query_modifiers` stopped being unique). Found via
            # PR #8's claim-overlap tooling audit, 2026-08-28.
            def _is_overload_decorator(d):
                name = d.attr if isinstance(d, ast.Attribute) else getattr(d, "id", "")
                return name == "overload"

            if any(_is_overload_decorator(d) for d in node.decorator_list):
                continue

            argnames = [a.arg for a in node.args.args if a.arg != "self"]
            renamed = []
            js_names = []
            for a in argnames:
                jsn, was = js_param(a)
                js_names.append(jsn)
                if was:
                    renamed.append((a, jsn))
            jsargs = ", ".join(js_names)
            anchor = f"{args.file}:{node.lineno}"
            out.append(f"  /** @returns {{*}} */")
            out.append(f"  // py: {anchor}")
            for orig, jsn in renamed:
                out.append(f"  // note: param `{orig}` renamed to `{jsn}` (JS reserved word)")
            out.append(
                f'  {node.name}({jsargs}) {{ throw new NotPorted("{node.name}", "{anchor}"); }}'
            )
            out.append("")
            n_methods += 1
            n_renamed_params += len(renamed)

    out.append("}")
    body = "\n".join(out)
    header = HEADER.format(path=args.file, commit=commit,
                           imports=build_imports(body, args.cls))
    text = header + body + "\n"

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf8") as f:
            f.write(text)
        where = args.out
    else:
        sys.stdout.write(text)
        where = "<stdout>"

    n_seeded = n_entries - n_entries_todo
    pct = (100.0 * n_seeded / n_entries) if n_entries else 100.0
    print(
        f"  {args.file}::{args.cls} -> {where}\n"
        f"    {n_methods} method stubs\n"
        f"    {n_tables} class tables ({n_tables_partial} contain non-literal entries "
        f"needing hand-porting)\n"
        f"    {n_entries} table entries: {n_seeded} seeded ({pct:.1f}%), "
        f"{n_entries_todo} anchored TODO (callables — never guessed at)\n"
        f"    {n_renamed_params} params renamed (JS reserved words)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
