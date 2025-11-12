/**
 * Cloudflare Worker: Review Submission
 * 
 * Handles review submission with JWT authentication, content filtering,
 * and database insertion via Supabase REST API.
 * 
 * Requires authenticated users (Auth0 JWT token).
 * Reviews are filtered for inappropriate content before insertion.
 */

import { jwtVerify, createRemoteJWKSet } from 'jose'

// Types
interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string // Service role key bypasses RLS (we validate JWT first)
  AUTH0_DOMAIN: string
  AUTH0_AUDIENCE?: string
  AUTH0_CLIENT_ID?: string
}

interface ReviewSubmissionRequest {
  menu_item_id: string
  rating: number // 1-5
  text?: string // Optional review text
}

interface ReviewResponse {
  id: string
  user_id: string
  menu_item_id: string
  rating: number
  text: string | null
  status: string
  created_at: string
}

interface Auth0JWTPayload {
  sub: string
  user_group?: string[]
}

// Auth0 JWT Verification
async function verifyAuth0JWT(
  token: string,
  env: Env
): Promise<Auth0JWTPayload | null> {
  try {
    const JWKS = createRemoteJWKSet(
      new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`)
    )

    const audiences: string[] = []
    if (env.AUTH0_CLIENT_ID) {
      audiences.push(env.AUTH0_CLIENT_ID)
    }
    if (env.AUTH0_AUDIENCE) {
      audiences.push(env.AUTH0_AUDIENCE)
    }
    if (audiences.length === 0) {
      audiences.push(`https://${env.AUTH0_DOMAIN}/api/v2/`)
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      audience: audiences.length === 1 ? audiences[0] : audiences,
    })

    return {
      sub: payload.sub as string,
      user_group: payload.user_group as string[] | undefined,
    }
  } catch (error) {
    console.error('JWT verification failed:', error)
    return null
  }
}

// Content Filtering - Hybrid Approach
// Combines keyword lists, pattern matching, and heuristics
class ContentFilter {
  // Profanity and inappropriate keywords (basic list - can be expanded)
  private static readonly PROFANITY_KEYWORDS = [
    // Add your list of inappropriate words here
    // This is a minimal example - expand based on your needs
  ]

  // Spam patterns
  private static readonly SPAM_PATTERNS = [
    /(http|https|www\.)/gi, // URLs
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
    /\b\d{10,}\b/g, // Long number sequences (phone numbers)
  ]

  // Suspicious patterns
  private static readonly SUSPICIOUS_PATTERNS = [
    /(.)\1{4,}/g, // Repeated characters (aaaaa)
    /[A-Z]{10,}/g, // All caps words
    /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{5,}/g, // Excessive special characters
  ]

  /**
   * Filter review text for inappropriate content
   * Returns: { passed: boolean, reason?: string }
   */
  static filter(text: string | undefined): { passed: boolean; reason?: string } {
    if (!text || text.trim().length === 0) {
      // Empty text is allowed (rating-only reviews)
      return { passed: true }
    }

    const normalizedText = text.toLowerCase().trim()

    // Check length (reasonable limits)
    if (normalizedText.length < 3) {
      return { passed: false, reason: 'Review text is too short' }
    }
    if (normalizedText.length > 2000) {
      return { passed: false, reason: 'Review text is too long (max 2000 characters)' }
    }

    // Check for profanity keywords
    for (const keyword of this.PROFANITY_KEYWORDS) {
      if (normalizedText.includes(keyword.toLowerCase())) {
        return { passed: false, reason: 'Review contains inappropriate content' }
      }
    }

    // Check for spam patterns
    for (const pattern of this.SPAM_PATTERNS) {
      if (pattern.test(text)) {
        return { passed: false, reason: 'Review contains spam content (URLs, emails, or phone numbers)' }
      }
    }

    // Check for suspicious patterns
    let suspiciousCount = 0
    for (const pattern of this.SUSPICIOUS_PATTERNS) {
      const matches = text.match(pattern)
      if (matches) {
        suspiciousCount += matches.length
      }
    }
    
    // Allow some suspicious patterns but flag excessive use
    if (suspiciousCount > 3) {
      return { passed: false, reason: 'Review contains suspicious formatting' }
    }

    // Check for excessive repetition (potential spam)
    const words = normalizedText.split(/\s+/)
    const wordFrequency = new Map<string, number>()
    for (const word of words) {
      wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1)
    }
    
    // If any word appears more than 30% of the time, it's suspicious
    const maxFrequency = Math.max(...Array.from(wordFrequency.values()))
    if (maxFrequency > words.length * 0.3 && words.length > 10) {
      return { passed: false, reason: 'Review contains excessive repetition' }
    }

    // All checks passed
    return { passed: true }
  }

  /**
   * Calculate a content quality score (0-100)
   * Higher score = better quality
   */
  static calculateQualityScore(text: string | undefined): number {
    if (!text || text.trim().length === 0) {
      return 50 // Neutral score for rating-only reviews
    }

    let score = 50 // Base score
    const normalizedText = text.toLowerCase().trim()

    // Length scoring (optimal length: 50-500 characters)
    const length = normalizedText.length
    if (length >= 50 && length <= 500) {
      score += 20
    } else if (length >= 20 && length < 50) {
      score += 10
    } else if (length > 500) {
      score -= 10
    }

    // Word count (more words = better, up to a point)
    const wordCount = normalizedText.split(/\s+/).length
    if (wordCount >= 10 && wordCount <= 100) {
      score += 15
    } else if (wordCount >= 5 && wordCount < 10) {
      score += 5
    }

    // Penalize excessive caps
    const capsRatio = (text.match(/[A-Z]/g) || []).length / text.length
    if (capsRatio > 0.3) {
      score -= 15
    }

    // Penalize excessive special characters
    const specialCharRatio = (text.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g) || []).length / text.length
    if (specialCharRatio > 0.1) {
      score -= 10
    }

    return Math.max(0, Math.min(100, score))
  }
}

