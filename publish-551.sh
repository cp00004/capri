#!/bin/bash
set -e
cd "C:/Users/TestUser/Downloads/CAPRI AI/capri-desktop"
STAGE="$TEMP/capri-release-551"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp android/app/build/outputs/apk/release/Capri-v5.5.1.apk "$STAGE/Capri-v4.apk"
cp dist-electron/Capri-v4-Setup.exe dist-electron/Capri-v4-Setup.exe.blockmap dist-electron/Capri-v4-Setup.zip "$STAGE/"
cp dist-electron/latest.yml "$STAGE/"
APKSHA=$(sha256sum "$STAGE/Capri-v4.apk" | cut -d' ' -f1)
EXESHA=$(sha256sum "$STAGE/Capri-v4-Setup.exe" | cut -d' ' -f1)
printf '%s  Capri-v4.apk\n' "$APKSHA" > "$STAGE/Capri-v4.apk.sha256"
printf '%s  Capri-v4-Setup.exe\n' "$EXESHA" > "$STAGE/Capri-v4.sha256"
cp "$STAGE/Capri-v4.sha256" public/Capri-v4.sha256
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
API="https://api.github.com/repos/cp00004/capri/releases/428154590"
for id in 783380991 783383727 783383852 783386676 783386819 783386906 783386624; do
  curl -s -o /dev/null -w "del $id %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/cp00004/capri/releases/assets/$id"
done
for f in Capri-v4-Setup.exe Capri-v4-Setup.exe.blockmap Capri-v4-Setup.zip latest.yml Capri-v4.apk Capri-v4.apk.sha256 Capri-v4.sha256; do
  curl -s --fail -o /dev/null -w "up $f %{http_code} %{size_upload}\n" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$STAGE/$f" \
    "https://uploads.github.com/repos/cp00004/capri/releases/428154590/assets?name=$f"
done
curl -s -H "Authorization: Bearer $TOKEN" "$API/assets?per_page=50" | python -c "import sys,json; [print(a['name'], a['size'], a['state']) for a in json.load(sys.stdin)]"
echo PUBLISH-DONE
