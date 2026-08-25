"""Shared AST machinery for the three deny-list generators (PORT_PLAN.md §4.6).

The deny-lists exist because the port's agent contract ("transliterate; never use
`Number` for SQL literals") *actively produces wrong code* at specific lines: JS
has no operator overloading, so a faithful-looking transliteration of
`exp.Length(...) - exp.paren(x - 1)` computes a number where Python built an AST.
Those lines have to be enumerated, not reasoned about case by case.

Finding them needs real syntactic understanding, so everything here is AST-based.
The hard part is deciding whether an operand *is* an `Expr` in a dynamically typed
codebase. This module answers that from evidence in the source itself:

  * every class under `sqlglot/expressions/` that transitively subclasses `Expr`;
  * every function/method/property whose **return annotation** is one of those;
  * parameter and variable annotations, propagated through local assignments.

Nothing here guesses from a name spelling. Each verdict carries the reason it was
reached, and the generators emit that reason so a human can audit the list.
"""

from __future__ import annotations

import ast
import os
import typing as t

# Annotation tokens that denote "some kind of Expr" independently of the
# concrete class list: the abstract base, the trait mixins, and the TypeVars.
ABSTRACT_EXPR_NAMES = {
    "Expr",
    "Expression",
    "ExpOrStr",
    "Condition",
    "Predicate",
    "Binary",
    "Connector",
    "Func",
    "AggFunc",
    "Query",
    "Selectable",
    "DerivedTable",
    "UDTF",
    "DDL",
    "DML",
    "IntervalOp",
    "TimeUnit",
    "SubqueryPredicate",
    "ColumnConstraintKind",
    "E",
    "B",
    "F",
    "Q",
}

# Attribute accesses that yield an Expr (or a list of them) on any node. These
# are properties on `Expr`/`Expression`; they get confirmed against the harvested
# return annotations in `ExprKnowledge.check_builtin_properties`.
EXPR_ATTRS = {"this", "expression", "left", "right", "parent", "unit", "alias_or_name_expr"}
EXPR_LIST_ATTRS = {"expressions", "flatten", "args"}


