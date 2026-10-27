import test from "node:test";
import assert from "node:assert/strict";
import { addLogSink, removeLogSink, parseOne } from "../index.js";

test("R125: addLogSink routes the Command-fallback warning to the embedder and silences console.error", () => {
  const lines = [];
  const errors = [];
  const origError = console.error;
  console.error = (m) => errors.push(m);
  const remove = addLogSink((line) => lines.push(line));
  try {
    parseOne("SET search_path TO a, b", { read: "postgres" });
  } finally {
    remove();
    console.error = origError;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARNING:sqlglot:'SET search_path TO a, b' contains unsupported syntax/);
  assert.deepEqual(errors, [], "nothing reaches console.error while a sink is installed");

  // After removal the last-resort path is back.
  console.error = (m) => errors.push(m);
  try {
    parseOne("SET search_path TO a, b", { read: "postgres" });
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1);
  assert.equal(lines.length, 1, "a removed sink receives nothing");
  removeLogSink(() => {}); // removing an unknown sink is a no-op
});
