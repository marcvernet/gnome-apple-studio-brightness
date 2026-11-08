#!/bin/bash
# Run all standalone test suites against extension/impl.js.
set -euo pipefail
cd "$(dirname "$0")"
export ASD_ROOT="$(cd .. && pwd)"
export GSETTINGS_SCHEMA_DIR="$ASD_ROOT/extension/schemas"
# Keep the suites from writing their test settings into the user's real dconf.
export GSETTINGS_BACKEND=memory

[ -f "$GSETTINGS_SCHEMA_DIR/gschemas.compiled" ] || \
    glib-compile-schemas "$GSETTINGS_SCHEMA_DIR"

status=0
for t in test-spawn test-usbtgt test-scale test-impl; do
    echo "=== $t"
    if ! timeout 60 gjs -m "$ASD_ROOT/tests/$t.mjs"; then
        status=1
    fi
done
exit $status
