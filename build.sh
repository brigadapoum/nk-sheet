#!/bin/sh
# Пересобрать dist/module.zip после любой правки (и поднять version в module.json)
set -e
cd "$(dirname "$0")"
mkdir -p dist && rm -f dist/module.zip
zip -qr dist/module.zip module.json scripts styles README.md
