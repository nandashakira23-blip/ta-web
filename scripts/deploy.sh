#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "Hostinger Managed Node.js preflight"
echo "=========================================="
echo ""

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Installing production dependencies like Hostinger will..."
npm ci --omit=dev

echo "Running build command..."
npm run build

echo "Running production dependency audit..."
npm audit --omit=dev --audit-level=moderate

echo ""
echo "=========================================="
echo "Preflight complete"
echo "=========================================="
echo "Hostinger settings:"
echo "Node.js version: 22"
echo "Install command: npm ci --omit=dev"
echo "Build command: npm run build"
echo "Start command: npm start"
