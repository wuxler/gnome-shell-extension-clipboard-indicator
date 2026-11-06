#!/bin/bash
# Runs an isolated headless gnome-shell with one extension under test.
#
# Usage: run.sh <tag> [ext_dir] [uuid] [seed_dir|-] [with_ci_test 0|1] [timeout_s] [extra keyfile lines]
#   ext_dir defaults to ./build (see build.sh), uuid to this fork's uuid.
#
# Environment:
#   ALLEXT=1         also install every extension from ~/.local/share and the
#                    user's enabled list and extension settings (realistic load)
#   SKIPEXT="a b"    with ALLEXT, leave these uuids out
#   NOREWRITE=1      keep the seed registry's original image paths
#   CI_PREFS_ONLY=u  only open the preferences of extension u
#   CI_SCENARIO=s    run driver scenario s instead of the main one (see
#                    ci-test@local/extension.js)
#   CORRUPT=1        replace the seeded registry.txt with invalid JSON
#   EXTRA_EXT=d:u    also install extension dir d as uuid u
#   ENABLE_ONLY="'a', 'b'"  enabled-extensions at startup (gvariant items)
#   EXPECT_EXT_ERRORS=1  the scenario provokes errors by design (e.g.
#                    corrupt); do not fail on errors logged by the extension
#
#   CI_MEMORY_MAX=3G memory limit of the run's systemd scope
#
# Exit status: 0 only if the shell finished starting, nothing in the run's
# scope was OOM-killed and, with the test
# driver, the driver reported "END ... fail=0" and the extension under test
# logged no errors.
#
# Config, data and cache dirs point into runs/<tag>/ and GSettings uses the
# keyfile backend, so the user's real dconf, extensions and cache are untouched.
set -u
H=$(cd "$(dirname "$0")" && pwd)
TAG=$1; EXT=${2:--}; UUID=${3:--};
[ "$EXT" = - ] && EXT=$H/build
[ "$UUID" = - ] && UUID=clipboard-indicator@wuxler.github.io
 SEED=${4:--}; WITHTEST=${5:-0}; TO=${6:-25}; EXTRA=${7:-}
