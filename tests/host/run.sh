#!/usr/bin/env bash
# Host tests for the parts of the firmware that do not need ESP-IDF.
#   tests/host/run.sh
# See album_listing_test.c for what is covered.
set -euo pipefail
cd "$(dirname "$0")/../.."

CFLAGS="-std=gnu11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -I main"

gcc $CFLAGS main/album_listing.c tests/host/album_listing_test.c -o /tmp/pf_album_listing_test
/tmp/pf_album_listing_test
