// Corpus-only adapter over the PRODUCTION package entry point. The public
// transpile API returns string[], not warnings. Validator/harvest use parse_one
// (a Block for multiple statements, __init__.py:134-165), then one generator.
export function createCorpusAdapter(library) {
  for (const name of ['parse', 'transpile', 'Dialect', 'exp', 'ErrorLevel', 'UnsupportedError']) {
    if (!library[name]) throw new Error(`Production library missing export: ${name}`);
  }
  return (sql, options = {}) => {
    const { read = null, write, pretty = false, identify = false, raises = false } = options;
    // Omitted write follows the public API default. Explicit "" is BASE, not read.
    const target = write === undefined || write === null ? read : write;
    let generator;
    try {
      const expressions = library.parse(sql, { read });
      if (!Array.isArray(expressions) || !expressions.length || !expressions[0]) {
        throw new Error('Corpus parse produced no expression');
      }
      // Do not use this port's currently first-only parseOne wrapper. Mirror the
      // pinned Validator contract through real parse + real Block + real generate.
      const expression = expressions.length > 1 ? new library.exp.Block({ expressions }) : expressions[0];
      generator = library.Dialect.get_or_raise(target).generator({
        pretty, identify, unsupported_level: raises ? library.ErrorLevel.RAISE : library.ErrorLevel.IGNORE,
      });
      const output = generator.generate(expression);
      return { sql: output, unsupportedMessages: [...generator.unsupported_messages] };
    } catch (error) {
      return { error, unsupportedMessages: [...(generator?.unsupported_messages || [])] };
    }
  };
}
