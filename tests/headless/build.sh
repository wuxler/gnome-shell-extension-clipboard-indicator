#!/bin/bash
# Stages the extension into tests/headless/build/ (the file set of
# `make install`, without recompiling translations: the .mo files are
# tracked in git).
set -e
H=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$H/../.." && pwd)
cd "$R"
glib-compile-schemas --strict --targetdir=schemas/ schemas
rm -rf "$H/build"; mkdir -p "$H/build"
cp -r --parents *.js locale/*/LC_MESSAGES/*.mo metadata.json stylesheet*.css icons/ LICENSE.rst README.md schemas/ "$H/build"
