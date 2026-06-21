#!/bin/sh
# One-shot MinIO bootstrap (runs in the `minio/mc` container as `minio-init`).
#
# Creates the listing-images bucket and applies a public-read (anonymous
# download) policy so the local web client can <img src> placeholder images
# straight from MinIO. This is a LOCAL CONVENIENCE only.
#
# Stage 05 swap: this becomes a Cloudflare R2 bucket provisioned via IaC, with
# a CDN in front and signed/CDN URLs -- the api/fake-gen S3 client code does
# not change, only the four S3_* env values do (see infra/README.md).
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

# Retry the alias set: minio reports healthy via `mc ready`, but give the
# control plane a couple of seconds of grace on a cold machine.
i=0
until mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    echo "minio-init: could not reach minio after $i attempts" >&2
    exit 1
  fi
  echo "minio-init: waiting for minio... ($i)"
  sleep 2
done

mc mb --ignore-existing "local/${S3_BUCKET}"
mc anonymous set download "local/${S3_BUCKET}"

echo "minio-init: bucket=${S3_BUCKET} ready (public-read / anonymous download)"
