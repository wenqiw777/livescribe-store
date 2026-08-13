#!/bin/sh
set -eu

: "${CWS_ACCESS_TOKEN:?CWS_ACCESS_TOKEN is required}"
: "${CWS_PUBLISHER_ID:?CWS_PUBLISHER_ID is required}"
: "${CWS_ITEM_ID:?CWS_ITEM_ID is required}"

zip_path=${1:?Usage: publish-chrome-store.sh path/to/extension.zip}
publish_type=${CWS_PUBLISH_TYPE:-DEFAULT_PUBLISH}
api_root="https://chromewebstore.googleapis.com"
item_name="publishers/$CWS_PUBLISHER_ID/items/$CWS_ITEM_ID"

if [ ! -f "$zip_path" ]; then
  echo "Extension ZIP not found: $zip_path" >&2
  exit 1
fi

request() {
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $CWS_ACCESS_TOKEN" "$@"
}

upload_response=$(request -X POST \
  -H "Content-Type: application/zip" \
  --data-binary "@$zip_path" \
  "$api_root/upload/v2/$item_name:upload")
printf '%s\n' "$upload_response"

upload_state=$(printf '%s' "$upload_response" | node -e '
  let json = "";
  process.stdin.on("data", chunk => json += chunk);
  process.stdin.on("end", () => console.log(JSON.parse(json).uploadState || ""));
')

attempt=0
while { [ "$upload_state" = "IN_PROGRESS" ] || [ "$upload_state" = "UPLOAD_IN_PROGRESS" ]; } && [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  sleep 5
  status_response=$(request "$api_root/v2/$item_name:fetchStatus")
  upload_state=$(printf '%s' "$status_response" | node -e '
    let json = "";
    process.stdin.on("data", chunk => json += chunk);
    process.stdin.on("end", () => console.log(JSON.parse(json).lastAsyncUploadState || ""));
  ')
done

case "$upload_state" in
  SUCCEEDED|UPLOAD_SUCCESS) ;;
  *)
    echo "Chrome Web Store upload did not succeed: $upload_state" >&2
    exit 1
    ;;
esac

publish_response=$(request -X POST \
  -H "Content-Type: application/json" \
  -d "{\"publishType\":\"$publish_type\",\"skipReview\":false,\"blockOnWarnings\":true}" \
  "$api_root/v2/$item_name:publish")
printf '%s\n' "$publish_response"
