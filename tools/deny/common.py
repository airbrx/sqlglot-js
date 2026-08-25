"""Shared AST machinery for the three deny-list generators (PORT_PLAN.md §4.6).

The deny-lists exist because the port's agent contract ("transliterate; never use
`Number` for SQL literals") *actively produces wrong code* at specific lines: JS
has no operator overloading, so a faithful-looking transliteration of
`exp.Length(...) - exp.paren(x - 1)` computes a number where Python built an AST.
Those lines have to be enumerated, not reasoned about case by case.

Finding them needs real syntactic understanding, so everything here is AST-based.
The hard part is deciding whether an operand *is* an `Expr` in a dynamically
typed codebase. This module answers that from evidence in the source itself:

  * every class under `sqlglot/expressions/` that transitively subclasses `Expr`;
  * every function/method/property whose **return annotation** is one of those;
  * parameter and variable annotations, propagated through local assignments.

Two things make a naive version of this badly wrong, and both are handled here:

  1. **Ten expression classes collide with `typing` names** — `Any`, `ByteString`,
     `Final`, `Generator`, `List`, `Literal`, `Match`, `Set`, `Tuple`, `Union`.
     A substring match on the annotation text reads `t.Any` as `exp.Any` and
     flags every `args[i]` in the codebase. Annotations are therefore parsed and
     resolved against each module's actual imports.
  2. **A container of Exprs is not an Expr.** `t.List[Expr]` must not make
     `values[0]` look like `Expr.__getitem__`; it makes it an ordinary list index
     that *yields* an Expr. The classifier is three-valued for that reason.

Nothing here guesses from a name spelling. Every verdict carries the reason it
was reached, and the generators emit that reason so a human can audit the list.
"""

from __future__ import annotations

import ast
import os
import typing as t

# Annotation tokens that denote "some kind of Expr" independently of the concrete
# class list: the abstract base, the trait mixins, and the TypeVars sqlglot binds
# to Expr subclasses.
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

# Annotation heads that wrap rather than are: `list[Expr]` holds Exprs, it is not
# one. Indexing one of these yields an Expr; indexing an Expr builds a Bracket.
CONTAINER_HEADS = {
    "list", "List", "tuple", "Tuple", "set", "Set", "frozenset", "FrozenSet",
    "dict", "Dict", "Sequence", "MutableSequence", "Iterable", "Iterator",
    "Generator", "Collection", "Mapping", "MutableMapping", "DefaultDict",
    "Deque", "Counter", "OrderedDict", "AbstractSet", "Reversible", "Container",
}
UNION_HEADS = {"Optional", "Union"}
# Heads whose subscript is not a value container at all.
OPAQUE_HEADS = {"Type", "type", "Callable", "ClassVar", "Final", "Literal", "Annotated", "Unpack"}

KIND_EXPR = "expr"
KIND_CONTAINER = "container"

CONF_HIGH = "high"
CONF_MEDIUM = "medium"
CONF_LOW = "low"


