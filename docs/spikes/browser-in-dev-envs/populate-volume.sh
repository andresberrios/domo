set -e
ROOT=/opt/domo-browser
PW=playwright-core@1.63.0
MCP=@playwright/mcp@0.0.82

export DEBIAN_FRONTEND=noninteractive
rm -rf "$ROOT"/lib "$ROOT"/fonts "$ROOT"/fontconfig "$ROOT"/js "$ROOT"/browsers "$ROOT"/bin "$ROOT"/.ready
mkdir -p "$ROOT"/lib "$ROOT"/fonts "$ROOT"/fontconfig "$ROOT"/js "$ROOT"/browsers "$ROOT"/bin

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2 libexpat1 libxext6 libx11-6 libxcb1 fonts-liberation >/dev/null

npm install --prefix "$ROOT/js" --no-fund --no-audit --loglevel=error $PW $MCP
PLAYWRIGHT_BROWSERS_PATH="$ROOT/browsers" \
  "$ROOT/js/node_modules/.bin/playwright-core" install --only-shell chromium
SHELL_BIN=$(find "$ROOT/browsers" -name chrome-headless-shell -type f | head -1)
[ -n "$SHELL_BIN" ] || { echo "no headless shell was downloaded" >&2; exit 1; }
ln -sfn "$SHELL_BIN" "$ROOT/bin/chrome-headless-shell"

# The library closure, to a fixed point. One pass of `ldd` is not enough: the
# binary needs libgobject, which needs libffi, and an image that happens to
# carry the first but not the second fails at exec with a bare
# "error while loading shared libraries".
cp -Ln $(ldd "$SHELL_BIN" | awk '/=> \//{print $3}') "$ROOT/lib/" 2>/dev/null || true
while :; do
  before=$(ls "$ROOT/lib" | wc -l)
  for file in "$ROOT"/lib/*.so*; do
    ldd "$file" 2>/dev/null | awk '/=> \//{print $3}'
  done | sort -u | while read -r dep; do
    [ -f "$dep" ] && cp -Ln "$dep" "$ROOT/lib/" 2>/dev/null || true
  done
  [ "$(ls "$ROOT/lib" | wc -l)" = "$before" ] && break
done

# NSS loads its PKCS#11 modules with dlopen, so no amount of `ldd` names them,
# and the failure is fatal the moment a page is fetched over TLS.
dpkg -L libnss3 | while read -r file; do
  case "$file" in *.so|*.so.*) [ -f "$file" ] && cp -Ln "$file" "$ROOT/lib/" 2>/dev/null || true ;; esac
done

find /usr/share/fonts -name '*.ttf' -o -name '*.otf' | while read -r font; do
  cp -Ln "$font" "$ROOT/fonts/" 2>/dev/null || true
done

# Fontconfig reads an absolute path by default, and the environment's image may
# carry no fonts and no config at all. Without this the browser still runs and
# still answers every query about the DOM — it just draws no text, so the
# screenshot that is the whole point of having it comes back blank.
cat > "$ROOT/fontconfig/fonts.conf" <<'CONF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/opt/domo-browser/fonts</dir>
  <cachedir>/tmp/domo-fontconfig</cachedir>
  <match target="pattern">
    <test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Liberation Sans</string></edit>
  </match>
</fontconfig>
CONF

chmod -R a+rX "$ROOT"
touch "$ROOT/.ready"
echo "libs=$(ls "$ROOT/lib" | wc -l) fonts=$(ls "$ROOT/fonts" | wc -l) size=$(du -sh "$ROOT" | cut -f1)"
