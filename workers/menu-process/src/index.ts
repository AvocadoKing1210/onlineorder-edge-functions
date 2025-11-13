/**
 * Cloudflare Worker: Menu Process - Text Extraction
 * 
 * Uses Cloudflare AI Workers with @cf/meta/llama-3.2-11b-vision-instruct
 * to extract text from images (e.g., menu images, receipts, documents).
 */

// Types
interface Env {
  AI?: any // Cloudflare AI binding
  MENU_PROCESS_RATE_LIMITER?: any // Rate limiter binding
  ALLOWED_ORIGINS?: string // Comma-separated list of allowed origins
  API_KEY?: string // API key for server-to-server authentication
  ALLOWED_IMAGE_DOMAINS?: string // Comma-separated list of allowed image URL domains (optional, for SSRF protection)
}

interface TextExtractionRequest {
  image?: string | string[] // Base64 encoded image(s) or image URL(s)
  image_url?: string | string[] // Alternative: direct image URL(s)
  images?: string[] // Array of base64 images or URLs
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

interface ImageExtractionResult {
  image_index?: number
  text: string
  json?: MenuExtraction | any
  parse_error?: string
  item_count?: number
}

interface TextExtractionResponse {
  results?: ImageExtractionResult[] // For multiple images
  text?: string // For single image (backward compatibility)
  json?: MenuExtraction | any // For single image (backward compatibility)
  parse_error?: string
  item_count?: number
  total_items?: number // For multiple images
  model: string
  processed_at: string
}


// Parse text response into JSON structure (fallback when model returns text instead of JSON)
function parseTextToJSON(text: string): MenuExtraction | null {
  try {
    const items: MenuItem[] = []
    const categories = new Set<string>()
    
    // Parse sections
    const futomakiMatch = text.match(/\*\*Futomaki Section\*\*([\s\S]*?)(?=\*\*Una Maki Section\*\*|\*\*Signature Roll Section\*\*|$)/i)
    const unaMakiMatch = text.match(/\*\*Una Maki Section\*\*([\s\S]*?)(?=\*\*Signature Roll Section\*\*|\*\*Soya Paper Roll Section\*\*|$)/i)
    const signatureMatch = text.match(/\*\*Signature Roll Section\*\*([\s\S]*?)(?=\*\*Soya Paper Roll Section\*\*|$)/i)
    const soyaMatch = text.match(/\*\*Soya Paper Roll Section\*\*([\s\S]*?)(?=The total|$)/i)
    
    // Helper to parse items from section text
    const parseSection = (sectionText: string, category: string, idPrefix: string) => {
      if (!sectionText) return
      categories.add(category)
      
      // Match items like: * F1. Name: $price
      const itemRegex = new RegExp(`\\*\\s*(${idPrefix}\\d+)\\.\\s*([^:]+):\\s*\\$([\\d.]+)`, 'g')
      let match
      
      while ((match = itemRegex.exec(sectionText)) !== null) {
        const id = match[1]
        const name = match[2].trim()
        const price = `$${match[3]}`
        
        // Find ingredients (usually on next line with + or tab)
        const itemEnd = match.index + match[0].length
        const nextItem = sectionText.indexOf('*', itemEnd)
        const itemBlock = sectionText.substring(itemEnd, nextItem > 0 ? nextItem : sectionText.length)
        const ingredientsMatch = itemBlock.match(/[+\t]+Ingredients?:\s*(.+?)(?=\n\n|\n\*|$)/is)
        const description = ingredientsMatch ? ingredientsMatch[1].trim() : ''
        
        items.push({
          id,
          name,
          description,
          price,
          category,
          section: category
        })
      }
    }
    
    if (futomakiMatch) parseSection(futomakiMatch[1], 'FUTOMAKI', 'F')
    if (unaMakiMatch) parseSection(unaMakiMatch[1], 'UNA MAKI', 'U')
    if (signatureMatch) parseSection(signatureMatch[1], 'SIGNATURE ROLL', 'R')
    if (soyaMatch) parseSection(soyaMatch[1], 'SOYA PAPER ROLL', 'E')
    
    if (items.length > 0) {
      return {
        items,
        categories: Array.from(categories),
        sections: Array.from(categories)
      }
    }
    
    return null
  } catch (error) {
    console.warn('Failed to parse text to JSON:', error)
    return null
  }
}

// Validate URL to prevent SSRF attacks
function isValidImageUrl(url: string, env: Env): { valid: boolean; reason?: string } {
  try {
    const urlObj = new URL(url)
    
    // Only allow http/https protocols
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { valid: false, reason: 'Only http and https protocols are allowed' }
    }
    
    // Block private IP addresses (SSRF protection)
    const hostname = urlObj.hostname
    const privateIPPatterns = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/,
      /^localhost$/i,
    ]
    
