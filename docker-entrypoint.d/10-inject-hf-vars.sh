#!/bin/sh
# Substitute the HF Space OAuth runtime variables into the built index.html.
#
# On a Hugging Face Space with `hf_oauth: true` in the README frontmatter, HF
# provisions an OAuth app for the Space and exposes its client ID (and a few
# other handles) as server-side env vars. Since this is a static-file build,
# we splice them into `dist/index.html` at container startup, replacing the
# `__OAUTH_CLIENT_ID__` style placeholders that `index.html` ships with.
set -eu

INDEX="/app/frontend/dist/index.html"
if [ ! -f "$INDEX" ]; then
  echo "[inject-hf-vars] $INDEX not found, skipping"
  exit 0
fi

: "${OAUTH_CLIENT_ID:=}"
: "${OAUTH_SCOPES:=openid profile write-repos manage-repos}"
: "${SPACE_HOST:=}"
: "${SPACE_ID:=}"

if [ -z "$OAUTH_CLIENT_ID" ]; then
  echo "[inject-hf-vars] OAUTH_CLIENT_ID is empty - leaving index.html placeholders untouched"
  exit 0
fi

# `|` as sed delimiter avoids issues with values containing `/` (URLs).
# Values shouldn't contain `|`; if HF ever sends such a value we'd need to
# escape it explicitly.
sed -i \
  -e "s|__OAUTH_CLIENT_ID__|${OAUTH_CLIENT_ID}|g" \
  -e "s|__OAUTH_SCOPES__|${OAUTH_SCOPES}|g" \
  -e "s|__SPACE_HOST__|${SPACE_HOST}|g" \
  -e "s|__SPACE_ID__|${SPACE_ID}|g" \
  "$INDEX"

echo "[inject-hf-vars] Injected OAuth variables into $INDEX"
