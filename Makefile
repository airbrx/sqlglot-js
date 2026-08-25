# PORT_PLAN.md §3.1 ("regenerable by `make corpus`"), §8.1 ("installed by `make setup`").
SHELL := /bin/bash
REF ?= /tmp/sqlglot-ref

.PHONY: help corpus codegen parity check probes lint ratchet resync sync snapshot clean

help:
	@grep -E '^[a-z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t24

corpus: ## re-harvest atoms + both oracles + parity snapshots (needs python3 + $(REF))
	python3 tools/harvest/harvest.py --ref $(REF)
	python3 tools/astdump.py --ref $(REF)
	python3 tools/parity/extract.py
	python3 tools/sync_report.py --ref $(REF) --snapshot
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
