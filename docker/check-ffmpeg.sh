#!/bin/sh
# Build-time proof that the ffmpeg in this image is the trimmed one and does what src/ffmpeg.ts and src/video.ts rely
# on. Runs in the ffmpeg build stage only (never copied to the final image). A failure stops the docker build, not a
# reply. Arguments: the ffmpeg binary, then the openssl binary built next to it (used as a throwaway TLS server).
set -eu
ffmpeg=$1
openssl=$2
fail() { echo "check-ffmpeg: FAIL: $*" >&2; exit 1; }

conf=$("$ffmpeg" -hide_banner -buildconf)
for need in --enable-openssl --enable-libmp3lame --enable-libdav1d --disable-autodetect --disable-everything --enable-static; do
  echo "$conf" | grep -q -- "$need" || fail "configuration lacks $need"
done
if echo "$conf" | grep -Eq -- '--enable-(gpl|nonfree)'; then fail "not an LGPL build"; fi
"$ffmpeg" -hide_banner -version | head -n 1

# Names listed by `ffmpeg -<what>`, one per line. Skips the legend and section headers.
names() {
  "$ffmpeg" -hide_banner "-$1" | awk 'NR > 1 && NF >= 2 && $1 ~ /^[A-Z.]+$/ && $2 != "=" { print $2 }' | tr ',' '\n'
}
protocol_names() { "$ffmpeg" -hide_banner -protocols | awk '/^(Supported|Input|Output):/ { next } NF == 1 { print $1 }' | sort -u; }
need_all() { # what, then names that must all be present
  what=$1; shift
  have=$(names "$what")
  for n in "$@"; do echo "$have" | grep -qx -- "$n" || fail "no $n in -$what"; done
}
need_all demuxers mov matroska
need_all muxers image2pipe mp3
need_all encoders mjpeg libmp3lame
need_all decoders h264 hevc vp8 vp9 libdav1d aac opus mp3float vorbis
need_all filters fps scale aresample format aformat
have=$(protocol_names)
for n in https tls tcp pipe; do echo "$have" | grep -qx -- "$n" || fail "no $n protocol"; done

# Nothing else can read a file, a playlist or a socket: the whole protocol list is the four https needs.
extra=$(protocol_names | grep -vxE 'https|tls|tcp|pipe' || true)
[ -z "$extra" ] || fail "unexpected protocols: $extra"
extra=$(names demuxers | grep -vxE 'mov|mp4|m4a|3gp|3g2|mj2|matroska|webm' || true)
[ -z "$extra" ] || fail "unexpected demuxers: $extra"

# The TLS options src/ffmpeg.ts passes must exist in the backend.
"$ffmpeg" -hide_banner -h protocol=tls | grep -q ca_file || fail "tls has no ca_file option"
"$ffmpeg" -hide_banner -h protocol=tls | grep -q verify || fail "tls has no verify option"

# Certificates are really checked, by name too. A throwaway CA signs a leaf for `localhost` and one for another name;
# `openssl s_server` serves them over loopback. ffmpeg gets past TLS only for the right name with the right CA
# (the control: without it, a refusal below would prove nothing). It then fails on the page not being media ("Stream ends prematurely": the TLS session worked and data came back).
work=$(mktemp -d)
srv=""
trap 'if [ -n "$srv" ]; then kill "$srv" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
cd "$work"
# A minimal config: this openssl has no system configuration directory.
printf '[req]\ndistinguished_name=dn\n[dn]\n' > openssl.cnf
export OPENSSL_CONF="$work/openssl.cnf"
"$openssl" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=check-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" -keyout ca.key -out ca.pem
"$openssl" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj "/CN=other-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" -keyout other.key -out other.pem
leaf() { # name file
  "$openssl" req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$1" -keyout "$2.key" -out "$2.csr"
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$1" > "$2.ext"
  "$openssl" x509 -req -in "$2.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile "$2.ext" -out "$2.pem"
}
leaf localhost good
leaf wrong.invalid wrong

serve() { # cert-basename port
  "$openssl" s_server -accept "127.0.0.1:$2" -cert "$1.pem" -key "$1.key" -www -quiet >/dev/null 2>&1 &
  srv=$!
  # Wait until it accepts connections (a slow builder must not fail the build, nor pass it wrongly).
  tries=0
  until "$openssl" s_client -connect "127.0.0.1:$2" < /dev/null > /dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 40 ] || fail "openssl s_server did not start"
    sleep 0.25
  done
}
fetch() { # port, ca file -> ffmpeg's stderr (it always fails: the page is not media)
  "$ffmpeg" -hide_banner -nostdin -v error -protocol_whitelist https,tls,tcp -format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm \
    -max_redirects 0 -tls_verify 1 -ca_file "$2" -i "https://localhost:$1/" -f mp3 -y /dev/null 2>&1 || true
}
srv=""
serve good 18443
out=$(fetch 18443 ca.pem); kill "$srv"; wait "$srv" 2>/dev/null || true
echo "control (right name, right CA): $out"
echo "$out" | grep -q "Stream ends prematurely" || fail "control: TLS did not succeed for a valid certificate"

serve wrong 18444
out=$(fetch 18444 ca.pem); kill "$srv"; wait "$srv" 2>/dev/null || true
echo "wrong host name: $out"
echo "$out" | grep -q "Stream ends prematurely" && fail "a certificate for another name was accepted"
echo "$out" | grep -q "certificate verify failed" || fail "wrong name: refused for another reason"

serve good 18445
out=$(fetch 18445 other.pem); kill "$srv"; wait "$srv" 2>/dev/null || true
echo "untrusted CA: $out"
echo "$out" | grep -q "Stream ends prematurely" && fail "a certificate from an untrusted CA was accepted"
echo "$out" | grep -q "certificate verify failed" || fail "untrusted CA: refused for another reason"
echo "check-ffmpeg: ok"
