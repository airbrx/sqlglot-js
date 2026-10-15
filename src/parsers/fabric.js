// py: sqlglot/parsers/fabric.py @ 91119bc
//
// `class FabricParser(TSQLParser)` — small and self-contained, extending the
// already-real `TSQLParser` (src/parsers/tsql.js) at a single link. AIR-2292,
// "12.7 Small dialects", batch A. No `sqlglot/typing/fabric.py` exists upstream.

import * as exp from "../expressions/index.js";
import { TSQLParser } from "./tsql.js";

/** py: sqlglot/parsers/fabric.py:7 */
export class FabricParser extends TSQLParser {
  /** py: sqlglot/parsers/fabric.py:8 */
  _parse_create() {
    const create = super._parse_create();

    if (create instanceof exp.Create) {
      // Transform VARCHAR/CHAR without precision to VARCHAR(1)/CHAR(1)
      if (create.kind === "TABLE" && create.this instanceof exp.Schema) {
        for (const column of create.this.expressions) {
          if (column instanceof exp.ColumnDef) {
            const column_type = column.kind;
            if (
              column_type instanceof exp.DataType
              && (column_type.this === exp.DType.VARCHAR || column_type.this === exp.DType.CHAR)
              && !column_type.expressions.length
            ) {
              // Add default precision of 1 to VARCHAR/CHAR without precision
              // When n isn't specified in a data definition or variable declaration statement, the default length is 1.
              // https://learn.microsoft.com/en-us/sql/t-sql/data-types/char-and-varchar-transact-sql?view=sql-server-ver17#remarks
              column_type.set("expressions", [exp.Literal.number("1")]);
            }
          }
        }
      }
    }

    return create;
  }
}