def _ann_text(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - unparse is total on parsed input
        return ""


class ExprKnowledge:
    """What counts as an `Expr`, harvested from the pinned source."""

    def __init__(self, ref: str) -> None:
        self.ref = ref
        self.classes: set[str] = set()
        self.expr_functions: set[str] = set()
        self.expr_methods: set[str] = set()
        self.expr_properties: set[str] = set()
        self._build()

    # ---------------------------------------------------------------- build

    def _build(self) -> None:
        bases: dict[str, list[str]] = {}
        exp_dir = os.path.join(self.ref, "sqlglot", "expressions")
        for path in _walk_py(exp_dir):
            tree = _parse(path)
            if tree is None:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    bases[node.name] = [_ann_text(b) for b in node.bases]

        def reaches(name: str, seen: set[str] | None = None) -> bool:
            seen = seen if seen is not None else set()
            if name in seen:
                return False
            seen.add(name)
            for b in bases.get(name, []):
                if b in ("Expr", "Expression"):
                    return True
                if reaches(b, seen):
                    return True
            return False

        self.classes = {n for n in bases if n in ("Expr", "Expression") or reaches(n)}

        # Functions and methods whose declared return type is an Expr. This is
        # what makes `.copy()`, `exp.paren(...)`, `seq_get(...)` recognisable
        # without hardcoding a list of names.
        for path in _walk_py(os.path.join(self.ref, "sqlglot")):
            tree = _parse(path)
            if tree is None:
                continue
            in_class: list[str] = []
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    in_class.append(node.name)
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if not self.is_expr_annotation(_ann_text(node.returns)):
                    continue
                decorators = {_ann_text(d) for d in node.decorator_list}
                if "property" in decorators or "cached_property" in decorators:
                    self.expr_properties.add(node.name)
                else:
                    self.expr_functions.add(node.name)
                    self.expr_methods.add(node.name)

    # ------------------------------------------------------------- queries

    def is_expr_annotation(self, text: str) -> bool:
        """True when an annotation string denotes an Expr (or a container of one)."""
        if not text:
            return False
        # `-> bool`, `-> str`, `-> int` are the common non-Expr returns; bail early
        # so that e.g. `t.Callable[..., Expression]` is not mistaken for a value.
        if text in ("bool", "str", "int", "float", "None", "bytes"):
            return False
        if text.startswith("t.Callable") or text.startswith("Callable"):
            return False
        for name in _identifiers(text):
            if name in ABSTRACT_EXPR_NAMES or name in self.classes:
                return True
        return False


def _identifiers(text: str) -> t.Iterator[str]:
    cur = ""
    for ch in text:
        if ch.isalnum() or ch == "_":
            cur += ch
        else:
            if cur:
                yield cur
            cur = ""
    if cur:
        yield cur


def _walk_py(root: str) -> t.Iterator[str]:
    for dirpath, _dirs, files in os.walk(root):
        for fname in sorted(files):
            if fname.endswith(".py"):
                yield os.path.join(dirpath, fname)


def _parse(path: str) -> ast.Module | None:
    try:
        return ast.parse(open(path, encoding="utf-8").read(), filename=path)
    except (OSError, SyntaxError):
        return None


# --------------------------------------------------------------------- typing

# How confident we are that a node is an Expr, and why.
CONF_HIGH = "high"
CONF_MEDIUM = "medium"
CONF_LOW = "low"


class ExprTyper:
    """Local, annotation-driven inference of "is this node an Expr?".

    Scoped to one function body (or one module body). Names get their type from
    parameter annotations, annotated assignments, `for` targets over Expr
    collections, and plain assignments from Expr-valued right-hand sides,
    iterated to a fixpoint.
    """

    def __init__(self, knowledge: ExprKnowledge, scope: ast.AST) -> None:
        self.k = knowledge
        self.scope = scope
        self.names: dict[str, tuple[str, str]] = {}  # name -> (confidence, reason)
        self.not_expr: set[str] = set()
        self._seed()
        for _ in range(3):  # fixpoint; 3 passes is ample for sqlglot's shapes
            if not self._propagate():
                break

    # ------------------------------------------------------------- seeding

    def _seed(self) -> None:
        node = self.scope
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
                text = _ann_text(a.annotation)
                if self.k.is_expr_annotation(text):
                    self.names[a.arg] = (CONF_HIGH, f"parameter annotated {text}")
                elif text in ("int", "str", "bool", "float", "bytes"):
                    self.not_expr.add(a.arg)
            if args.vararg is not None:
                text = _ann_text(args.vararg.annotation)
                if self.k.is_expr_annotation(text):
                    self.names[args.vararg.arg] = (CONF_MEDIUM, f"*args annotated {text}")

        for sub in ast.walk(node):
            if isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Name):
                text = _ann_text(sub.annotation)
                if self.k.is_expr_annotation(text):
                    self.names[sub.target.id] = (CONF_HIGH, f"annotated {text}")
                elif text in ("int", "str", "bool", "float", "bytes"):
                    self.not_expr.add(sub.target.id)
            elif isinstance(sub, ast.For):
                # `for e in expression.expressions:` binds an Expr
                if self._is_expr_iterable(sub.iter) and isinstance(sub.target, ast.Name):
                    self.names[sub.target.id] = (CONF_MEDIUM, "loop over an Expr collection")

    def _propagate(self) -> bool:
        changed = False
        for sub in ast.walk(self.scope):
            if not isinstance(sub, ast.Assign):
                continue
            verdict = self.classify(sub.value)
            if verdict is None:
                continue
            conf, reason = verdict
            for target in sub.targets:
                if isinstance(target, ast.Name) and target.id not in self.names:
                    if target.id in self.not_expr:
                        continue
                    self.names[target.id] = (conf, f"assigned from {reason}")
                    changed = True
        return changed

    # ---------------------------------------------------------- classifier

    def _is_expr_iterable(self, node: ast.AST) -> bool:
        if isinstance(node, ast.Attribute) and node.attr in EXPR_LIST_ATTRS:
            return True
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Attribute) and fn.attr in ("find_all", "flatten", "iter_expressions"):
                return True
        return False

    def classify(self, node: ast.AST) -> tuple[str, str] | None:
        """Return (confidence, reason) if `node` evaluates to an Expr, else None."""
        # exp.Foo(...) / Foo(...) where Foo is a harvested expression class
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Attribute):
                if fn.attr in self.k.classes:
                    return (CONF_HIGH, f"constructor {ast.unparse(fn)}(...)")
                if fn.attr in self.k.expr_methods:
                    return (CONF_MEDIUM, f"call {fn.attr}() returns an Expr")
            if isinstance(fn, ast.Name):
                if fn.id in self.k.classes:
                    return (CONF_HIGH, f"constructor {fn.id}(...)")
                if fn.id in self.k.expr_functions:
                    return (CONF_MEDIUM, f"call {fn.id}() returns an Expr")
            return None

        # `.this`, `.expression`, `.left`, ... and harvested Expr properties
        if isinstance(node, ast.Attribute):
            if node.attr in EXPR_ATTRS:
                return (CONF_HIGH, f".{node.attr} is an Expr")
            if node.attr in self.k.expr_properties:
                return (CONF_MEDIUM, f".{node.attr} is an Expr property")
            return None

        if isinstance(node, ast.Name):
            if node.id in self.not_expr:
                return None
            return self.names.get(node.id)

        # expression.expressions[0], args[i] where args holds Exprs
        if isinstance(node, ast.Subscript):
            if self._is_expr_iterable(node.value):
                return (CONF_MEDIUM, "index into an Expr collection")
            inner = self.classify(node.value)
            if inner is not None:
                # subscripting an Expr is itself __getitem__ -> Bracket
                return (CONF_MEDIUM, "Bracket from Expr.__getitem__")
            return None

        # (a - b) is an Expr if either side is
        if isinstance(node, ast.BinOp):
            for side in (node.left, node.right):
                v = self.classify(side)
                if v is not None:
                    return (v[0], f"BinOp over {v[1]}")
            return None

        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.Invert)):
            v = self.classify(node.operand)
            if v is not None:
                return (v[0], f"UnaryOp over {v[1]}")
            return None

        if isinstance(node, ast.IfExp):
            for side in (node.body, node.orelse):
                v = self.classify(side)
                if v is not None:
                    return (CONF_LOW, f"conditional yielding {v[1]}")
            return None

        if isinstance(node, ast.BoolOp):
            # `x or exp.null()` is an idiomatic default; the result may be an Expr
            for side in node.values:
                v = self.classify(side)
                if v is not None:
                    return (CONF_LOW, f"and/or yielding {v[1]}")
            return None

        return None


def iter_scopes(tree: ast.Module) -> t.Iterator[ast.AST]:
    """Every function body, plus the module body itself as a pseudo-scope."""
    yield tree
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def owning_scope(tree: ast.Module) -> dict[int, ast.AST]:
    """Map id(node) -> innermost enclosing function (or the module)."""
    owner: dict[int, ast.AST] = {}

    def visit(node: ast.AST, scope: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                owner[id(child)] = scope
                visit(child, child)
            else:
                owner[id(child)] = scope
                visit(child, scope)

    owner[id(tree)] = tree
    visit(tree, tree)
    return owner


def rel(ref: str, path: str) -> str:
    return os.path.relpath(path, ref)


def source_line(path: str, lineno: int) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if i == lineno:
                    return line.rstrip("\n").strip()
    except OSError:
        pass
    return ""


def sqlglot_files(ref: str) -> list[str]:
    """Every .py under sqlglot/, executor included but flagged by the caller."""
    return sorted(_walk_py(os.path.join(ref, "sqlglot")))


def is_executor(relpath: str) -> bool:
    """`tests/test_executor.py` and sqlglot's executor are permanently out of
    scope (PORT_PLAN.md §1), so executor hits are reported separately."""
    return relpath.startswith("sqlglot/executor/")
