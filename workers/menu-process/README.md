# Menu Process Worker - Text Extraction

Cloudflare Worker for extracting text from images using Cloudflare AI Workers with the `@cf/meta/llama-3.2-11b-vision-instruct` vision model.

## Features

- ✅ **Vision AI Text Extraction**: Uses Cloudflare's Llama 3.2 11B Vision model
- ✅ **Multiple Image Support**: Process single or multiple images in one request
- ✅ **Structured JSON Output**: Automatically extracts menu items into structured JSON format
- ✅ **Complete Menu Extraction**: Extracts all menu items (40+ items) with IDs, names, descriptions, prices, and categories
- ✅ **Multiple Input Formats**: Supports file uploads, image URLs, base64 encoded images, and data URIs
- ✅ **File Upload Support**: Direct file upload via multipart/form-data (perfect for Postman)
- ✅ **Custom Prompts**: Optional custom prompts for specific extraction needs
- ✅ **CORS Enabled**: Ready for cross-origin requests
- ✅ **No External Dependencies**: Uses Cloudflare's built-in AI binding

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run locally:**
   ```bash
   npm run dev
   ```

   The worker will start at `http://localhost:8787`

## Environment Variables

No environment variables are required! The Cloudflare AI binding is automatically available in Cloudflare Workers.

## API Usage

### Method 1: File Upload (Postman/Form Data) - Recommended

**Using Postman (Single Image):**
1. Set method to `POST`
2. Set URL to `http://localhost:8787` (or your deployed URL)
3. Go to **Body** tab
4. Select **form-data**
5. Add a key named `image` with type **File**
6. Click **Select Files** and choose your image file
7. (Optional) Add another key named `prompt` with type **Text** for custom extraction prompt
8. Send the request

**Using Postman (Multiple Images):**
1. Set method to `POST`
2. Set URL to `http://localhost:8787` (or your deployed URL)
3. Go to **Body** tab
4. Select **form-data**
5. Add multiple keys named `images` (all with the same name) with type **File**
6. Click **Select Files** and choose multiple image files
7. (Optional) Add another key named `prompt` with type **Text** for custom extraction prompt
8. Send the request

**Using curl:**
```bash
curl -X POST http://localhost:8787 \
  -F "image=@/path/to/your/image.jpg" \
  -F "prompt=Extract all menu items with prices"
```

### Method 2: JSON with Image URL

```bash
POST http://localhost:8787
Content-Type: application/json

{
  "image_url": "https://example.com/menu.jpg"
}
```

### Method 2b: JSON with Multiple Image URLs

```bash
POST http://localhost:8787
Content-Type: application/json

{
  "images": [
    "https://example.com/menu-page1.jpg",
    "https://example.com/menu-page2.jpg",
    "https://example.com/menu-page3.jpg"
  ]
}
```

### Method 3: JSON with Base64 Image

```bash
POST http://localhost:8787
Content-Type: application/json

{
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ..."
}
```

### Method 4: JSON with Custom Prompt

```bash
POST http://localhost:8787
Content-Type: application/json

{
  "image_url": "https://example.com/menu.jpg",
  "prompt": "Extract all menu items with their prices. Format as JSON."
}
```

### Response (Single Image)

The response includes both the raw text and parsed JSON (if extraction was successful):

```json
{
  "text": "Raw text response from AI...",
  "json": {
    "items": [
      {
        "id": "F1",
        "name": "Osaka Roll",
        "description": "fresh salmon, smoked salmon, cream cheese, tobiko, avocado, spicy mayo",
        "price": "$8.99",
        "category": "FUTOMAKI",
        "section": "FUTOMAKI"
      },
      {
        "id": "F2",
        "name": "Kyoto Roll",
        "description": "spicy tuna & salmon, avocado, tempura bits, lettuce, eel sauce",
        "price": "$8.99",
        "category": "FUTOMAKI",
        "section": "FUTOMAKI"
      }
      // ... 40+ more items
    ],
    "categories": ["FUTOMAKI", "UNA MAKI", "SIGNATURE ROLL", "SOYA PAPER ROLL"],
    "sections": ["FUTOMAKI", "UNA MAKI", "SIGNATURE ROLL", "SOYA PAPER ROLL"]
  },
  "model": "@cf/meta/llama-3.2-11b-vision-instruct",
  "processed_at": "2024-11-10T14:30:22.000Z"
}
```

**Response Fields:**
- `text`: Raw text response from AI
- `json`: Parsed JSON object with menu items (null if parsing failed)
- `item_count`: Number of items extracted (if JSON parsing succeeded)
- `parse_error`: Error message if JSON parsing failed (for debugging)
- `model`: AI model used
- `processed_at`: Timestamp

