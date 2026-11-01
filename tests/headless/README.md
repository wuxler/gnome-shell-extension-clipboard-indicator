# Headless tests

Runs GNOME Shell headless in an isolated environment (own config, data,
cache and runtime dirs, keyfile GSettings backend) so the real session is
never touched, loads the extension plus the `ci-test@local` driver, and
prints one line per check.

```bash
pip install pillow                      # only needed for seed.py
./seed.py ./seed-50 50 30               # 50 large PNGs + 30 text entries
./build.sh
./run.sh empty - - - 1 60               # empty cache
./run.sh seeded - - ./seed-50 1 90      # large image history
ALLEXT=1 ./run.sh real - - ./seed-50 1 90   # plus all of your extensions
```

Output: `started=1` means GNOME Shell finished its startup sequence;
`alloc` counts "needs an allocation" warnings, the symptom of the
startup stall this fork fixes. `CI-TEST PASS|FAIL ...` lines come from
`ci-test@local/extension.js`. Logs and screenshots are in `runs/<tag>/`.
