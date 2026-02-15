#!/bin/bash

# Start a simple HTTP server for the UIs
# Serves from the frontend/ directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Starting UI server on port 8000..."
echo ""
echo "  User-facing swap dApp:  http://localhost:8000/app.html"
echo "  Developer test UI:      http://localhost:8000/test-ui.html"
echo ""
echo "  Tip: pass contract addresses as URL params:"
echo "  http://localhost:8000/app.html?wrapper=0x...&erc20=0x...&foreign=0x..."
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd "$PROJECT_DIR/frontend" && python3 -m http.server 8000
