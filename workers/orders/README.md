# Orders Submit Worker

Cloudflare Worker for handling order submission with validation, reference number generation, and Supabase integration.

## Features

- ✅ Auth0 JWT verification
- ✅ Cart validation (menu items, prices)
- ✅ Reference number generation
- ✅ Order creation via Supabase REST API
- ✅ Guest checkout support
- ✅ CORS enabled

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars with your values
   ```

3. **Run locally:**
   ```bash
   npm run dev
   ```

   The worker will start at `http://localhost:8787`

## Environment Variables

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anonymous key
- `AUTH0_DOMAIN` - Your Auth0 domain (e.g., `your-tenant.auth0.com`)
- `AUTH0_AUDIENCE` - Optional Auth0 audience

## API Usage

### Submit Order

```bash
POST http://localhost:8787
Content-Type: application/json
Authorization: Bearer <auth0-token>  # Optional for guest checkout

{
  "cart": [
    {
      "menu_item_id": "uuid-here",
      "quantity": 2,
      "modifiers": [
        {
          "modifier_option_id": "uuid-here"
        }
      ]
    }
  ],
  "mode": "takeout",
  "special_instructions": "Extra spicy please",
  "idempotency_key": "unique-key-123"  # Optional
}
```

### Guest Checkout

```bash
POST http://localhost:8787
Content-Type: application/json

{
  "cart": [...],
  "mode": "takeout",
  "user_id": "guest-session-id"  # For guest checkout
}
```

### Response

```json
{
  "order_id": "uuid",
  "reference_number": "20241110-143022-A1B2",
  "status": "submitted",
  "total_amount": "29.99"
}
```

## Deployment

### Development
```bash
npm run deploy:dev
```

### Production
```bash
npm run deploy:prod
```

## Testing

Test the worker locally:

```bash
# Start dev server
npm run dev

# In another terminal, test the endpoint
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "cart": [{"menu_item_id": "test-id", "quantity": 1}],
    "mode": "takeout"
  }'
```

## Notes

- Reference numbers are generated in format: `YYYYMMDD-HHMMSS-XXXX`
- Orders are created with status `submitted`
- Guest checkout requires `user_id` in request body
- JWT verification is optional for guest checkout

