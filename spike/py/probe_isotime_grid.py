#!/usr/bin/env python3
"""Dense grid over time-portion strings, with and without a trailing timezone,
so the C accelerator's actual rule can be read off rather than guessed."""

import datetime
import itertools

ALPHA = "12:."


def try_time(s):
    try:
        t = datetime.time.fromisoformat(s)
        return f"{t.hour:02d}:{t.minute:02d}:{t.second:02d}.{t.microsecond:06d}"
    except Exception:  # noqa: BLE001
        return None


print("time portion T -> fromisoformat(T)  /  fromisoformat(T + '+00:00')")
print(f"{'T':<12}{'bare':<20}{'with tz':<20}")
print("-" * 52)
seen = []
for n in range(1, 8):
    for tup in itertools.product(ALPHA, repeat=n):
        s = "".join(tup)
        bare = try_time(s)
        withtz = try_time(s + "+00:00")
        if bare is None and withtz is None:
            continue
        seen.append((s, bare, withtz))
        print(f"  {s:<12}{str(bare):<20}{str(withtz):<20}")

print(f"\n{len(seen)} accepted forms")

# Isolate the specific asymmetry: which T are rejected bare but accepted with tz?
print("\nrejected bare, accepted with tz:")
for s, bare, withtz in seen:
    if bare is None and withtz is not None:
        print(f"  {s!r:<14} -> {withtz}")
