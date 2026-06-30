#!/bin/bash
# Release v1.2.0 - Run this script in the repository directory

cd "$(dirname "$0")"

echo "=== Building ==="
npm install
npm run build

echo ""
echo "=== Committing ==="
git add -A
git commit -m "feat: batch import, collection support, and batch limit config (v1.2.0)"

echo ""
echo "=== Tagging ==="
git tag v1.2.0

echo ""
echo "=== Pushing ==="
git push origin main --tags

echo ""
echo "=== Done! ==="
echo "Now create a GitHub Release at:"
echo "https://github.com/xiewb/xiaohongshu-importer/releases/new"
echo ""
echo "Upload these files as release assets:"
echo "  - main.js"
echo "  - manifest.json"
echo "  - styles.css"
