# Build image for the sentiment Substreams module.
#
# Purpose: produce `substreams_sentiment.wasm` without installing Rust, protoc, or the
# substreams CLI on the host. Useful on Linux, where the CLI ships as a GitHub tarball
# rather than a package, and in CI.
#
# This builds the module — it does not run it. Substreams modules execute on the
# provider's infrastructure (StreamingFast/Pinax), not locally, so there is nothing
# long-running to containerize here. The registry also invokes `substreams` as a
# subprocess, which is why the *runtime* path stays native; see README.
#
#   docker build -t substreams-sentiment .
#   docker run --rm -v "$PWD:/out" substreams-sentiment
#
# The wasm lands at ./target/wasm32-unknown-unknown/release/ on the host, exactly
# where substreams.yaml expects it.

FROM rust:1-slim-bookworm

# protoc: prost-build shells out to it and fails deep in a build script without it.
# curl + ca-certificates: to fetch the substreams CLI below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      protobuf-compiler \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

# Pinned so an image rebuild cannot silently change the toolchain under you. The
# published container images for this CLI are tagged by commit SHA with no stable
# `latest`, so the release tarball is the more predictable source.
ARG SUBSTREAMS_VERSION=v1.20.2
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=arm64  ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/substreams.tar.gz \
      "https://github.com/streamingfast/substreams/releases/download/${SUBSTREAMS_VERSION}/substreams_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/substreams.tar.gz -C /usr/local/bin substreams; \
    rm /tmp/substreams.tar.gz; \
    substreams --version

WORKDIR /build

# Manifest first, so the dependency layer is cached and only rebuilds when the
# dependency set actually changes. src/ churns constantly during development;
# Cargo.toml does not.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo '' > src/lib.rs \
    && cargo build --target wasm32-unknown-unknown --release 2>/dev/null || true

COPY . .

# Touch so cargo does not mistake the real lib.rs for the stub cached above — the
# stub may carry a newer mtime than the COPY'd source.
RUN touch src/lib.rs \
    && cargo build --target wasm32-unknown-unknown --release \
    && substreams info substreams.yaml >/dev/null \
    && echo "build ok: $(du -h target/wasm32-unknown-unknown/release/substreams_sentiment.wasm | cut -f1)"

# Copies the artifact to a bind-mounted /out. Overridable:
#   docker run --rm substreams-sentiment substreams info substreams.yaml
CMD ["sh", "-c", "mkdir -p /out/target/wasm32-unknown-unknown/release \
  && cp target/wasm32-unknown-unknown/release/substreams_sentiment.wasm \
        /out/target/wasm32-unknown-unknown/release/ \
  && echo 'wasm copied to ./target/wasm32-unknown-unknown/release/'"]
