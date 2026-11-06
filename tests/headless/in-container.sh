#!/bin/bash
# Runs the headless tests inside a throwaway container of a distribution that
# ships the GNOME version under test. Start it as root, with the repository
# mounted read-only and a memory limit on the container:
#
#   docker run --rm --memory=3g --memory-swap=3g \
#     -v "$PWD:/src:ro" -v /tmp/ci-results:/results \
#     fedora:44 /src/tests/headless/in-container.sh
#
# Scenarios: CI_SCENARIOS (default "empty seeded visual-light visual-dark
# corrupt"). Logs and screenshots are copied to /results when it is mounted.
set -u
if [ "$(id -u)" = 0 ]; then
  if command -v gnome-shell >/dev/null; then
    : # image with the packages already installed
  elif command -v dnf >/dev/null; then
    dnf -q -y install --setopt=install_weak_deps=False gnome-shell dbus-daemon \
      mesa-dri-drivers glib2-devel python3 python3-pillow which procps-ng \
      adwaita-icon-theme glibc-langpack-en >/dev/null || exit 2
  else
    export DEBIAN_FRONTEND=noninteractive
    { apt-get -qq update && apt-get -qq -y install --no-install-recommends gnome-shell \
        dbus libglib2.0-dev-bin libglib2.0-bin python3 python3-pil procps \
        libgl1-mesa-dri adwaita-icon-theme gnome-shell-extension-prefs; } >/dev/null || exit 2
  fi
  mkdir -p /run/dbus && rm -f /run/dbus/pid && dbus-daemon --system --fork
  # No logind in the container: without this directory the shell uses its
  # dummy login manager instead of failing to start on the missing D-Bus name.
  rm -rf /run/systemd/seats
  # Mutter aborts when it cannot create its X11 sockets here.
  install -d -m 1777 /tmp/.X11-unix
  id ci >/dev/null 2>&1 || useradd -m ci
  install -d -o ci -m 700 "/run/user/$(id -u ci)"
  # The results mount belongs to whoever started the container.
  [ -d /results ] && chmod 777 /results
  exec runuser -u ci -- env -i PATH="$PATH" HOME=/home/ci LANG=C.UTF-8 \
    CI_SCENARIOS="${CI_SCENARIOS:-}" bash "$0"
fi

rm -rf "$HOME/repo"; cp -r /src "$HOME/repo" && cd "$HOME/repo/tests/headless" || exit 2
rm -rf runs build seed-50
gnome-shell --version
./build.sh || exit 2

rc=0
run () { "$@" || { echo "FAILED: $*"; rc=1; }; }
LIGHT=$'\n[org/gnome/desktop/interface]\ncolor-scheme=\'prefer-light\''
DARK=$'\n[org/gnome/desktop/interface]\ncolor-scheme=\'prefer-dark\''
for s in ${CI_SCENARIOS:-empty seeded visual-light visual-dark corrupt}; do
  case $s in
    empty)        run env CI_NO_SCOPE=1 ./run.sh empty - - - 1 120 ;;
    seeded)       [ -d seed-50 ] || ./seed.py ./seed-50 50 30 >/dev/null
                  run env CI_NO_SCOPE=1 ./run.sh seeded - - ./seed-50 1 180 ;;
    visual-light) run env CI_NO_SCOPE=1 CI_SCENARIO=visual ./run.sh visual-light - - - 1 90 "$LIGHT" ;;
    visual-dark)  run env CI_NO_SCOPE=1 CI_SCENARIO=visual ./run.sh visual-dark - - - 1 90 "$DARK" ;;
    corrupt)      [ -d seed-50 ] || ./seed.py ./seed-50 50 30 >/dev/null
                  run env CI_NO_SCOPE=1 CI_SCENARIO=corrupt CORRUPT=1 EXPECT_EXT_ERRORS=1 ./run.sh corrupt - - ./seed-50 1 120 ;;
    none) ;;
    *) echo "unknown scenario $s"; rc=1 ;;
  esac
done
[ -d /results ] && cp -r runs/. /results/ 2>/dev/null
echo "in-container: rc=$rc"
exit $rc
