/**
 * Cloudflare Worker: User Profile Management
 * 
 * Handles user profile creation and updates, typically used during checkout.
 * Supports both authenticated users (via Auth0 JWT) and guest users.
 * 
 * For authenticated users: Uses Auth0 user ID (sub claim) as the profile ID
 * For guest users: Creates/updates profile with provided user_id
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
  PROFILE_RATE_LIMITER?: any // Rate limiter binding
  ALLOWED_ORIGINS?: string // Comma-separated list of allowed origins
  API_KEY?: string // API key for server-to-server authentication (from Next.js proxy)
}

interface UserProfileRequest {
  // user_id comes from JWT sub claim (authenticated users only)
  // Profile fields (all optional for updates)
  email?: string
  display_name?: string
  avatar_url?: string
  phone_number?: string
  preferred_locale?: string
}

interface UserProfileResponse {
  id: string
  email: string
  display_name?: string
  avatar_url?: string
  phone_number?: string
  preferred_locale: string
  created_at: string
  updated_at: string
}

// Auth0 JWT Verification
async function verifyAuth0JWT(
  token: string,
  env: Env
): Promise<{ sub: string; email?: string; name?: string; picture?: string } | null> {
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
      email: payload.email as string | undefined,
      name: payload.name as string | undefined,
      picture: payload.picture as string | undefined,
    }
  } catch (error) {
    console.error('JWT verification failed:', error)
    return null
  }
}

// Get existing user profile
async function getUserProfile(
  userId: string,
  env: Env
): Promise<UserProfileResponse | null> {
  // Use service_role key - we've already validated the JWT in the worker
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_profile?id=eq.${userId}`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  )

  if (!response.ok) {
    return null
  }

  const profiles = await response.json() as UserProfileResponse[]
  return profiles.length > 0 ? profiles[0] : null
}

// Create user profile
async function createUserProfile(
  profileData: {
    id: string
    email: string
    display_name?: string
    avatar_url?: string
    phone_number?: string
    preferred_locale?: string
  },
  env: Env
): Promise<UserProfileResponse> {
  // Use service_role key - we've already validated the JWT in the worker
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/user_profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      id: profileData.id,
      email: profileData.email,
      display_name: profileData.display_name || null,
      avatar_url: profileData.avatar_url || null,
      phone_number: profileData.phone_number || null,
      preferred_locale: profileData.preferred_locale || 'en',
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create user profile: ${response.status} ${error}`)
  }

  const profiles = await response.json()
  return Array.isArray(profiles) ? profiles[0] : profiles
}

// Update user profile
async function updateUserProfile(
  userId: string,
  updates: {
    email?: string
    display_name?: string
    avatar_url?: string
    phone_number?: string
    preferred_locale?: string
  },
  env: Env
): Promise<UserProfileResponse> {
  // Build update object, only including provided fields
  const updateData: any = {}
  if (updates.email !== undefined) updateData.email = updates.email
  if (updates.display_name !== undefined) updateData.display_name = updates.display_name || null
  if (updates.avatar_url !== undefined) updateData.avatar_url = updates.avatar_url || null
  if (updates.phone_number !== undefined) updateData.phone_number = updates.phone_number || null
  if (updates.preferred_locale !== undefined) updateData.preferred_locale = updates.preferred_locale

  // Use service_role key - we've already validated the JWT in the worker
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_profile?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(updateData),
    }
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to update user profile: ${response.status} ${error}`)
  }

  const profiles = await response.json()
  return Array.isArray(profiles) ? profiles[0] : profiles
}

// Validate email format
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email) && email.length <= 255
}

// Validate phone number format (basic validation)
function isValidPhone(phone: string): boolean {
  // Allow international format: +1234567890 or basic format
  const phoneRegex = /^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/
  return phoneRegex.test(phone) && phone.length <= 20
}

// Validate URL format
function isValidUrl(url: string): boolean {
  try {
    const urlObj = new URL(url)
    // Only allow http/https protocols
    return (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') && url.length <= 500
  } catch {
    return false
  }
}

// Validate locale format
function isValidLocale(locale: string): boolean {
  // Basic locale validation (e.g., en, en-US, zh-CN)
  const localeRegex = /^[a-z]{2}(-[A-Z]{2})?$/
  return localeRegex.test(locale) && locale.length <= 10
}

// Validate profile input data
function validateProfileInput(data: UserProfileRequest): { valid: boolean; error?: string } {
  // Validate email if provided
  if (data.email !== undefined && data.email !== null && data.email !== '') {
    if (!isValidEmail(data.email)) {
      return { valid: false, error: 'Invalid email format' }
    }
  }

  // Validate display_name if provided
  if (data.display_name !== undefined && data.display_name !== null) {
    if (data.display_name.length > 100) {
      return { valid: false, error: 'Display name cannot exceed 100 characters' }
    }
  }

  // Validate phone_number if provided
  if (data.phone_number !== undefined && data.phone_number !== null && data.phone_number !== '') {
    if (!isValidPhone(data.phone_number)) {
      return { valid: false, error: 'Invalid phone number format' }
    }
  }

  // Validate avatar_url if provided
  if (data.avatar_url !== undefined && data.avatar_url !== null && data.avatar_url !== '') {
    if (!isValidUrl(data.avatar_url)) {
      return { valid: false, error: 'Invalid avatar URL format. Must be a valid http/https URL' }
    }
  }

  // Validate preferred_locale if provided
  if (data.preferred_locale !== undefined && data.preferred_locale !== null) {
    if (!isValidLocale(data.preferred_locale)) {
      return { valid: false, error: 'Invalid locale format. Use format like: en, en-US, zh-CN' }
    }
  }

  return { valid: true }
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    },
    allowed: isAllowed,
  }
}

// Main handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Allow GET (fetch profile) plus POST/PATCH/PUT (create/update)
    if (!['GET', 'POST', 'PUT', 'PATCH'].includes(request.method)) {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate request body size (prevent DoS)
    const contentLength = request.headers.get('Content-Length')
    const MAX_BODY_SIZE = 1024 * 10 // 10KB (profile data is small)
    if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Request body too large' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    try {
      // Rate limiting - limit by user identifier or IP
      if (env.PROFILE_RATE_LIMITER) {
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
        let rateLimitKey = clientIP

        // Try to get user ID from JWT for authenticated users
        const authHeader = request.headers.get('Authorization')
        if (authHeader?.startsWith('Bearer ')) {
          try {
            const token = authHeader.substring(7)
            const jwt = await verifyAuth0JWT(token, env)
            // Use user ID for authenticated users (more accurate rate limiting)
            if (jwt?.sub) {
              rateLimitKey = jwt.sub
            }
          } catch {
            // If token verification fails, fall back to IP
            rateLimitKey = clientIP
          }
        }

        const { success } = await env.PROFILE_RATE_LIMITER.limit({ key: rateLimitKey })

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

      // Require authentication - only authenticated users can create/update profiles
      // Guest customer info is stored directly in orders, not in profiles
      const authHeader = request.headers.get('Authorization')
      
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Authentication required. Guest users should store customer info in orders, not profiles.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Verify Auth0 JWT for authenticated users
      const token = authHeader.substring(7)
      const jwtPayload = await verifyAuth0JWT(token, env)
      
      if (!jwtPayload) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      const userId = jwtPayload.sub
      
      // Handle GET (fetch profile only)
      if (request.method === 'GET') {
        const profile = await getUserProfile(userId, env)
        if (!profile) {
          return new Response(
            JSON.stringify({ error: 'Profile not found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Parse request body for write operations
      const body: UserProfileRequest = await request.json()

      // Validate input data
      const validation = validateProfileInput(body)
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const {
        email,
        display_name,
        avatar_url,
        phone_number,
        preferred_locale,
      } = body

      // Check if profile exists (we validate JWT first, then use service_role)
      const existingProfile = await getUserProfile(userId, env)

      // Determine email - priority: request body > JWT payload > existing profile
      let profileEmail = email || jwtPayload?.email || existingProfile?.email

      // For new profiles, email is required
      if (!existingProfile && !profileEmail) {
        return new Response(
          JSON.stringify({ error: 'email is required for new profiles' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Prepare profile data
      const profileData = {
        id: userId,
        email: profileEmail!,
        display_name: display_name ?? jwtPayload?.name ?? existingProfile?.display_name,
        avatar_url: avatar_url ?? jwtPayload?.picture ?? existingProfile?.avatar_url,
        phone_number: phone_number ?? existingProfile?.phone_number,
        preferred_locale: preferred_locale ?? existingProfile?.preferred_locale ?? 'en',
      }

      let result: UserProfileResponse

      if (existingProfile) {
        // Update existing profile (we validate JWT first, then use service_role)
        result = await updateUserProfile(userId, {
          email: profileData.email,
          display_name: profileData.display_name,
          avatar_url: profileData.avatar_url,
          phone_number: profileData.phone_number,
          preferred_locale: profileData.preferred_locale,
        }, env)
      } else {
        // Create new profile for authenticated user (we validate JWT first, then use service_role)
        result = await createUserProfile(profileData, env)
      }

      return new Response(JSON.stringify(result), {
        status: existingProfile ? 200 : 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (error: any) {
      // Log full error details server-side for debugging
      console.error('User profile error:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      })

      // Return generic error message to client (don't expose internal details)
      // Only expose specific error messages for known validation errors
      const errorMessage = error.message || 'Internal server error'
      const isKnownError = errorMessage.includes('email') ||
                          errorMessage.includes('phone') ||
                          errorMessage.includes('Invalid') ||
                          errorMessage.includes('cannot exceed') ||
                          errorMessage.includes('required') ||
                          errorMessage.includes('format')

      return new Response(
        JSON.stringify({
          error: isKnownError ? errorMessage : 'An error occurred while processing your profile. Please try again.'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

