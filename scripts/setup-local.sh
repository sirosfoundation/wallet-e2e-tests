#!/bin/bash
#
# Setup script for local development testing
#
# This script starts wallet-frontend and go-wallet-backend from local repos
# for running E2E tests during development.
#
# Usage:
#   ./scripts/setup-local.sh
#   ./scripts/setup-local.sh --frontend-path ../wallet-frontend --backend-path ../go-wallet-backend
#   ./scripts/setup-local.sh --skip-install  # Skip npm install (use existing node_modules)

set -e

# Default paths (relative to this repo)
FRONTEND_PATH="${FRONTEND_PATH:-../wallet-frontend}"
BACKEND_PATH="${BACKEND_PATH:-../go-wallet-backend}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --frontend-path)
            FRONTEND_PATH="$2"
            shift 2
            ;;
        --backend-path)
            BACKEND_PATH="$2"
            shift 2
            ;;
        --skip-install)
            SKIP_INSTALL="true"
            shift
            ;;
        --help)
            echo "Usage: $0 [--frontend-path PATH] [--backend-path PATH] [--skip-install]"
            echo ""
            echo "Options:"
            echo "  --frontend-path PATH  Path to wallet-frontend repo"
            echo "  --backend-path PATH   Path to go-wallet-backend repo"
            echo "  --skip-install        Skip npm install (use existing node_modules)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Verify paths exist
if [ ! -d "$FRONTEND_PATH" ]; then
    echo "Error: Frontend path not found: $FRONTEND_PATH"
    exit 1
fi

if [ ! -d "$BACKEND_PATH" ]; then
    echo "Error: Backend path not found: $BACKEND_PATH"
    exit 1
fi

# Convert to absolute paths
FRONTEND_PATH=$(cd "$FRONTEND_PATH" && pwd)
BACKEND_PATH=$(cd "$BACKEND_PATH" && pwd)

echo "Using frontend from: $FRONTEND_PATH"
echo "Using backend from: $BACKEND_PATH"

# Kill any existing processes
echo "Cleaning up existing processes..."
pkill -f "go run.*go-wallet-backend" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 2

# Install frontend dependencies if needed
if [ "$SKIP_INSTALL" != "true" ]; then
    echo "Installing frontend dependencies..."
    cd "$FRONTEND_PATH"
    # Use --legacy-peer-deps for compatibility with wwWallet frontend
    # which has peer dependency conflicts with newer TypeScript versions
    if npm install --legacy-peer-deps 2>/dev/null; then
        echo "Frontend dependencies installed"
    else
        echo "Warning: npm install failed, trying without --legacy-peer-deps..."
        npm install || true
    fi
fi

# Detect the correct npm script for starting the frontend
# wwWallet uses 'start' (vite), some forks might use 'dev'
detect_frontend_script() {
    cd "$FRONTEND_PATH"
    if grep -q '"start":' package.json 2>/dev/null; then
        echo "start"
    elif grep -q '"dev":' package.json 2>/dev/null; then
        echo "dev"
    else
        echo "start"  # fallback
    fi
}

FRONTEND_SCRIPT=$(detect_frontend_script)
echo "Using frontend script: npm run $FRONTEND_SCRIPT"

# Start backend
echo "Starting go-wallet-backend..."
cd "$BACKEND_PATH"
WALLET_JWT_SECRET="test-secret-for-e2e-testing-minimum-32-chars" \
WALLET_SERVER_WEBAUTHN_DISPLAY_NAME="Wallet E2E Test" \
WALLET_SERVER_RP_ID="localhost" \
WALLET_SERVER_RP_ORIGIN="http://localhost:3000" \
WALLET_SERVER_ENABLE_CREDENTIAL_REGISTRATION="true" \
WALLET_SERVER_REQUIRE_USER_VERIFICATION="true" \
WALLET_SERVER_TIMEOUT="60000" \
WALLET_SERVER_ATTESTATION="none" \
WALLET_SERVER_PORT="8080" \
WALLET_LOG_LEVEL="info" \
go run ./cmd/server &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for backend to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:8080/status > /dev/null 2>&1; then
        echo "Backend is ready!"
        break
    fi
    sleep 1
done

# Start frontend
echo "Starting wallet-frontend..."
cd "$FRONTEND_PATH"
VITE_WALLET_BACKEND_URL="http://localhost:8080" \
VITE_WEBAUTHN_RPID="localhost" \
VITE_LOGIN_WITH_PASSWORD="false" \
npm run "$FRONTEND_SCRIPT" -- --host &
FRONTEND_PID=$!

# Wait for frontend to be ready
echo "Waiting for frontend to be ready..."
for i in {1..60}; do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo "Frontend is ready!"
        break
    fi
    sleep 1
done

echo ""
echo "=========================================="
echo "Services are running!"
echo "=========================================="
echo "Frontend: http://localhost:3000 (PID: $FRONTEND_PID)"
echo "Backend:  http://localhost:8080 (PID: $BACKEND_PID)"
echo ""
echo "To stop: kill $FRONTEND_PID $BACKEND_PID"
echo "Or: pkill -f 'go run.*go-wallet-backend' && pkill -f vite"
echo ""
echo "Now run: npm test"

# Keep script running and forward signals
trap "kill $FRONTEND_PID $BACKEND_PID 2>/dev/null" EXIT
wait
