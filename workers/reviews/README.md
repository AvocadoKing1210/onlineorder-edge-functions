# Reviews Submit Worker

Cloudflare Worker for submitting reviews with JWT authentication and content filtering.

## Features

- **JWT Authentication**: Requires valid Auth0 JWT token
- **Content Filtering**: Hybrid approach combining keyword lists, pattern matching, and heuristics
- **Validation**: Validates review data, menu item existence, and prevents duplicate reviews
- **RLS Integration**: Uses Supabase RLS policies for access control

## Setup

1. Copy `.dev.vars` and fill in your environment variables:
   ```bash
   cp .dev.vars .dev.vars.local
   # Edit .dev.vars.local with your values
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run locally:
   ```bash
   npm run dev
   ```

4. Deploy:
   ```bash
   npm run deploy:dev  # Development
   npm run deploy:prod # Production
   ```

## API

### POST / (root endpoint)

Submit a review for a menu item.

**Headers:**
- `Authorization: Bearer <JWT_TOKEN>` (required)
- `Content-Type: application/json`

**Request Body:**
```json
{
  "menu_item_id": "uuid",
  "rating": 5,
  "text": "Great food!" // Optional
}
```

**Response (201 Created):**
```json
{
  "id": "uuid",
  "user_id": "auth0|...",
  "menu_item_id": "uuid",
  "rating": 5,
  "text": "Great food!",
  "status": "pending",
  "created_at": "2024-11-10T14:30:22Z"
}
```

**Error Responses:**
- `401`: Authentication required or invalid token
- `400`: Validation error (invalid data, content filter failed, menu item not found)
- `409`: User already has a review for this menu item
- `500`: Internal server error

## Content Filtering

The worker uses a hybrid filtering approach:

1. **Keyword Filtering**: Checks against profanity keyword list
2. **Pattern Matching**: Detects URLs, emails, phone numbers
3. **Suspicious Patterns**: Flags excessive caps, special characters, repeated characters
4. **Repetition Detection**: Identifies spam through word frequency analysis
5. **Quality Scoring**: Calculates content quality score (0-100) for monitoring

Reviews that fail filtering are rejected with a descriptive error message.

## Notes

- All reviews are inserted with `status: 'pending'` for external moderation
- Users can only submit one review per menu item (enforced by unique constraint)
- The worker validates menu item existence and visibility before allowing review submission

