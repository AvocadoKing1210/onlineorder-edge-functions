# User Profile Worker

Cloudflare Worker for managing user profiles, typically used during checkout to create or update user information.

## Features

- **Create/Update User Profiles**: Automatically creates new profiles or updates existing ones
- **Auth0 Integration**: Verifies Auth0 JWT tokens for authenticated users
- **Guest User Support**: Supports guest checkout with provided user_id
- **Smart Merging**: Merges data from JWT payload, request body, and existing profile

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.dev.vars` from the orders worker (already done) or create your own:
```bash
cp ../orders/.dev.vars .dev.vars
```

3. Update `.dev.vars` with your credentials:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  # Get from Supabase Dashboard > Settings > API
AUTH0_DOMAIN=your-auth0-domain
AUTH0_AUDIENCE=https://your-auth0-domain/api/v2/ (optional)
AUTH0_CLIENT_ID=your-client-id (optional)
```

**Important**: The worker uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS. This is secure because:
- We validate the Auth0 JWT token first
- We extract and verify the user_id from the validated JWT
- We only allow operations on the user's own profile
- The service_role key is only used after JWT validation

## Development

Run locally:
```bash
npm run dev
```

Type check:
```bash
npm run typecheck
```

## Deployment

Deploy to development:
```bash
npm run deploy:dev
```

Deploy to production:
```bash
npm run deploy:prod
```

## API Usage

### Endpoint
- **URL**: `https://user-profile.your-subdomain.workers.dev`
- **Methods**: `POST`, `PUT`, `PATCH`
- **Content-Type**: `application/json`

### Request Body

```json
{
  "user_id": "optional-for-authenticated-users",
  "email": "user@example.com",
  "display_name": "John Doe",
  "phone_number": "+1234567890",
  "avatar_url": "https://example.com/avatar.jpg",
  "preferred_locale": "en"
}
```

### Authentication

**Authentication Required:**
- This worker **only supports authenticated users**
- Include `Authorization: Bearer <auth0-jwt-token>` header
- The `user_id` will be extracted from the JWT `sub` claim
- Email, name, and picture from JWT will be used as fallbacks
- Can **create** new profiles or **update** existing profiles

**Note for Guest Users:**
- Guest customer information is stored directly in the `order` table (`customer_name`, `customer_email`, `customer_phone`)
- Guest users should **not** create profiles - profiles are for authenticated users only
- When a guest later authenticates, their order history can be linked to their new profile

### Response

**Success (200/201):**
```json
{
  "id": "auth0|123456",
  "email": "user@example.com",
  "display_name": "John Doe",
  "avatar_url": "https://example.com/avatar.jpg",
  "phone_number": "+1234567890",
  "preferred_locale": "en",
  "created_at": "2024-11-10T14:30:22.000Z",
  "updated_at": "2024-11-10T14:30:22.000Z"
}
```

**Error (400/401/403/500):**
```json
{
  "error": "Error message"
}
```

**Common Errors:**
- `400`: Missing required fields (e.g., email for new profiles)
- `401`: Missing, invalid, or expired JWT token (authentication required)
- `500`: Internal server error

## Example: Checkout Flow

```javascript
// During checkout, update/create user profile
const response = await fetch('https://user-profile.your-subdomain.workers.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`, // Optional for authenticated users
  },
  body: JSON.stringify({
    email: 'customer@example.com',
    display_name: 'John Doe',
    phone_number: '+1234567890',
  }),
});

const profile = await response.json();
```

## Security & RLS

The worker uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS policies. This is secure because:

1. **JWT Validation First**: We validate the Auth0 JWT token before any database operations
2. **User ID Verification**: We extract the `user_id` from the validated JWT `sub` claim
3. **Ownership Enforcement**: We only allow users to create/update their own profiles (matching JWT `sub`)
4. **Service Role After Validation**: The service_role key is only used after successful JWT validation

This approach is necessary because:
- Supabase RLS policies require Supabase JWT tokens (not Auth0 JWT tokens)
- The worker validates Auth0 JWT tokens, so we handle authorization ourselves
- Using service_role after validation is equivalent to RLS enforcement

## CORS

The worker includes CORS headers to allow cross-origin requests from your frontend application.

