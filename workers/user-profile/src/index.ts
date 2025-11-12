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

// Main handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, PUT, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // Allow GET (fetch profile) plus POST/PATCH/PUT (create/update)
    if (!['GET', 'POST', 'PUT', 'PATCH'].includes(request.method)) {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    try {
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
      console.error('User profile error:', error)
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