    for (const pattern of privateIPPatterns) {
      if (pattern.test(hostname)) {
        return { valid: false, reason: 'Private/internal IP addresses are not allowed' }
      }
    }
    
    // If allowed domains are configured, check against whitelist
    if (env.ALLOWED_IMAGE_DOMAINS) {
      const allowedDomains = env.ALLOWED_IMAGE_DOMAINS.split(',').map(d => d.trim().toLowerCase())
      const hostnameLower = hostname.toLowerCase()
      
      const isAllowed = allowedDomains.some(domain => {
        // Support exact match or subdomain match
        return hostnameLower === domain || hostnameLower.endsWith('.' + domain)
      })
      
      if (!isAllowed) {
        return { valid: false, reason: 'Image URL domain is not in allowed list' }
      }
    }
    
    return { valid: true }
  } catch (error) {
    return { valid: false, reason: 'Invalid URL format' }
  }
}

// Sanitize prompt to prevent prompt injection
function sanitizePrompt(prompt: string | undefined): string {
  if (!prompt) {
    return '' // Will use default prompt
  }
  
  // Remove potential prompt injection patterns
  const injectionPatterns = [
    /ignore\s+(previous|all|the)\s+(instructions?|prompts?|rules?)/gi,
    /you\s+are\s+now/gi,
    /forget\s+(previous|all|the)/gi,
    /system\s*:\s*/gi,
    /assistant\s*:\s*/gi,
  ]
  
  let sanitized = prompt
  
  for (const pattern of injectionPatterns) {
    if (pattern.test(sanitized)) {
      // If injection pattern detected, reject the custom prompt and use default
      console.warn('Prompt injection attempt detected in custom prompt, using default prompt')
      return '' // Will trigger default prompt
    }
  }
  
  // Limit prompt length to prevent flooding
  const MAX_PROMPT_LENGTH = 500
  if (sanitized.length > MAX_PROMPT_LENGTH) {
    sanitized = sanitized.substring(0, MAX_PROMPT_LENGTH)
  }
  
  return sanitized
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
        // Validate URL to prevent SSRF
        const urlValidation = isValidImageUrl(imageInput, env)
        if (!urlValidation.valid) {
          throw new Error(`Invalid image URL: ${urlValidation.reason}`)
        }
        // Pass URL directly - Cloudflare AI can fetch it (after validation)
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
      max_tokens: 2048, // 2k tokens - reduced to prevent timeouts (60s limit)
      // Note: Processing time increases with max_tokens, 2k is safer for timeout limits
      // Text parser fallback will handle cases where response is truncated
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

// Get CORS headers based on request origin and allowed origins
function getCorsHeaders(request: Request, env: Env): { headers: Record<string, string>; allowed: boolean } {
  const origin = request.headers.get('Origin')
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : []

  // If no allowed origins configured, allow all (backward compatibility)
  // In production, you should always set ALLOWED_ORIGINS
  let allowOrigin = '*'
  let isAllowed = true

  if (allowedOrigins.length > 0) {
    // If origin is provided and is in allowed list, use it
    if (origin && allowedOrigins.includes(origin)) {
      allowOrigin = origin
      isAllowed = true
    } else if (origin) {
      // Origin provided but not allowed - deny CORS
      isAllowed = false
      return { headers: {}, allowed: false }
    } else {
      // No origin header (same-origin request) - allow it
      allowOrigin = '*'
      isAllowed = true
    }
  }

  return {
    headers: {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    },
    allowed: isAllowed,
  }
}

// Main handler
export default {
  async fetch(request: Request, env: Env & { AI: any }): Promise<Response> {
    // Verify API key if configured (for server-to-server requests from Next.js)
    if (env.API_KEY) {
      const apiKey = request.headers.get('X-API-Key')
      if (!apiKey || apiKey !== env.API_KEY) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized: Invalid API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }
    }

    // Get CORS headers based on origin
    const cors = getCorsHeaders(request, env)
    const corsHeaders = cors.headers

    // Handle OPTIONS request (CORS preflight)
    if (request.method === 'OPTIONS') {
      // If origin is not allowed, return 403
      if (!cors.allowed) {
        return new Response(null, { status: 403 })
      }
      return new Response(null, { headers: corsHeaders })
    }

    // For actual requests, if origin is not allowed, return 403
    // Note: API key requests (from Next.js) bypass CORS check
    if (!env.API_KEY && !cors.allowed) {
      return new Response(
        JSON.stringify({ error: 'Origin not allowed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate request body size (prevent DoS)
    const contentLength = request.headers.get('Content-Length')
    const MAX_BODY_SIZE = 1024 * 1024 * 10 // 10MB (images can be large)
    if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Request body too large. Maximum size is 10MB.' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    try {
      // Rate limiting - critical for expensive AI processing
      if (env.MENU_PROCESS_RATE_LIMITER) {
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
        const { success } = await env.MENU_PROCESS_RATE_LIMITER.limit({ key: clientIP })

        if (!success) {
          return new Response(
            JSON.stringify({
              error: 'Rate limit exceeded. Please try again later.',
              retry_after: 60
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Retry-After': '60'
              }
            }
          )
        }
      }
      const contentType = request.headers.get('content-type') || ''
      const isMultipart = contentType.includes('multipart/form-data')
      let imageInput: string | ArrayBuffer
      let prompt: string | undefined

      // Default prompt for menu extraction with JSON output
      // Ultra-concise to minimize processing time and token usage
      const defaultPrompt = `You must return ONLY valid JSON. No text before, no text after, no explanations, no markdown code blocks.

Required format:
{"items":[{"id":"F1","name":"Item","description":"ingredients","price":"$8.99","category":"FUTOMAKI","section":"FUTOMAKI"}],"categories":["FUTOMAKI","UNA MAKI","SIGNATURE ROLL","SOYA PAPER ROLL"],"sections":["FUTOMAKI","UNA MAKI","SIGNATURE ROLL","SOYA PAPER ROLL"]}

Extract all 48 items: FUTOMAKI (F1-F8), UNA MAKI (U1-U24), SIGNATURE ROLL (R1-R10), SOYA PAPER ROLL (E11-E16). UNA MAKI prices: "ROLL $X.XX, HAND ROLL $X.XX".

CRITICAL: Your response must be ONLY the JSON object. Do not include "Here is", "The JSON is", or any other text. Start directly with { and end with }.`

      const getExtractionPrompt = (customPrompt?: string) => {
        if (!customPrompt) {
          return defaultPrompt
        }
        // Sanitize custom prompt to prevent injection
        const sanitized = sanitizePrompt(customPrompt)
        // If sanitization removed the prompt (injection detected), use default
        return sanitized || defaultPrompt
      }

      // Handle multipart/form-data (file upload from Postman)
      if (isMultipart) {
        let formData: FormData
        try {
          formData = await request.formData()
        } catch (formError: any) {
          return new Response(
            JSON.stringify({ 
              error: 'Failed to parse form-data. Please ensure the file is properly attached.',
              details: formError.message,
              content_type: contentType
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const imageField = formData.get('image')
        const imagesField = formData.getAll('images') // Support multiple files with same name
        const promptField = formData.get('prompt') as string | null

        // Support both single file and multiple files
        const files: File[] = []
        if (imageField && typeof imageField === 'object' && 'arrayBuffer' in imageField) {
          files.push(imageField as File)
        }
        if (imagesField.length > 0) {
          imagesField.forEach(field => {
            if (field && typeof field === 'object' && 'arrayBuffer' in field) {
              files.push(field as File)
            }
          })
        }

        if (files.length === 0) {
          // Debug: log what fields we found
          const allFields: string[] = []
          formData.forEach((value, key) => {
            const isFile = value && typeof value === 'object' && 'name' in value && 'arrayBuffer' in value
            const fileInfo = isFile ? `File(${(value as File).name})` : typeof value
            allFields.push(`${key}: ${fileInfo}`)
          })
          
          return new Response(
            JSON.stringify({ 
              error: 'No image file(s) provided. Please attach file(s) with field name "image" or "images".',
              found_fields: allFields,
              content_type: contentType
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        prompt = promptField || undefined
        const extractionPrompt = getExtractionPrompt(prompt)

        // Process multiple images
        if (files.length > 1) {
          const results: ImageExtractionResult[] = []
          let totalItems = 0

          for (let i = 0; i < files.length; i++) {
            try {
              const fileInput = await files[i].arrayBuffer()
              const extractedText = await extractText(fileInput, extractionPrompt, env)
              
              // Parse JSON for this image
              let parsedJson: any = null
              let parseError: string | null = null
              try {
                let jsonText = extractedText.trim()
                const jsonStart = jsonText.indexOf('{')
                if (jsonStart > 0) {
                  jsonText = jsonText.substring(jsonStart)
                }
                
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
                
                let braceCount = 0
                let jsonEnd = -1
                for (let j = 0; j < jsonText.length; j++) {
                  if (jsonText[j] === '{') braceCount++
                  if (jsonText[j] === '}') {
                    braceCount--
                    if (braceCount === 0) {
                      jsonEnd = j + 1
                      break
                    }
                  }
                }
                
                if (jsonEnd > 0) {
                  jsonText = jsonText.substring(0, jsonEnd)
                } else {
                  const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
                  if (jsonMatch) {
                    jsonText = jsonMatch[0]
                  }
                }
                
                parsedJson = JSON.parse(jsonText)
                if (parsedJson?.items) {
                  totalItems += parsedJson.items.length
                }
              } catch (error: any) {
                parseError = error.message
                // Try text parsing as fallback
                const textParsed = parseTextToJSON(extractedText)
                if (textParsed && textParsed.items && textParsed.items.length > 0) {
                  parsedJson = textParsed
                  totalItems += textParsed.items.length
                  parseError = `JSON parse failed, but extracted ${textParsed.items.length} items from text format`
                }
              }

              results.push({
                image_index: i,
                text: extractedText,
                json: parsedJson,
                parse_error: parseError || undefined,
                item_count: parsedJson?.items?.length || undefined,
              })
            } catch (error: any) {
              results.push({
                image_index: i,
                text: '',
                parse_error: error.message,
                item_count: 0,
              })
            }
          }

          const response: TextExtractionResponse = {
            results,
            total_items: totalItems,
            model: '@cf/meta/llama-3.2-11b-vision-instruct',
            processed_at: new Date().toISOString(),
          }

          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }

        // Single file - continue with existing flow
        imageInput = await files[0].arrayBuffer()
      } else {
        // Handle JSON body (existing format)
        // But first check if this might be a multipart request that wasn't detected
        const bodyText = await request.text()
        
        if (!bodyText || bodyText.trim().length === 0) {
          return new Response(
            JSON.stringify({ 
              error: 'Request body is empty. Please provide image data.',
              content_type: contentType,
              hint: 'If uploading a file, ensure Content-Type is "multipart/form-data"'
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        
        // Check if body looks like multipart but wasn't detected
        if (bodyText.includes('Content-Disposition: form-data') && !isMultipart) {
          return new Response(
            JSON.stringify({ 
              error: 'Detected form-data in body but Content-Type header is missing or incorrect.',
              content_type: contentType,
              hint: 'Ensure your request includes: Content-Type: multipart/form-data'
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        
        let body: TextExtractionRequest
        try {
          body = JSON.parse(bodyText)
        } catch (parseError: any) {
          return new Response(
            JSON.stringify({ 
              error: 'Invalid JSON in request body. Please check your request format.',
              details: parseError.message,
              content_type: contentType
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        
        const { image, image_url, images, prompt: bodyPrompt } = body

        prompt = bodyPrompt

        // Support multiple images via arrays
        if (images && Array.isArray(images) && images.length > 0) {
          // Multiple images provided
          const extractionPrompt = getExtractionPrompt(prompt)
          const results: ImageExtractionResult[] = []
          let totalItems = 0

          for (let i = 0; i < images.length; i++) {
            try {
              const img = images[i]
              let imgInput: string | ArrayBuffer
              
              // Handle URL or base64
              if (typeof img === 'string') {
                // Validate URL if it's a URL (SSRF protection)
                if (img.startsWith('http://') || img.startsWith('https://')) {
                  const urlValidation = isValidImageUrl(img, env)
                  if (!urlValidation.valid) {
                    results.push({
                      image_index: i,
                      text: '',
                      parse_error: `Invalid image URL: ${urlValidation.reason}`,
                      item_count: 0,
                    })
                    continue
                  }
                }
                imgInput = img
              } else {
                continue // Skip invalid entries
              }

              const extractedText = await extractText(imgInput, extractionPrompt, env)
              
              // Parse JSON for this image
              let parsedJson: any = null
              let parseError: string | null = null
              try {
                let jsonText = extractedText.trim()
                const jsonStart = jsonText.indexOf('{')
                if (jsonStart > 0) {
                  jsonText = jsonText.substring(jsonStart)
                }
                
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
                
                let braceCount = 0
                let jsonEnd = -1
                for (let j = 0; j < jsonText.length; j++) {
                  if (jsonText[j] === '{') braceCount++
                  if (jsonText[j] === '}') {
                    braceCount--
                    if (braceCount === 0) {
                      jsonEnd = j + 1
                      break
                    }
                  }
                }
                
                if (jsonEnd > 0) {
                  jsonText = jsonText.substring(0, jsonEnd)
                } else {
                  const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
                  if (jsonMatch) {
                    jsonText = jsonMatch[0]
                  }
                }
                
                parsedJson = JSON.parse(jsonText)
                if (parsedJson?.items) {
                  totalItems += parsedJson.items.length
                }
              } catch (error: any) {
                parseError = error.message
                // Try text parsing as fallback
                const textParsed = parseTextToJSON(extractedText)
                if (textParsed && textParsed.items && textParsed.items.length > 0) {
                  parsedJson = textParsed
                  totalItems += textParsed.items.length
                  parseError = `JSON parse failed, but extracted ${textParsed.items.length} items from text format`
                }
              }

              results.push({
                image_index: i,
                text: extractedText,
                json: parsedJson,
                parse_error: parseError || undefined,
                item_count: parsedJson?.items?.length || undefined,
              })
            } catch (error: any) {
              results.push({
                image_index: i,
                text: '',
                parse_error: error.message,
                item_count: 0,
              })
            }
          }

          const response: TextExtractionResponse = {
            results,
            total_items: totalItems,
            model: '@cf/meta/llama-3.2-11b-vision-instruct',
            processed_at: new Date().toISOString(),
          }

          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }

        // Single image - check for array or single value
        const singleImage = Array.isArray(image) ? image[0] : image
        const singleImageUrl = Array.isArray(image_url) ? image_url[0] : image_url

        // Validate input
        if (!singleImage && !singleImageUrl) {
          return new Response(
            JSON.stringify({ error: 'Either "image", "image_url", or "images" array is required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        // Get image input
        imageInput = singleImage || singleImageUrl!

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

          // If it's a URL, validate it for SSRF protection
          if (isValidUrl) {
            const urlValidation = isValidImageUrl(imageInput, env)
            if (!urlValidation.valid) {
              return new Response(
                JSON.stringify({ error: `Invalid image URL: ${urlValidation.reason}` }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              )
            }
          }
        }
      }

      // Extract text using AI (single image)
      const extractionPrompt = getExtractionPrompt(prompt)
      const extractedText = await extractText(imageInput, extractionPrompt, env)

      // Try to parse JSON from the response
      let parsedJson: any = null
      let parseError: string | null = null
      try {
        // Try to extract JSON from the response (might be wrapped in markdown code blocks or have extra text)
        let jsonText = extractedText.trim()
        
        // First, try to extract from markdown code blocks (most common case)
        if (jsonText.includes('```json')) {
          const codeBlockMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/g)
          if (codeBlockMatch && codeBlockMatch.length > 0) {
            // Get the largest JSON block (most likely to be complete)
            const largestBlock = codeBlockMatch.reduce((a, b) => a.length > b.length ? a : b)
            jsonText = largestBlock.replace(/```json\s*/, '').replace(/\s*```/, '').trim()
          }
        } else if (jsonText.includes('```')) {
          const codeBlockMatch = jsonText.match(/```\s*([\s\S]*?)\s*```/g)
          if (codeBlockMatch && codeBlockMatch.length > 0) {
            // Find the block that contains JSON (has { and })
            const jsonBlock = codeBlockMatch.find(block => block.includes('{') && block.includes('}'))
            if (jsonBlock) {
              jsonText = jsonBlock.replace(/```\s*/, '').replace(/\s*```/, '').trim()
            }
          }
        }
        
        // Remove any text before the first { (aggressive cleanup)
        const firstBrace = jsonText.indexOf('{')
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace)
        }
        
        // Remove any text after the last } (aggressive cleanup)
        const lastBrace = jsonText.lastIndexOf('}')
        if (lastBrace >= 0 && lastBrace < jsonText.length - 1) {
          jsonText = jsonText.substring(0, lastBrace + 1)
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
        // If JSON parsing fails, try to parse text format as fallback
        parseError = error.message
        console.warn('Failed to parse JSON from response, attempting text parsing:', error.message)
        
        // Try to parse the text response into JSON structure
        const textParsed = parseTextToJSON(extractedText)
        if (textParsed && textParsed.items && textParsed.items.length > 0) {
          parsedJson = textParsed
          parseError = `JSON parse failed, but extracted ${textParsed.items.length} items from text format`
          console.log(`Successfully parsed ${textParsed.items.length} items from text format`)
        } else {
          console.warn('Response text length:', extractedText.length)
          console.warn('First 500 chars:', extractedText.substring(0, 500))
        }
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
      // Log full error details server-side for debugging
      console.error('Text extraction error:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      })

      // Return generic error message to client (don't expose internal details)
      // Only expose specific error messages for known validation errors
      const errorMessage = error.message || 'Internal server error'
      const isKnownError = errorMessage.includes('Invalid image') ||
                          errorMessage.includes('URL') ||
                          errorMessage.includes('format') ||
                          errorMessage.includes('too large') ||
                          errorMessage.includes('required')

      return new Response(
        JSON.stringify({
          error: isKnownError ? errorMessage : 'An error occurred while processing the image. Please try again.'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