// Validate review data
function validateReview(data: ReviewSubmissionRequest): { valid: boolean; error?: string } {
  // Validate menu_item_id
  if (!data.menu_item_id || typeof data.menu_item_id !== 'string') {
    return { valid: false, error: 'menu_item_id is required and must be a string' }
  }

  // Validate UUID format for menu_item_id
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(data.menu_item_id)) {
    return { valid: false, error: 'menu_item_id must be a valid UUID' }
  }

  // Validate rating
  if (typeof data.rating !== 'number' || !Number.isInteger(data.rating)) {
    return { valid: false, error: 'rating must be an integer' }
  }

  if (data.rating < 1 || data.rating > 5) {
    return { valid: false, error: 'rating must be between 1 and 5' }
  }

  // Validate text (optional)
  if (data.text !== undefined && data.text !== null) {
    if (typeof data.text !== 'string') {
      return { valid: false, error: 'text must be a string if provided' }
    }

    // Filter content
    const filterResult = ContentFilter.filter(data.text)
    if (!filterResult.passed) {
      return { valid: false, error: filterResult.reason || 'Review text failed content filter' }
    }
  }

  return { valid: true }
}

// Check if menu item exists
async function validateMenuItem(
  menuItemId: string,
  env: Env
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Use anon key for reading menu items (public data)
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/menu_item?id=eq.${menuItemId}&visible=eq.true&select=id`,
      {
        headers: {
          'apikey': env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.ok) {
      return { valid: false, error: 'Failed to validate menu item' }
    }

    const items = await response.json() as any[]
    if (items.length === 0) {
      return { valid: false, error: 'Menu item not found or not visible' }
    }

    return { valid: true }
  } catch (error) {
    console.error('Menu item validation error:', error)
    return { valid: false, error: 'Failed to validate menu item' }
  }
}

// Check if user already has a review for this menu item
async function checkExistingReview(
  userId: string,
  menuItemId: string,
  env: Env
): Promise<{ exists: boolean; review?: any }> {
  try {
    // Use service_role key to check for existing reviews (we've validated JWT already)
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/review?user_id=eq.${userId}&menu_item_id=eq.${menuItemId}&select=id,status`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.ok) {
      return { exists: false }
    }

    const reviews = await response.json() as any[]
    if (reviews.length > 0) {
      return { exists: true, review: reviews[0] }
    }

    return { exists: false }
  } catch (error) {
    console.error('Check existing review error:', error)
    return { exists: false }
  }
}

// Create review in Supabase
async function createReview(
  reviewData: {
    user_id: string
    menu_item_id: string
    rating: number
    text: string | null
  },
  env: Env
): Promise<ReviewResponse> {
  // Use service_role key - we've already validated the JWT in the worker
  // This bypasses RLS, but we've verified:
  // 1. The JWT is valid (verified in verifyAuth0JWT)
  // 2. The user_id matches the JWT sub claim
  // 3. The review data is validated
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      user_id: reviewData.user_id,
      menu_item_id: reviewData.menu_item_id,
      rating: reviewData.rating,
      text: reviewData.text || null,
      status: 'pending', // All reviews start as pending (moderation happens externally)
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create review: ${response.status} ${error}`)
  }

  const reviews = await response.json()
  return Array.isArray(reviews) ? reviews[0] : reviews
}

// Main handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      // Require authentication
      const authHeader = request.headers.get('Authorization')
      
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Authentication required. Please provide a valid JWT token.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Verify Auth0 JWT
      const token = authHeader.substring(7)
      const jwtPayload = await verifyAuth0JWT(token, env)
      
      if (!jwtPayload) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const userId = jwtPayload.sub

      // Parse request body
      const body: ReviewSubmissionRequest = await request.json()
      const { menu_item_id, rating, text } = body

      // Validate review data
      const validation = validateReview({ menu_item_id, rating, text })
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Validate menu item exists
      const menuItemValidation = await validateMenuItem(menu_item_id, env)
      if (!menuItemValidation.valid) {
        return new Response(
          JSON.stringify({ error: menuItemValidation.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Check if user already has a review for this menu item
      const existingReview = await checkExistingReview(userId, menu_item_id, env)
      if (existingReview.exists) {
        return new Response(
          JSON.stringify({ 
            error: 'You have already submitted a review for this menu item',
            existing_review_id: existingReview.review?.id,
            existing_review_status: existingReview.review?.status,
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Calculate content quality score (for logging/monitoring)
      const qualityScore = ContentFilter.calculateQualityScore(text)
      console.log(`Review quality score: ${qualityScore}`)

      // Create review
      const review = await createReview(
        {
          user_id: userId,
          menu_item_id,
          rating,
          text: text || null,
        },
        env
      )

      // Return response
      return new Response(JSON.stringify(review), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (error: any) {
      console.error('Review submission error:', error)
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

