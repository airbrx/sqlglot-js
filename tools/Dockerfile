# Verification toolchain. PORT_PLAN.md §5.2.
#
# The RUNTIME artifact has zero dependencies. This image exists only to run upstream's
# test suite and regenerate the corpus.
#
# The important design point (§5.2, correcting an earlier draft): this image is built
# from the pinned upstream tag's OWN declared `requires-python`, NOT from a version we
# choose. Pinning a CPython of our own would protect today's corpus and destroy upstream
# tracking — the thing we were actually asked for. When upstream's floor moves, the
# build fails loudly with the floor change rather than silently emitting a stale corpus.
#
#   docker build -f tools/Dockerfile -t sqlglot-js-toolchain \
#     --build-arg UPSTREAM_COMMIT=91119bc .
#   docker run --rm -v "$PWD:/work" sqlglot-js-toolchain make corpus

ARG PYTHON_VERSION=3.9.25
FROM python:${PYTHON_VERSION}-slim

ARG UPSTREAM_REPO=https://github.com/tobymao/sqlglot.git
ARG UPSTREAM_COMMIT=91119bc
ARG NODE_MAJOR=22

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg jq \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Read-only reference clone at the pin.
RUN git clone --filter=blob:none "${UPSTREAM_REPO}" /tmp/sqlglot-ref \
 && git -C /tmp/sqlglot-ref checkout --quiet "${UPSTREAM_COMMIT}"

# §5.2: fail loudly if upstream's floor has moved past the interpreter in this image.
# `requires-python` is upstream's declaration, so this compares the image against the
# pin's own requirement rather than against a number we picked.
RUN set -eu; \
    declared="$(grep -m1 -E '^\s*requires-python' /tmp/sqlglot-ref/pyproject.toml \
                | sed -E 's/.*>=\s*([0-9]+\.[0-9]+).*/\1/')"; \
    have="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"; \
    echo "upstream requires-python >= ${declared}; image has ${have}"; \
    python3 - "$declared" "$have" <<'PY'
import sys
declared, have = sys.argv[1], sys.argv[2]
d = tuple(int(x) for x in declared.split("."))
h = tuple(int(x) for x in have.split("."))
if h < d:
    sys.exit(
        f"toolchain Python floor moved {have} -> {declared}; "
        "rebuild with --build-arg PYTHON_VERSION=<new floor> and RE-HARVEST "
        "(corpus/PROVENANCE.json records the interpreter, and the runner hard-fails "
        "on a mismatch without --rebaseline)"
    )
PY

# Record what this image actually is, so PROVENANCE mismatches are diagnosable.
RUN python3 -c "import sys, unicodedata, json; \
    print(json.dumps({'python_version': sys.version.split()[0], \
                      'unidata_version': unicodedata.unidata_version}))" \
    > /toolchain.json

WORKDIR /work
ENV SQLGLOT_REF=/tmp/sqlglot-ref
CMD ["bash"]
