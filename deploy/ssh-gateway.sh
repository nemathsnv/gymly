#!/bin/sh
set -eu
exec sudo -n /usr/local/sbin/gymly-deploy "${SSH_ORIGINAL_COMMAND:-}"
