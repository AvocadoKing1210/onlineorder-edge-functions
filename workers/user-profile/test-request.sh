#!/bin/bash

# Test script for user-profile worker
# Make sure to update the URL with your actual worker URL

WORKER_URL="${WORKER_URL:-http://localhost:8787}"

echo "Testing User Profile Worker at: $WORKER_URL"
echo ""

# Test 1: Create profile for guest user
echo "Test 1: Create profile for guest user"
curl -X POST "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "guest-test-123",
    "email": "guest@example.com",
    "display_name": "Guest User",
    "phone_number": "+1234567890"
  }' | jq '.'

echo ""
echo "---"
echo ""

# Test 2: Update profile for guest user
echo "Test 2: Update profile for guest user"
curl -X PATCH "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "guest-test-123",
    "display_name": "Updated Guest User",
    "phone_number": "+1987654321"
  }' | jq '.'

echo ""
echo "---"
echo ""

# Test 3: Create/update profile for authenticated user (requires valid JWT)
echo "Test 3: Create/update profile for authenticated user"
echo "Note: Replace YOUR_JWT_TOKEN with a valid Auth0 JWT token"
# curl -X POST "$WORKER_URL" \
#   -H "Content-Type: application/json" \
#   -H "Authorization: Bearer YOUR_JWT_TOKEN" \
#   -d '{
#     "email": "user@example.com",
#     "display_name": "Authenticated User",
#     "phone_number": "+1234567890"
#   }' | jq '.'

echo ""
echo "---"
echo ""

# Test 4: OPTIONS request (CORS preflight)
echo "Test 4: CORS preflight"
curl -X OPTIONS "$WORKER_URL" \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: POST" \
  -v

echo ""
echo "Done!"

