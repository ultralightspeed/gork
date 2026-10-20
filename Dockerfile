FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-fund --no-audit
# Keep what runs: drop type declarations, source maps, docs, the type-only @types, and the Discord API versions
# discord.js doesn't load (it uses v10 only). Licences stay. The import below stops the build if that broke it.
RUN set -eu; cd node_modules; \
    find . \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -iname 'README*' -o -iname 'CHANGELOG*' \) -type f -delete; \
    rm -rf @types; \
    rm -f discord-api-types/v6.* discord-api-types/v8.* discord-api-types/v9.*; \
    find discord-api-types -type d \( -name v6 -o -name v8 -o -name v9 \) -prune -exec rm -rf {} +; \
    cd ..; \
    node --input-type=module -e "const d = await import('discord.js'); new d.Client({ intents: [] }).destroy(); console.log('discord.js loads')"

# ffmpeg, built from source with only what src/ffmpeg.ts uses, as one static binary (musl, so it runs on any base).
# Every source tarball is checked against a SHA-256 recorded here. The FFmpeg and dav1d hashes were taken from tarballs
# whose PGP signatures verified (FFmpeg release key FCF986EA15E6E293A5644F10B4322F04D67658D8; dav1d: VideoLAN key
# 65F7C6B4206BD057A7EB73787180713BE58D1ADC, which has expired but signed this release); OpenSSL's matches the
# .sha256 the project publishes; LAME's matches the long-published 3.100 hash (no signature exists). To bump,
# download, verify the same way and replace version and hash together.
FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS ffmpeg-build
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG OPENSSL_VERSION=3.5.9
ARG OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
ARG LAME_VERSION=3.100
ARG LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
ARG DAV1D_VERSION=1.5.4
ARG DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
RUN apk add --no-cache build-base curl linux-headers meson nasm ninja perl pkgconf xz
WORKDIR /src

