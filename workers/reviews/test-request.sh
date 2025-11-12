#!/bin/bash
# Test script for local development
# Make sure the worker is running: npm run dev
# 
# Usage: ./test-request.sh <JWT_TOKEN>
# 
# To get a JWT token:
# 1. Log in to your app
# 2. Get the token from localStorage or network tab
# 3. Or use Auth0 test token

JWT_TOKEN="${1:-your-jwt-token-here}"

if [ "$JWT_TOKEN" = "your-jwt-token-here" ]; then
  echo "Error: Please provide a JWT token as the first argument"
  echo "Usage: ./test-request.sh <JWT_TOKEN>"
  exit 1
fi

curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "menu_item_id": "00000000-0000-0000-0000-000000000001",
    "rating": 5,
    "text": "This is a great menu item! Highly recommended."
  }'

echo ""

