// py: Python's built-in exception types.
//
// PORT_PLAN.md §8.2 item 6 (the error contract in CONTRACTS.md). sqlglot catches
// specific builtins in several load-bearing places — `helper.is_type` catches
// ValueError only, `time.subsecond_precision` catches ValueError only, and
// `Literal.number` catches bare Exception — so the *type* is observable behaviour,
// not just a message. A port that throws a generic Error either swallows too much
// or too little.

export class PyException extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** py: ValueError */
export class PyValueError extends PyException {}

/** py: TypeError */
export class PyTypeError extends PyException {}

/** py: IndexError */
export class PyIndexError extends PyException {}

/** py: KeyError */
export class PyKeyError extends PyException {}

/** py: StopIteration */
export class PyStopIteration extends PyException {}

/** py: OverflowError */
export class PyOverflowError extends PyException {}

/** py: AssertionError -- raised by a bare `assert` statement when its condition is falsy. */
export class PyAssertionError extends PyException {}
