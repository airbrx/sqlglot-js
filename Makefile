# PORT_PLAN.md §3.1 ("regenerable by `make corpus`"), §8.1 ("installed by `make setup`").
SHELL := /bin/bash
REF ?= /tmp/sqlglot-ref

.PHONY: help corpus accept-corpus codegen parity check probes lint ratchet resync sync snapshot clean

help:
	@grep -E '^[a-z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t24

# Codex review, PR #1: this target used to end with an unconditional `node test/runner.mjs
# --baseline`, which replaced the ratchet's accepted baseline (and provenance) in the SAME
# step that re-harvested it. That left rule 5 -- whose entire job is to hard-fail on a KNOWN
# input whose expectation CHANGED -- no previous baseline left to compare against by the
# time anyone could look. `corpus` now only regenerates; `make resync` (against the OLD
# baseline, still on disk) is the review step; `make accept-corpus` is the explicit human
# act of replacing the baseline, run only after `resync` has been read.
# PYTHONHASHSEED=0: found while validating the corpus determinism fix above -- upstream's
# Union/SetOperation args dict order (limit vs order, observed in corpus/ast/*.jsonl) is
# NOT purely token-order-driven; it flips between "order,limit" and "limit,order" across
# fresh interpreter processes with the default (random) hash seed, and is stable for a
# given seed (verified: 4 fresh processes, seed unset -> 2/2 split; seed=0 x3 -> identical;
# seed=42 x2 -> identical, but different from seed=0). Root cause not fully isolated
# (upstream _parse_query_modifiers itself sets args in strict token order, so the
# reordering happens somewhere else in construction/copy) but the fix does not depend on
# knowing it: pin the seed so `corpus/ast` and `corpus/gen` are byte-reproducible, since
# P1+ will diff a JS parser's arg order against these files as an oracle.
corpus: ## re-harvest atoms + both oracles + parity snapshots (needs python3 + $(REF))
	PYTHONHASHSEED=0 python3 tools/harvest/harvest.py --ref $(REF)
	PYTHONHASHSEED=0 python3 tools/astdump.py --ref $(REF)
	PYTHONHASHSEED=0 SQLGLOT_REF=$(REF) python3 tools/parity/extract.py
	PYTHONHASHSEED=0 SQLGLOT_REF=$(REF) python3 tools/tokens/extract_settings.py
	PYTHONHASHSEED=0 SQLGLOT_REF=$(REF) python3 tools/tokens/harvest_streams.py
	PYTHONHASHSEED=0 python3 tools/sync_report.py --ref $(REF) --snapshot

accept-corpus: ## explicit acceptance step -- run AFTER reviewing `make resync` output
	node test/runner.mjs --baseline

codegen: ## regenerate src/_gen (CI asserts `git diff --exit-code src/_gen` after this)
	python3 spike/py/gen_unicode_ref.py > spike/out/unicode_ref.json
	node tools/gen_unicode_tables.mjs
	node tools/gen_timezones.mjs $(REF)

parity: ## run the 6 parity probes
	node tools/parity/check.mjs

ratchet: ## run the corpus through the library and apply the ratchet
	node test/runner.mjs

resync: ## classify a new corpus against the accepted baseline (rules 4 and 5)
	node test/runner.mjs --resync

sync: ## upstream method manifest diff -> the work-item generator (§3.7)
	python3 tools/sync_report.py --ref $(REF)

snapshot: ## accept the current upstream manifest as the baseline
	python3 tools/sync_report.py --ref $(REF) --snapshot

lint: ## the checkable CI gates that exist today
	node tools/lint_license.mjs
	node tools/lint_unicode.mjs
	node tools/lint_control_bytes.mjs
	node tools/check_corpus.mjs

check: ## every self-test (no corpus regeneration)
	node tools/closure.mjs --selftest
	node tools/ratchet.mjs --selftest
	node test/runner.mjs --selftest
	python3 tools/sync_report.py --selftest

probes: ## full differential suite from a clean tree (regenerates spike corpora)
	bash spike/run_all.sh

clean:
	rm -rf spike/out
