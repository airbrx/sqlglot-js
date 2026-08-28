// py: the slice of the `logging` module sqlglot actually uses.
//
// `parser.py:38` is `logger = logging.getLogger("sqlglot")`, and the parser calls
// `logger.warning(...)` (the Command fallback) and `logger.error(...)` (ErrorLevel.WARN).
// Nothing else in the parse path touches logging.
//
// This exists as a real module rather than `console.warn` because the log line is an
// ASSERTED OUTPUT, not diagnostics: `tests/dialects/test_dialect.py:57-59` wraps
// `parse_one` in `assertLogs(parser_logger)` and asserts
//
//     f"'{sql[:100]}' contains unsupported syntax" in cm.output[0]
//
// for 18 SQLs across the dialect suites. `cm.output` entries are formatted by
// `logging.LogRecord` as `f"{levelname}:{name}:{message}"`, which `record()` reproduces
// byte-for-byte so the port can assert exactly what upstream asserts.

/** py: logging.LogRecord rendering used by `assertLogs` — LEVEL:name:message. */
export function formatRecord(level, name, message) {
  return `${level}:${name}:${message}`;
}

/**
 * Capture sinks. Empty by default, in which case records go to `console.error` the way
 * Python's last-resort handler writes to stderr. A sink returning nothing suppresses
 * nothing — capturing and printing are independent, exactly like `assertLogs`, which
 * installs a handler rather than muting the logger.
 */
const sinks = new Set();

/**
 * py: `unittest.TestCase.assertLogs` — collect the records emitted by `fn()`.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{output: string[], result: T}} `output` in `assertLogs`'s exact format
 */
export function captureLogs(fn) {
  const output = [];
  const sink = (line) => output.push(line);
  sinks.add(sink);
  try {
    return { output, result: fn() };
  } finally {
    sinks.delete(sink);
  }
}

class Logger {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  _emit(level, message) {
    const line = formatRecord(level, this.name, message);
    if (sinks.size) {
      for (const sink of sinks) sink(line);
      return;
    }
    // py: `logging.lastResort` writes WARNING and above to stderr with no formatting
    // beyond the message itself.
    console.error(message);
  }

  warning(message) {
    this._emit("WARNING", message);
  }

  error(message) {
    this._emit("ERROR", message);
  }
}

const loggers = new Map();

/** py: logging.getLogger(name) — one instance per name, as Python's registry does. */
export function getLogger(name) {
  let l = loggers.get(name);
  if (!l) {
    l = new Logger(name);
    loggers.set(name, l);
  }
  return l;
}

// py: parser.py:38 / generator.py — the single "sqlglot" logger both modules share.
export const logger = getLogger("sqlglot");