**Note**: The `json` field will be `null` if JSON parsing fails, but the `text` field will always contain the raw AI response. Check `item_count` to verify all items were extracted (should be ~48 for the test menu).

### Response (Multiple Images)

When multiple images are provided, the response structure changes:

```json
{
  "results": [
    {
      "image_index": 0,
      "text": "Raw text response from AI...",
      "json": {
        "items": [...],
        "categories": [...],
        "sections": [...]
      },
      "parse_error": null,
      "item_count": 48
    },
    {
      "image_index": 1,
      "text": "Raw text response from AI...",
      "json": {
        "items": [...],
        "categories": [...],
        "sections": [...]
      },
      "parse_error": null,
      "item_count": 32
    }
  ],
  "total_items": 80,
  "model": "@cf/meta/llama-3.2-11b-vision-instruct",
  "processed_at": "2024-11-10T14:30:22.000Z"
}
```

**Multiple Image Response Fields:**
- `results`: Array of extraction results, one per image
- `total_items`: Sum of all items extracted from all images
- Each result includes `image_index`, `text`, `json`, `parse_error`, and `item_count`

### Error Responses

- `400`: Invalid request (missing image, invalid image format)
- `405`: Method not allowed (only POST is supported)
- `500`: Internal server error (AI processing failed)

## Request Body Options

### For File Upload (multipart/form-data):
- `image` (File, optional): Single image file to upload
- `images` (File[], optional): Multiple image files (use same field name for all)
- `prompt` (string, optional): Custom prompt for extraction

**Note**: Use either `image` (single) or `images` (multiple). If multiple `images` are provided, results will be returned as an array.

### For JSON Body:
- `image` (string, optional): Base64 encoded image or data URI (single)
- `image_url` (string, optional): URL to the image (single)
- `images` (string[], optional): Array of base64 images or URLs (multiple)
- `prompt` (string, optional): Custom prompt for extraction. Default: optimized menu extraction prompt

**Note**: For JSON requests, provide either:
- Single image: `image` or `image_url`
- Multiple images: `images` array

When multiple images are provided, the response will include a `results` array with extraction results for each image.

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
  -d '{
    "image_url": "https://example.com/menu.jpg"
  }'
```

## Use Cases

- **Menu Digitization**: Extract all menu items with structured data (perfect for restaurant menus)
- **Menu Import**: Convert menu images to JSON for database import
- **OCR for Documents**: Extract text from receipts and documents
- **Structured Data Extraction**: Process scanned documents and extract structured information
- **Menu Management**: Automatically parse menu images into structured format for order systems

## Menu Extraction Example

When you upload a menu image (like `menu_test.jpg`), the worker will:

1. Extract all menu items (40+ items)
2. Parse item IDs (F1, R2, U5, E12, etc.)
3. Extract names, descriptions, and prices
4. Organize items by category/section
5. Return structured JSON ready for database import

The default prompt is optimized for restaurant menus and will extract:
- **All 48 items** from all sections (FUTOMAKI: 8 items, UNA MAKI: 24 items, SIGNATURE ROLL: 10 items, SOYA PAPER ROLL: 6 items)
- Item codes/IDs (F1-F8, U1-U24, R1-R10, E11-E16)
- Item names
- Complete ingredient descriptions
- Prices (including multiple price formats like Roll/Hand Roll for UNA MAKI items)
- Categories and sections
- Special indicators (vegetarian, spicy, etc.)

**Improvements:**
- **Optimized max_tokens to 2048** (2k - from default 256) to prevent timeouts while handling menu items
- **Text-to-JSON parser fallback** - automatically converts text responses to JSON format
- Ultra-concise prompt to minimize processing time and token usage
- Enhanced prompt with explicit item counts and section details
- Improved JSON parsing that handles incomplete or wrapped responses
- Better error handling and validation
- Response includes `item_count` to verify completeness

## Model Information

- **Model**: `@cf/meta/llama-3.2-11b-vision-instruct`
- **Type**: Vision-language model
- **Context Window**: Up to 128,000 tokens
- **Max Output Tokens**: 2,048 tokens (2k - optimized to prevent timeouts)
- **Capabilities**: Text extraction, image understanding, structured data extraction

**Token Configuration:**
- Default `max_tokens` is 256 (too low for large menus)
- This worker sets `max_tokens: 2048` (2k - optimized to prevent timeouts)
- Model supports up to 128,000 tokens total context window (includes both input and output)
- **Important**: Higher values (4k+) cause 504 Gateway Timeout errors (~60s execution limit)
- **Why 2k?**: Processing time increases with max_tokens. 2k tokens is safer for the 60s timeout limit
- **Fallback**: If response is truncated, the text parser will extract items from partial responses
- The prompt is ultra-concise to minimize processing time and token usage

