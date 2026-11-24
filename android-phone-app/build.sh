#!/usr/bin/env bash
# Builds the TeamLink Phone APK without Gradle (plain Java + the Android SDK build tools), signed with the release key kept OUTSIDE the repo.
#   ANDROID_SDK  default %LOCALAPPDATA%/Android/Sdk      JAVA_HOME  default Android Studio's bundled JDK
#   KEY_DIR      default ~/.teamlink-phone (release.keystore + release.pass; made on the first build, keep both safe: updates need the same key)
# Output: build/teamlink-phone.apk (copy it to frontend/public/downloads/ so TeamLink serves it).
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_SDK:-$LOCALAPPDATA/Android/Sdk}"
SDK="$(cygpath -u "$SDK" 2>/dev/null || echo "$SDK")"
JH="$(cygpath -u "${JAVA_HOME:-C:/Program Files/Android/Android Studio/jbr}")"
export JAVA_HOME="$(cygpath -w "$JH")"; export PATH="$JH/bin:$PATH"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-34/android.jar"
KEY_DIR="${KEY_DIR:-$HOME/.teamlink-phone}"
VERSION=$(grep -o 'VERSION = "[^"]*"' src/com/teamlink/phone/BuildInfo.java | cut -d'"' -f2)
CODE=$(echo "$VERSION" | awk -F. '{print $1*100+$2}')
rm -rf build && mkdir -p build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip --java build/gen \
  --min-sdk-version 21 --target-sdk-version 30 --version-code "$CODE" --version-name "$VERSION"
"$JH/bin/javac" -nowarn -Xlint:-options --release 11 -encoding UTF-8 -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java')
"$BT/d8.bat" --release --min-api 21 --lib "$JAR" --output build/dex $(find build/classes -name '*.class') 2>&1 | grep -v '^Warning' || true
cp build/base.apk build/unsigned.apk
(cd build/dex && "$BT/aapt" add ../unsigned.apk classes.dex >/dev/null)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
mkdir -p "$KEY_DIR"
if [ ! -f "$KEY_DIR/release.keystore" ]; then
  head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > "$KEY_DIR/release.pass"
  "$JH/bin/keytool" -genkeypair -keystore "$KEY_DIR/release.keystore" -alias teamlink -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$(cat "$KEY_DIR/release.pass")" -keypass "$(cat "$KEY_DIR/release.pass")" -dname "CN=TeamLink Phone, O=TeamLink, C=IN" >/dev/null 2>&1
fi
KW="$(cygpath -w "$KEY_DIR" 2>/dev/null || echo "$KEY_DIR")"
"$BT/apksigner.bat" sign --ks "$KW/release.keystore" --ks-key-alias teamlink --ks-pass "file:$KW/release.pass" \
  --min-sdk-version 21 --out build/teamlink-phone.apk build/aligned.apk
"$BT/apksigner.bat" verify --min-sdk-version 21 build/teamlink-phone.apk
ls -la build/teamlink-phone.apk
