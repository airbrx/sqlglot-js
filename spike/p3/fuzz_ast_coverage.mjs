// Strict full-population production AST parity, not pre-P5 dialect impersonation.
// The incremental merge gate is p5/fuzz_dialect_parse.mjs; this diagnostic remains
// red until ALL rows pass. Missing AST rows are ERROR, never denominator omissions.
import { main } from '../../tools/differential_rows.mjs';
if (!process.argv.includes('--strict')) process.argv.push('--strict');
main('parse');
