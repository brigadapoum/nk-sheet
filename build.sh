#!/bin/sh
# Пересобрать архив после любой правки.
# Порядок: поднять "version" в module.json и поменять в "download" имя архива на nk-sheet-<версия>.zip, затем ./build.sh
set -e
cd "$(dirname "$0")"
V=$(python3 -c "import json;print(json.load(open('module.json'))['version'])")
grep -q "dist/nk-sheet-$V.zip" module.json || { echo "download в module.json не указывает на nk-sheet-$V.zip"; exit 1; }
mkdir -p dist  # старые архивы не удаляем: пока GitHub кэширует старый манифест, он должен находить свой архив
rm -f "dist/nk-sheet-$V.zip"
zip -qr "dist/nk-sheet-$V.zip" module.json scripts styles README.md
cp "dist/nk-sheet-$V.zip" dist/module.zip  # для старых ссылок
echo "dist/nk-sheet-$V.zip"
