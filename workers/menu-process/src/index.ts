/**
 * Cloudflare Worker: Menu Process - Text Extraction
 * 
 * Uses Cloudflare AI Workers with @cf/meta/llama-3.2-11b-vision-instruct
 * to extract text from images (e.g., menu images, receipts, documents).
 */

// Types
interface Env {
  // No environment variables required for Cloudflare AI
  // AI binding is automatically available in Cloudflare Workers
}

interface TextExtractionRequest {
  image?: string // Base64 encoded image or image URL
  image_url?: string // Alternative: direct image URL
  prompt?: string // Optional custom prompt for extraction
}

interface MenuItem {
  id?: string
  name: string
  description?: string
  price: string
  category?: string
  section?: string
}

interface MenuExtraction {
  items: MenuItem[]
  categories?: string[]
  sections?: string[]
}

interface TextExtractionResponse {
  text: string
  json?: MenuExtraction | any
  parse_error?: string
  item_count?: number
  model: string
  processed_at: string
}


// Extract text from image using Cloudflare AI
async function extractText(
  imageInput: string | ArrayBuffer,
  prompt: string,
  env: Env & { AI: any }
): Promise<string> {
  try {
    // Cloudflare AI can accept either a URL or image bytes
    let imageParam: string | number[]
    
    if (typeof imageInput === 'string') {
      // String input: URL or base64
      if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
        // Pass URL directly - Cloudflare AI can fetch it
        imageParam = imageInput
      } else {
        // Convert base64 to array of bytes
        let base64Data = imageInput
        if (imageInput.startsWith('data:image/')) {
          base64Data = imageInput.split(',')[1]
        }
        const binaryString = atob(base64Data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        imageParam = Array.from(bytes)
      }
    } else {
      // ArrayBuffer input: convert to array of bytes
      const bytes = new Uint8Array(imageInput)
      imageParam = Array.from(bytes)
    }

    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      image: imageParam,
      prompt: prompt,
      max_tokens: 4096, // 4k tokens - optimized to prevent timeouts while handling 48+ items
      // Note: Higher values (8k+) cause 504 Gateway Timeout errors (~60s limit)
      // 4k tokens = ~3000 words, sufficient for 48 menu items with concise JSON
    })

    // The response structure may vary, handle different formats
    if (typeof response === 'string') {
      return response
    }
    
    if (response.description || response.text) {
      return response.description || response.text
    }
    
    if (response.response) {
      return typeof response.response === 'string' 
        ? response.response 
        : JSON.stringify(response.response)
    }
    
    // Fallback: stringify the entire response
    return JSON.stringify(response, null, 2)
  } catch (error: any) {
    console.error('AI extraction error:', error)
    throw new Error(`Text extraction failed: ${error.message}`)
  }
}

// Main handler
export default {
  async fetch(request: Request, env: Env & { AI: any }): Promise<Response> {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    try {
      const contentType = request.headers.get('content-type') || ''
      let imageInput: string | ArrayBuffer
      let prompt: string | undefined

      // Handle multipart/form-data (file upload from Postman)
      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData()
        const file = formData.get('image') as File | null
        const promptField = formData.get('prompt') as string | null

        if (!file) {
          return new Response(
            JSON.stringify({ error: 'No image file provided. Please attach a file with the field name "image".' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Convert file to ArrayBuffer
        imageInput = await file.arrayBuffer()
        prompt = promptField || undefined
      } else {
        // Handle JSON body (existing format)
        const body: TextExtractionRequest = await request.json()
        const { image, image_url, prompt: bodyPrompt } = body

        // Validate input
        if (!image && !image_url) {
          return new Response(
            JSON.stringify({ error: 'Either "image" or "image_url" is required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Get image input
        imageInput = image || image_url!
        prompt = bodyPrompt

        // Validate image input format (only for string inputs)
        if (typeof imageInput === 'string') {
          const isValidUrl = imageInput.startsWith('http://') || imageInput.startsWith('https://')
          const isValidBase64 = imageInput.startsWith('data:image/') || /^[A-Za-z0-9+/=]+$/.test(imageInput.split(',')[1] || imageInput)

          if (!isValidUrl && !isValidBase64) {
            return new Response(
              JSON.stringify({ error: 'Invalid image format. Please provide a valid image URL or base64 encoded image.' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
        }
      }

      // Default prompt for menu extraction with JSON output
      // Ultra-concise to minimize processing time and token usage
      const extractionPrompt = prompt || 
        `Extract all 48 menu items. Return ONLY JSON, no text.

Sections: FUTOMAKI (F1-F8), UNA MAKI (U1-U24), SIGNATURE ROLL (R1-R10), SOYA PAPER ROLL (E11-E16).

Format: {"items":[{"id":"F1","name":"Name","description":"ingredients","price":"$8.99","category":"FUTOMAKI","section":"FUTOMAKI"}],"categories":["FUTOMAKI","UNA MAKI","SIGNATURE ROLL","SOYA PAPER ROLL"],"sections":["FUTOMAKI","UNA MAKI","SIGNATURE ROLL","SOYA PAPER ROLL"]}

Rules: All 48 items, exact IDs, UNA MAKI prices: "ROLL $X.XX, HAND ROLL $X.XX", complete JSON only.`

      // Extract text using AI
      const extractedText = await extractText(imageInput, extractionPrompt, env)

      // Try to parse JSON from the response
      let parsedJson: any = null
      let parseError: string | null = null
      try {
        // Try to extract JSON from the response (might be wrapped in markdown code blocks or have extra text)
        let jsonText = extractedText.trim()
        
        // Remove any leading text before the JSON
        const jsonStart = jsonText.indexOf('{')
        if (jsonStart > 0) {
          jsonText = jsonText.substring(jsonStart)
        }
        
        // Remove markdown code blocks if present
        if (jsonText.includes('```json')) {
          const codeBlockMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/)
          if (codeBlockMatch) {
            jsonText = codeBlockMatch[1].trim()
          }
        } else if (jsonText.includes('```')) {
          const codeBlockMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/)
          if (codeBlockMatch) {
            jsonText = codeBlockMatch[1].trim()
          }
        }
        
        // Try to find the complete JSON object
        let braceCount = 0
        let jsonEnd = -1
        for (let i = 0; i < jsonText.length; i++) {
          if (jsonText[i] === '{') braceCount++
          if (jsonText[i] === '}') {
            braceCount--
            if (braceCount === 0) {
              jsonEnd = i + 1
              break
            }
          }
        }
        
        if (jsonEnd > 0) {
          jsonText = jsonText.substring(0, jsonEnd)
        } else {
          // Fallback: try to find JSON object with regex
          const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            jsonText = jsonMatch[0]
          }
        }
        
        parsedJson = JSON.parse(jsonText)
        
        // Validate that we got items
        if (parsedJson && parsedJson.items && Array.isArray(parsedJson.items)) {
          console.log(`Successfully extracted ${parsedJson.items.length} menu items`)
        }
      } catch (error: any) {
        // If JSON parsing fails, log the error but continue
        parseError = error.message
        console.warn('Failed to parse JSON from response:', error.message)
        console.warn('Response text length:', extractedText.length)
        console.warn('First 500 chars:', extractedText.substring(0, 500))
      }

      // Return response
      const response: TextExtractionResponse = {
        text: extractedText,
        json: parsedJson,
        parse_error: parseError || undefined,
        item_count: parsedJson?.items?.length || undefined,
        model: '@cf/meta/llama-3.2-11b-vision-instruct',
        processed_at: new Date().toISOString(),
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (error: any) {
      console.error('Text extraction error:', error)
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