T=$H/runs/$TAG
# Private runtime dir: the shell writes its crash-protection marker and
# Wayland socket there, which must not touch the real session's files. It
# lives under the real runtime dir because socket paths are limited to 108
# bytes, too short for a path inside the repository.
RT=/run/user/$(id -u)/ci-headless-$TAG
rm -rf "$T" "$RT"; mkdir -p "$T/config/glib-2.0/settings" "$T/data/gnome-shell/extensions" "$T/cache" "$RT"
chmod 700 "$RT"
cp -r "$EXT" "$T/data/gnome-shell/extensions/$UUID"
exts="'$UUID'"
EXTRA_KF=""
if [ "${ALLEXT:-0}" = 1 ]; then
  # Mirror the real setup: every user extension plus the real enabled list,
  # with the original clipboard-indicator replaced by the extension under test.
  for d in "$HOME"/.local/share/gnome-shell/extensions/*; do
    b=$(basename "$d"); [ "$b" = clipboard-indicator@tudmotu.com ] && continue
    [ "$b" = "$UUID" ] && continue
    case " ${SKIPEXT:-} " in *" $b "*) continue;; esac
    cp -r "$d" "$T/data/gnome-shell/extensions/"
  done
  exts=$(gsettings get org.gnome.shell enabled-extensions | tr -d '[]' | sed "s/'clipboard-indicator@[^']*'/'$UUID'/")
  for x in ${SKIPEXT:-}; do exts=$(echo "$exts" | sed -E "s/, *'$x'//; s/'$x', *//"); done
  # dconf dump paths are relative; the keyfile backend needs full paths.
  # This extension's own settings are left out so the test controls them.
  EXTRA_KF=$(dconf dump /org/gnome/shell/extensions/ | python3 -c "
import re, sys
skip = False
for line in sys.stdin:
    m = re.match(r'^\\[(.*)\\]\\s*$', line)
    if m:
        name = m.group(1)
        skip = name.startswith('clipboard-indicator')
        if skip: continue
        line = '[org/gnome/shell/extensions]\\n' if name == '/' else f'[org/gnome/shell/extensions/{name}]\\n'
    if not skip: sys.stdout.write(line)
")
fi
if [ "$WITHTEST" = 1 ]; then
  cp -r "$H/ci-test@local" "$T/data/gnome-shell/extensions/"
  exts="$exts, 'ci-test@local'"
fi
if [ -n "${EXTRA_EXT:-}" ]; then
  cp -r "${EXTRA_EXT%%:*}" "$T/data/gnome-shell/extensions/${EXTRA_EXT##*:}"
fi
[ -n "${ENABLE_ONLY:-}" ] && exts="$ENABLE_ONLY"
if [ "$SEED" != - ]; then
  D="$T/cache/$UUID"; mkdir -p "$D"; cp "$SEED"/* "$D/"
  # NOREWRITE=1 keeps the seed's original image paths (another directory),
  # as in a cache copied over from the upstream extension.
  [ "${NOREWRITE:-0}" = 1 ] || python3 - "$D" <<'PY'
import json, os, sys
d = sys.argv[1]; p = os.path.join(d, 'registry.txt')
reg = json.load(open(p))
for e in reg:
    if e['mimetype'].startswith('image/'):
        e['contents'] = os.path.join(d, os.path.basename(e['contents']))
json.dump(reg, open(p, 'w'))
PY
  [ "${CORRUPT:-0}" = 1 ] && printf '[{"favorite": false, "mimetype": "image/png", "conte' > "$D/registry.txt"
fi
cat > "$T/config/glib-2.0/settings/keyfile" <<KF
[org/gnome/shell]
enabled-extensions=[$exts]
disable-user-extensions=false

[org/gnome/shell/extensions/clipboard-indicator]
history-size=5000
cache-images=true
notify-on-copy=false
$EXTRA

$EXTRA_KF
KF
# Everything the test shell starts runs in its own transient systemd scope:
# - MemoryMax caps the run (default 3G, override with CI_MEMORY_MAX) and
#   MemorySwapMax=0 keeps it from pushing the rest of the system into swap,
#   so a runaway process is OOM-killed inside the scope;
# - stopping the scope afterwards kills whatever the shell left behind.
#   Children such as ibus-daemon can outlive dbus-run-session; orphaned
#   ibus-daemons once grew to 18 GB in total and froze the machine.
UNIT="ci-headless-$TAG-$$"
CG=""
stop_scope () {
  systemctl --user stop "$UNIT.scope" 2>/dev/null || true
  systemctl --user reset-failed "$UNIT.scope" 2>/dev/null || true
  rm -rf "$RT"
}
trap stop_scope EXIT

start=$(date +%s.%N)
systemd-run --user --scope --quiet --collect --unit="$UNIT" \
    -p MemoryMax="${CI_MEMORY_MAX:-3G}" -p MemorySwapMax=0 \
  env XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_CACHE_HOME="$T/cache" \
    GSETTINGS_BACKEND=keyfile XDG_RUNTIME_DIR="$RT" WAYLAND_DISPLAY="wl-ci-$TAG" GDK_BACKEND=wayland CI_SHOT="$T/menu.png" CI_SEEDED=$([ "$SEED" != - ] && echo 1 || echo 0) \
    timeout "$TO" dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 \
    --wayland --wayland-display="wl-ci-$TAG" > "$T/shell.log" 2>&1

# Processes still alive after the shell exited, and OOM kills in the scope.
CG=$(systemctl --user show -P ControlGroup "$UNIT.scope" 2>/dev/null)
leftover=0; oom_kills=0
if [ -n "$CG" ] && [ -d "/sys/fs/cgroup$CG" ]; then
  leftover=$(wc -l < "/sys/fs/cgroup$CG/cgroup.procs")
  [ "$leftover" -gt 0 ] && ps -o pid=,rss=,args= -p "$(paste -sd, "/sys/fs/cgroup$CG/cgroup.procs")" > "$T/leftover.txt" 2>/dev/null
  # The scope may be collected between the checks above and this read.
  oom_kills=$(awk '$1 == "oom_kill" {print $2}' "/sys/fs/cgroup$CG/memory.events" 2>/dev/null)
fi
# The scope is garbage-collected once its last process exits, so OOM kills
# are also counted from the journal.
oom_journal=$(journalctl --user -u "$UNIT.scope" -o cat --since "@${start%.*}" 2>/dev/null | grep -c 'killed by the OOM killer')
[ "$oom_journal" -gt "${oom_kills:-0}" ] && oom_kills=$oom_journal
stop_scope
# Startup duration: from launch to the "GNOME Shell started" message (wall clock).
t_started=$(grep -m1 'GNOME Shell started' "$T/shell.log" | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}' | head -1)
dur=-
if [ -n "$t_started" ]; then
  dur=$(python3 -c "import sys,datetime as d; s=d.datetime.fromtimestamp(float(sys.argv[1])); h,m,x=sys.argv[2].split(':'); t=s.replace(hour=int(h),minute=int(m),second=int(float(x)),microsecond=int(round(float(x)%1*1e6))); print(f'{(t-s).total_seconds():.1f}s')" "$start" "$t_started")
fi
started=$(grep -c 'GNOME Shell started' "$T/shell.log")
# Errors attributed to the extension under test (stack frames or messages).
# Errors the driver provokes on purpose are bracketed by
# EXPECTED-ERRORS-BEGIN/END markers and not counted.
ext_errors=$(awk '/CI-TEST EXPECTED-ERRORS-BEGIN/{skip=1} /CI-TEST EXPECTED-ERRORS-END/{skip=0; next} !skip' "$T/shell.log" |
  grep -cE "Extension $UUID:|Clipboard Indicator: (Failed|failed)|$UUID/[a-zA-Z]+\.js:[0-9]+:[0-9]+")
disposed=$(grep -cE 'already disposed|impossible to access it' "$T/shell.log")
echo "$TAG: startup=$dur started=$started alloc=$(grep -c 'needs an allocation' "$T/shell.log") js_errors=$(grep 'JS ERROR' "$T/shell.log" | grep -vc 'Xwayland exited') ext_errors=$ext_errors disposed=$disposed leftover=$leftover oom_kills=$oom_kills"
grep -E 'CI-TEST' "$T/shell.log" | sed 's/.*CI-TEST/CI-TEST/'

[ "$started" -ge 1 ] || exit 1
[ "${oom_kills:-0}" -eq 0 ] || exit 1
if [ "$WITHTEST" = 1 ]; then
  grep -qE 'CI-TEST END pass=[0-9]+ fail=0$' "$T/shell.log" || exit 1
  [ "$disposed" -eq 0 ] || exit 1
  [ "${EXPECT_EXT_ERRORS:-0}" = 1 ] || [ "$ext_errors" -eq 0 ] || exit 1
fi
exit 0
