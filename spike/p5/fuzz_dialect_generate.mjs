// The real production generator, all corpus rows, SQL AND warning parity.
// See tools/differential_rows.mjs; missing AST references are infrastructure errors.
import { main } from '../../tools/differential_rows.mjs';
main('generate');