def _ann_text(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover
        return ""


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


class ModuleImports:
    """Which names in this module mean `typing.X` and which mean `exp.X`."""

    def __init__(self, tree: ast.Module, relpath: str) -> None:
        self.typing_aliases: set[str] = set()
        self.exp_aliases: set[str] = set()
        self.typing_names: set[str] = set()
        self.exp_names: set[str] = set()
        self.in_expressions_pkg = relpath.startswith("sqlglot/expressions")

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "typing":
                        self.typing_aliases.add(alias.asname or "typing")
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if mod == "typing" or mod == "typing_extensions":
                    for alias in node.names:
                        self.typing_names.add(alias.asname or alias.name)
                elif mod.endswith("expressions") or mod == "sqlglot":
                    for alias in node.names:
                        if alias.name == "expressions":
                            self.exp_aliases.add(alias.asname or "expressions")
                        else:
                            self.exp_names.add(alias.asname or alias.name)

    def resolve(self, node: ast.AST) -> tuple[str, str] | None:
        """(namespace, name) for a Name/Attribute annotation head.

        namespace is 'typing', 'exp' or 'unknown'.
        """
        if isinstance(node, ast.Attribute):
            base = node.value
            if isinstance(base, ast.Name):
                if base.id in self.typing_aliases:
                    return ("typing", node.attr)
                if base.id in self.exp_aliases:
                    return ("exp", node.attr)
            return ("unknown", node.attr)
        if isinstance(node, ast.Name):
            if node.id in self.typing_names:
                return ("typing", node.id)
            if node.id in self.exp_names:
                return ("exp", node.id)
            if self.in_expressions_pkg:
                return ("exp", node.id)
            return ("unknown", node.id)
        return None


class ExprKnowledge:
    """What counts as an `Expr`, harvested from the pinned source."""

    def __init__(self, ref: str) -> None:
        self.ref = ref
        self.classes: set[str] = set()
        # name -> kind, for things whose *return annotation* is an Expr or a
        # container of Exprs. Harvested, never hardcoded.
        #
        # Split three ways, because a bare method name is ambiguous: `str.find`
        # collides with `Expr.find`, `str.join` with `exp.join`, and
        # `Generator.func` (returns str) with `exp.func` (returns Expr). Resolving
        # a call therefore needs to know what the *receiver* is.
        self.exp_func_kind: dict[str, str] = {}  # exp.foo(...)  — module level in expressions/
        self.expr_method_kind: dict[str, str] = {}  # <expr>.foo(...) — methods on Expr classes
        self.local_func_kind: dict[str, dict[str, str]] = {}  # per-module top-level defs
        self.prop_kind: dict[str, str] = {}  # properties on Expr classes
        self._build()

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

        for path in _walk_py(os.path.join(self.ref, "sqlglot")):
            tree = _parse(path)
            if tree is None:
                continue
            relpath = os.path.relpath(path, self.ref)
            imports = ModuleImports(tree, relpath)
            in_expressions = relpath.startswith("sqlglot/expressions")

            # Which FunctionDefs sit directly inside a class body, and which class.
            method_owner: dict[int, str] = {}
            for cls in ast.walk(tree):
                if isinstance(cls, ast.ClassDef):
                    for item in cls.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            method_owner[id(item)] = cls.name

            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                kind = self.annotation_kind(node.returns, imports)
                if kind is None:
                    continue
                decorators = {_ann_text(d) for d in node.decorator_list}
                owner = method_owner.get(id(node))

                if "property" in decorators or "cached_property" in decorators:
                    if owner in self.classes:
                        self.prop_kind.setdefault(node.name, kind)
                    continue

                if owner is None:
                    self.local_func_kind.setdefault(relpath, {}).setdefault(node.name, kind)
                    if in_expressions:
                        self.exp_func_kind.setdefault(node.name, kind)
                elif owner in self.classes:
                    self.expr_method_kind.setdefault(node.name, kind)

    # ------------------------------------------------------------ annotations

    def annotation_kind(self, node: ast.AST | None, imports: ModuleImports) -> str | None:
        """KIND_EXPR, KIND_CONTAINER, or None — with imports resolved properly."""
        if node is None:
            return None
        return self._kind(node, imports, depth=0)

    def _kind(self, node: ast.AST, imports: ModuleImports, depth: int) -> str | None:
        if depth > 8:
            return None

        # Forward reference: 'Expression'
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                try:
                    inner = ast.parse(node.value, mode="eval").body
                except SyntaxError:
                    return None
                return self._kind(inner, imports, depth + 1)
            return None

        # PEP 604: `Expr | None`
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return self._union_kind([node.left, node.right], imports, depth)

        if isinstance(node, ast.Subscript):
            head = imports.resolve(node.value)
            head_name = head[1] if head else ""
            args = _subscript_args(node)
            if head_name in UNION_HEADS:
                return self._union_kind(args, imports, depth)
            if head_name in OPAQUE_HEADS:
                return None
            if head_name in CONTAINER_HEADS:
                # A container is only interesting if it holds Exprs.
                for a in args:
                    if self._kind(a, imports, depth + 1) == KIND_EXPR:
                        return KIND_CONTAINER
                return None
            # e.g. `Select[...]`; treat the head itself
            return self._kind(node.value, imports, depth + 1)

        resolved = imports.resolve(node)
        if resolved is None:
            return None
        namespace, name = resolved
        if namespace == "typing":
            return None
        if name in ABSTRACT_EXPR_NAMES or name in self.classes:
            # A bare colliding name in a module that never imported it from
            # sqlglot.expressions is almost certainly the typing one.
            if namespace == "unknown" and name in CONTAINER_HEADS | OPAQUE_HEADS:
                return None
            return KIND_EXPR
        if name in CONTAINER_HEADS:
            return None
        return None

    def _union_kind(self, parts: list[ast.AST], imports: ModuleImports, depth: int) -> str | None:
        kinds = [self._kind(p, imports, depth + 1) for p in parts]
        if KIND_EXPR in kinds:
            return KIND_EXPR
        if KIND_CONTAINER in kinds:
            return KIND_CONTAINER
        return None

    def union_has_non_expr(self, node: ast.AST | None, imports: ModuleImports) -> bool:
        """True for `str | Expr` style annotations, where the value may not be an
        Expr at runtime. Those verdicts get downgraded to low confidence."""
        if node is None:
            return False
        text = _ann_text(node)
        if "ExpOrStr" in text:
            return True
        parts: list[ast.AST] = []
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            parts = [node.left, node.right]
        elif isinstance(node, ast.Subscript):
            head = imports.resolve(node.value)
            if head and head[1] in UNION_HEADS:
                parts = _subscript_args(node)
        for p in parts:
            if self._kind(p, imports, 0) is None and _ann_text(p) not in ("None",):
                return True
        return False


def _subscript_args(node: ast.Subscript) -> list[ast.AST]:
    sl = node.slice
    if isinstance(sl, ast.Tuple):
        return list(sl.elts)
    if isinstance(sl, ast.Index):  # pragma: no cover - py<3.9 shape
        return [sl.value]  # type: ignore[attr-defined]
    return [sl]


class ExprTyper:
    """Local, annotation-driven inference scoped to one function (or module) body.

    `classify(node)` returns `(kind, confidence, reason)` or None.
    """

    def __init__(
        self,
        knowledge: ExprKnowledge,
        imports: ModuleImports,
        scope: ast.AST,
        relpath: str = "",
    ) -> None:
        self.k = knowledge
        self.imports = imports
        self.relpath = relpath
        self.scope = scope
        self.names: dict[str, tuple[str, str, str]] = {}
        self.not_expr: set[str] = set()
        self._seed()
        for _ in range(3):
            if not self._propagate():
                break

    # ------------------------------------------------------------- seeding

    def _record(self, name: str, kind: str, conf: str, reason: str) -> None:
        if name not in self.names and name not in self.not_expr:
            self.names[name] = (kind, conf, reason)

    def _seed(self) -> None:
        node = self.scope
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
                self._seed_annotated(a.arg, a.annotation, "parameter")
            if args.vararg is not None:
                kind = self.k.annotation_kind(args.vararg.annotation, self.imports)
                if kind == KIND_EXPR:
                    # `*args: Expr` binds a tuple of Exprs, not an Expr
                    self._record(args.vararg.arg, KIND_CONTAINER, CONF_MEDIUM, "*args of Exprs")

        for sub in ast.walk(node):
            if isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Name):
                self._seed_annotated(sub.target.id, sub.annotation, "annotated")
            elif isinstance(sub, ast.For) and isinstance(sub.target, ast.Name):
                v = self.classify(sub.iter)
                if v is not None and v[0] == KIND_CONTAINER:
                    self._record(sub.target.id, KIND_EXPR, CONF_MEDIUM, "loop over a container of Exprs")

    def _seed_annotated(self, name: str, annotation: ast.AST | None, what: str) -> None:
        text = _ann_text(annotation)
        kind = self.k.annotation_kind(annotation, self.imports)
        if kind is None:
            if text in ("int", "str", "bool", "float", "bytes"):
                self.not_expr.add(name)
            return
        conf = CONF_HIGH
        if kind == KIND_EXPR and self.k.union_has_non_expr(annotation, self.imports):
            # `str | Expr` may hold a plain string at runtime.
            conf = CONF_LOW
        self._record(name, kind, conf, f"{what} annotated {text}")

    def _propagate(self) -> bool:
        changed = False
        for sub in ast.walk(self.scope):
            if not isinstance(sub, ast.Assign):
                continue
            verdict = self.classify(sub.value)
            if verdict is None:
                continue
            kind, conf, reason = verdict
            for target in sub.targets:
                if isinstance(target, ast.Name) and target.id not in self.names:
                    if target.id in self.not_expr:
                        continue
                    self.names[target.id] = (kind, conf, f"assigned from {reason}")
                    changed = True
        return changed

    # ---------------------------------------------------------- classifier

    def _classify_call(self, node: ast.Call) -> tuple[str, str, str] | None:
        """Resolve a call by looking at what it is called *on*.

        Without this, `span.find(q)` (str.find -> int) is read as `Expr.find`
        (-> Expr), and `self.func(...)` inside a Generator (-> str) is read as
        `exp.func` (-> Expr). Both produced false operator sites in the first run.
        """
        fn = node.func

        if isinstance(fn, ast.Attribute):
            resolved = self.imports.resolve(fn)
            in_exp_namespace = resolved is not None and resolved[0] == "exp"
            if in_exp_namespace:
                if fn.attr in self.k.classes and fn.attr not in CONTAINER_HEADS:
                    return (KIND_EXPR, CONF_HIGH, f"constructor exp.{fn.attr}(...)")
                kind = self.k.exp_func_kind.get(fn.attr)
                if kind is not None:
                    return (kind, CONF_MEDIUM, f"exp.{fn.attr}() returns {kind}")
                # exp.Literal.number(...) — attribute chain onto a class
                return None
            # A method call: only trust it if the receiver is itself an Expr.
            receiver = self.classify(fn.value)
            if receiver is not None and receiver[0] == KIND_EXPR:
                kind = self.k.expr_method_kind.get(fn.attr)
                if kind is not None:
                    return (kind, CONF_MEDIUM, f".{fn.attr}() returns {kind}")
            # exp.Literal.number(...) / exp.DataType.build(...)
            if isinstance(fn.value, ast.Attribute):
                inner = self.imports.resolve(fn.value)
                if inner and inner[0] == "exp" and inner[1] in self.k.classes:
                    return (KIND_EXPR, CONF_HIGH, f"{inner[1]}.{fn.attr}(...) builds an Expr")
            return None

        if isinstance(fn, ast.Name):
            name = fn.id
            if name in CONTAINER_HEADS or name in OPAQUE_HEADS:
                return None
            if name in self.k.classes and (
                name in self.imports.exp_names or self.imports.in_expressions_pkg
            ):
                return (KIND_EXPR, CONF_HIGH, f"constructor {name}(...)")
            # A bare call is only resolvable if this module imported it from
            # sqlglot.expressions or defines it itself.
            if name in self.imports.exp_names:
                kind = self.k.exp_func_kind.get(name)
                if kind is not None:
                    return (kind, CONF_MEDIUM, f"{name}() returns {kind}")
            local = self.k.local_func_kind.get(self.relpath, {})
            kind = local.get(name)
            if kind is not None:
                return (kind, CONF_MEDIUM, f"{name}() returns {kind}")
            return None

        return None

    def classify(self, node: ast.AST) -> tuple[str, str, str] | None:
        if isinstance(node, ast.Call):
            return self._classify_call(node)

        if isinstance(node, ast.Attribute):
            kind = self.k.prop_kind.get(node.attr)
            if kind is not None:
                return (kind, CONF_MEDIUM, f".{node.attr} is {kind}")
            if node.attr == "args":
                return (KIND_CONTAINER, CONF_MEDIUM, ".args is a dict of Exprs")
            return None

        if isinstance(node, ast.Name):
            if node.id in self.not_expr:
                return None
            return self.names.get(node.id)

        if isinstance(node, ast.Subscript):
            inner = self.classify(node.value)
            if inner is None:
                return None
            if inner[0] == KIND_CONTAINER:
                if isinstance(node.slice, ast.Slice):
                    return (KIND_CONTAINER, inner[1], f"slice of {inner[2]}")
                return (KIND_EXPR, inner[1], f"element of {inner[2]}")
            # subscripting an Expr is Expr.__getitem__ -> Bracket
            return (KIND_EXPR, inner[1], "Bracket from Expr.__getitem__")

        if isinstance(node, ast.BinOp):
            for side in (node.left, node.right):
                v = self.classify(side)
                if v is not None and v[0] == KIND_EXPR:
                    return (KIND_EXPR, v[1], f"BinOp over {v[2]}")
            return None

        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.Invert)):
            v = self.classify(node.operand)
            if v is not None and v[0] == KIND_EXPR:
                return (KIND_EXPR, v[1], f"UnaryOp over {v[2]}")
            return None

        if isinstance(node, ast.IfExp):
            for side in (node.body, node.orelse):
                v = self.classify(side)
                if v is not None:
                    return (v[0], CONF_LOW, f"conditional yielding {v[2]}")
            return None

        if isinstance(node, ast.BoolOp):
            for side in node.values:
                v = self.classify(side)
                if v is not None:
                    return (v[0], CONF_LOW, f"and/or yielding {v[2]}")
            return None

        if isinstance(node, (ast.List, ast.ListComp, ast.GeneratorExp, ast.SetComp)):
            return None

        return None


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


_LINE_CACHE: dict[str, list[str]] = {}


def source_line(path: str, lineno: int) -> str:
    lines = _LINE_CACHE.get(path)
    if lines is None:
        try:
            lines = open(path, encoding="utf-8").read().splitlines()
        except OSError:
            lines = []
        _LINE_CACHE[path] = lines
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1].strip()
    return ""


def sqlglot_files(ref: str) -> list[str]:
    return sorted(_walk_py(os.path.join(ref, "sqlglot")))


def is_executor(relpath: str) -> bool:
    """sqlglot's executor is permanently out of scope (PORT_PLAN.md §1), so
    executor hits are counted separately rather than dropped."""
    return relpath.startswith("sqlglot/executor/")