# OpenSSL: the TLS backend (certificate and host name checks). Static libraries; the openssl tool is kept only so
# check-ffmpeg.sh can play a TLS server.
RUN set -eu; \
    curl -fsSL --retry 3 -o openssl.tar.gz "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"; \
    echo "$OPENSSL_SHA256  openssl.tar.gz" | sha256sum -c -; \
    tar -xzf openssl.tar.gz; cd "openssl-$OPENSSL_VERSION"; \
    ./Configure --prefix=/opt/deps --libdir=lib no-shared no-tests no-docs no-module no-legacy no-engine no-comp \
      no-ssl3 no-dtls no-quic no-ktls -static; \
    make -j"$(nproc)" build_sw; make install_sw; \
    rm -rf /src/*

RUN set -eu; \
    curl -fsSL --retry 3 -o lame.tar.gz "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"; \
    echo "$LAME_SHA256  lame.tar.gz" | sha256sum -c -; \
    tar -xzf lame.tar.gz; cd "lame-$LAME_VERSION"; \
    ./configure --prefix=/opt/deps --enable-static --disable-shared --disable-frontend --disable-decoder --disable-gtktest; \
    make -j"$(nproc)"; make install; \
    rm -rf /src/*

RUN set -eu; \
    curl -fsSL --retry 3 -o dav1d.tar.xz "https://download.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz"; \
    echo "$DAV1D_SHA256  dav1d.tar.xz" | sha256sum -c -; \
    tar -xJf dav1d.tar.xz; cd "dav1d-$DAV1D_VERSION"; \
    meson setup build --prefix=/opt/deps --libdir=lib --buildtype=release --default-library=static \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false; \
    ninja -C build install; \
    rm -rf /src/*

# --disable-everything, then only: https (tls, tcp) and pipe; the mov and matroska demuxers (src/ffmpeg.ts's
# -format_whitelist); decoders for what Discord users upload; the MJPEG and MP3 encoders and the two muxers the
# pipelines end in; and the few filters they use. No network protocol but https, no file protocol, no hwaccels, no
# devices, no zlib/bzip2/lzma (a compressed mov header or Matroska track is declined, not parsed).
RUN set -eu; \
    curl -fsSL --retry 3 -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"; \
    echo "$FFMPEG_SHA256  ffmpeg.tar.xz" | sha256sum -c -; \
    tar -xJf ffmpeg.tar.xz; cd "ffmpeg-$FFMPEG_VERSION"; \
    PKG_CONFIG_PATH=/opt/deps/lib/pkgconfig ./configure \
      --prefix=/opt/ffmpeg --pkg-config-flags=--static \
      --extra-cflags=-I/opt/deps/include --extra-ldflags="-L/opt/deps/lib -static" \
      --disable-everything --disable-autodetect --disable-debug --disable-doc \
      --enable-static --disable-shared --enable-version3 --enable-small \
      --disable-ffplay --disable-ffprobe --disable-avdevice \
      --enable-openssl --enable-libmp3lame --enable-libdav1d \
      --enable-protocol=https,tls,tcp,pipe \
      --enable-demuxer=mov,matroska \
      --enable-parser=h264,hevc,vp8,vp9,av1,aac,opus,mpegaudio,vorbis \
      --enable-decoder=h264,hevc,vp8,vp9,libdav1d,aac,opus,mp3float,vorbis,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8 \
      --enable-encoder=mjpeg,libmp3lame \
      --enable-muxer=image2pipe,mp3 \
      --enable-filter=fps,scale,format,aformat,aresample,null,anull,buffer,buffersink,abuffer,abuffersink; \
    make -j"$(nproc)"; \
    strip --strip-all ffmpeg; \
    install -m 0755 ffmpeg /usr/local/bin/ffmpeg; \
    install -m 0755 /opt/deps/bin/openssl /usr/local/bin/openssl-check; \
    rm -rf /src/*

# Fails the build, not a reply, if this binary lacks what video.ts relies on or checks certificates badly.
FROM ffmpeg-build AS ffmpeg
COPY docker/check-ffmpeg.sh /usr/local/bin/check-ffmpeg.sh
RUN /usr/local/bin/check-ffmpeg.sh /usr/local/bin/ffmpeg /usr/local/bin/openssl-check

# Runtime: only what node and ffmpeg need, copied onto an empty image. No shell, no busybox, no package manager, no
# npm, npx, yarn or corepack: not removed from a bigger image (that would leave the bytes in a lower layer) but never
# copied. node is stripped of its symbols (about 18 MB).
FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS rootfs
RUN apk add --no-cache binutils
# The bundle ffmpeg checks Discord's CDN against, less the roots src/distrust.ts lists (the bot drops them from its own
# store when it starts). The build fails if the filter does.
COPY src/distrust.ts /tmp/distrust.ts
RUN set -eu; mkdir -p /out/usr/local/bin /out/usr/lib /out/lib /out/etc/ssl/certs /out/tmp /out/data; \
    cp /usr/local/bin/node /out/usr/local/bin/node; strip --strip-all /out/usr/local/bin/node; \
    cp -a /lib/ld-musl-* /out/lib/; \
    cp -a /usr/lib/libstdc++.so.6* /usr/lib/libgcc_s.so.1 /out/usr/lib/; \
    node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; \
      import { filterBundle } from '/tmp/distrust.ts'; \
      const r = filterBundle(readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')); \
      writeFileSync('/out/etc/ssl/certs/ca-certificates.crt', r.text); \
      console.log('distrusted roots removed from the CA bundle:', r.removed);"; \
    chmod 1777 /out/tmp; chown 1000:1000 /out/data

FROM scratch
ENV PATH=/usr/local/bin NODE_ENV=production DATA_DIR=/data HOME=/tmp
# The hand-built libraries, which no package database records: scanners and people can read their versions here.
# test/dockerfile.test.ts keeps these equal to the ARGs above.
LABEL org.gork.ffmpeg="9.0.2" org.gork.openssl="3.5.9" org.gork.lame="3.100" org.gork.dav1d="1.5.4"
# One layer per kind of change, slowest-moving first, so an update re-downloads only what changed.
COPY --from=rootfs /out/ /
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY personas ./personas
COPY assets ./assets
COPY src ./src
USER 1000:1000
# The bot has no port: it writes a heartbeat file while connected to Discord (src/heartbeat.ts) and this checks its age.
# Run by node itself, since the image has no shell. Plain Docker only marks the container unhealthy; it restarts
# nothing (src/index.ts exits by itself when disconnected for 5 minutes, and Docker's restart policy handles that).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "src/healthcheck.ts"]
CMD ["node", "src/index.ts"]
