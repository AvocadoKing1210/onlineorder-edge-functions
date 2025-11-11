#!/bin/bash
# Test script for local development
# Make sure the worker is running: npm run dev

curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{
    "cart": [
      {
        "menu_item_id": "test-item-id",
        "quantity": 1
      }
    ],
    "mode": "takeout",
    "user_id": "guest-123"
  }'

