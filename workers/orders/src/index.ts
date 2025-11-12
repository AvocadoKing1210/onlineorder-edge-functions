/**
 * Cloudflare Worker: Order Submission
 * 
 * Handles order submission with validation, reference number generation,
 * and database updates via Supabase REST API.
 * 
 * Supports both authenticated users and guest checkout.
 */

import { jwtVerify, createRemoteJWKSet } from 'jose'

// Types
interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  AUTH0_DOMAIN: string
  AUTH0_AUDIENCE?: string
  AUTH0_CLIENT_ID?: string // Client ID for ID token audience validation
  ORDER_RATE_LIMITER?: any // Rate limiter binding
  ALLOWED_ORIGINS?: string // Comma-separated list of allowed origins (e.g., "https://example.com,https://app.example.com")
}

interface CartItem {
  menu_item_id: string
  quantity: number
  modifiers?: Array<{
    modifier_option_id: string
    quantity?: number
  }>
  notes?: string
}

interface DeliveryAddress {
  street: string
  city: string
  province: string
  postal_code: string
  country?: string
  unit?: string
  instructions?: string
}

interface OrderSubmissionRequest {
  cart: CartItem[]
  mode: 'dine_in' | 'takeout' | 'delivery'
  special_instructions?: string
  idempotency_key?: string
  user_id?: string // For guest checkout
  // Customer information
  customer_name?: string
  customer_email?: string
  customer_phone?: string
  delivery_address?: DeliveryAddress
}

interface OrderResponse {
  order_id: string
  reference_number: string
  status: string
  total_amount: string
}

// Auth0 JWT Verification
async function verifyAuth0JWT(
  token: string,
  env: Env
): Promise<{ sub: string; user_group?: string[] } | null> {
  try {
    const JWKS = createRemoteJWKSet(
      new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`)
    )

    // For ID tokens, the audience is typically the Client ID
    // For access tokens, the audience is the API identifier
    // We'll accept either one for flexibility
    const audiences: string[] = []
    if (env.AUTH0_CLIENT_ID) {
      audiences.push(env.AUTH0_CLIENT_ID)
    }
    if (env.AUTH0_AUDIENCE) {
      audiences.push(env.AUTH0_AUDIENCE)
    }
    // Fallback to default API audience if neither is set
    if (audiences.length === 0) {
      audiences.push(`https://${env.AUTH0_DOMAIN}/api/v2/`)
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      // Accept any of the valid audiences
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

// Generate reference number
function generateReferenceNumber(): string {
  // Format: YYYYMMDD-HHMMSS-XXXX
  // Example: 20241110-143022-A1B2
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  
  return `${date}-${time}-${random}`
}

// Validate cart items
async function validateCart(
  cart: CartItem[],
  user: { sub: string },
  env: Env
): Promise<{ valid: boolean; error?: string; items?: any[] }> {
  if (!cart || cart.length === 0) {
    return { valid: false, error: 'Cart is empty' }
  }

  // Fetch menu items from Supabase
  const menuItemIds = cart.map(item => item.menu_item_id)
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/menu_item?id=in.(${menuItemIds.join(',')})&visible=eq.true`,
    {
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  )

  if (!response.ok) {
    return { valid: false, error: 'Failed to validate menu items' }
  }

  const menuItems = (await response.json()) as any[]

  // Check all items exist and are visible
  if (menuItems.length !== menuItemIds.length) {
    return { valid: false, error: 'Some menu items are invalid or not available' }
  }

  return { valid: true, items: menuItems }
}

// Calculate order totals
function calculateTotals(
  menuItems: any[],
  cart: CartItem[]
): {
  subtotal: number
  tax_amount: number
  fees_amount: number
  tip_amount: number
  total_amount: number
} {
  let subtotal = 0

  for (const cartItem of cart) {
    const menuItem = menuItems.find(item => item.id === cartItem.menu_item_id)
    if (!menuItem) continue

    const itemTotal = parseFloat(menuItem.price) * cartItem.quantity
    subtotal += itemTotal

    // Add modifier costs if any
    if (cartItem.modifiers) {
      // TODO: Fetch modifier prices and add to subtotal
      // For now, assuming modifiers are included in base price
    }
  }

  // Simple tax calculation (10% for example)
  const tax_amount = subtotal * 0.1
  const fees_amount = 0
  const tip_amount = 0
  const total_amount = subtotal + tax_amount + fees_amount + tip_amount

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_amount: Math.round(tax_amount * 100) / 100,
    fees_amount,
    tip_amount,
    total_amount: Math.round(total_amount * 100) / 100,
  }
}

// Create order in Supabase
async function createOrder(
  orderData: {
    user_id: string
    reference_number: string
    mode: string
    subtotal: number
    tax_amount: number
    fees_amount: number
    tip_amount: number
    total_amount: number
    special_instructions?: string
    idempotency_key?: string
    customer_name?: string
    customer_email?: string
    customer_phone?: string
    delivery_address?: DeliveryAddress
  },
  user: { sub: string },
  env: Env
): Promise<any> {
  // Use anon key - RLS will handle access control
  const authHeader = `Bearer ${env.SUPABASE_ANON_KEY}`

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'apikey': env.SUPABASE_ANON_KEY,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      ...orderData,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create order: ${response.status} ${error}`)
  }

  const orders = await response.json()
  return Array.isArray(orders) ? orders[0] : orders
}

// Create order items
async function createOrderItems(
  orderId: string,
  cart: CartItem[],
  menuItems: any[],
  user: { sub: string },
  env: Env
): Promise<void> {
  const orderItems = cart.map(cartItem => {
    const menuItem = menuItems.find(item => item.id === cartItem.menu_item_id)
    return {
      order_id: orderId,
      menu_item_id: cartItem.menu_item_id,
      item_name: menuItem?.name || '',
      item_description: menuItem?.description || null,
      unit_price: menuItem?.price || '0',
      quantity: cartItem.quantity,
      line_total: (parseFloat(menuItem?.price || '0') * cartItem.quantity).toFixed(2),
      notes: cartItem.notes || null,
    }
  })

  // Use anon key - RLS will handle access control
  const authHeader = `Bearer ${env.SUPABASE_ANON_KEY}`

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/order_item`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'apikey': env.SUPABASE_ANON_KEY,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(orderItems),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create order items: ${response.status} ${error}`)
  }
}

// Get CORS headers based on request origin and allowed origins
// Returns { headers: Record<string, string>, allowed: boolean }
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    },
    allowed: isAllowed,
  }
}

// Main handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
    if (!cors.allowed) {
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

    try {
      // Rate limiting - limit by IP address or user identifier
      if (env.ORDER_RATE_LIMITER) {
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
        const authHeader = request.headers.get('Authorization')
        
        // Use IP for guests, or attempt to extract user ID from token for authenticated users
        let rateLimitKey = clientIP
        
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
        
        const { success } = await env.ORDER_RATE_LIMITER.limit({ key: rateLimitKey })
        
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

      // Parse request
      const body: OrderSubmissionRequest = await request.json()
      const { 
        cart, 
        mode, 
        special_instructions, 
        idempotency_key, 
        // Note: user_id is intentionally ignored for security - generated server-side
        customer_name,
        customer_email,
        customer_phone,
        delivery_address,
      } = body

      // Get user_id - SECURITY: Never trust client-provided user_id
      // For authenticated users: Always use JWT sub claim
      // For guest users: Generate secure server-side ID
      const authHeader = request.headers.get('Authorization')
      let user_id: string

      if (authHeader?.startsWith('Bearer ')) {
        // Authenticated user - verify JWT and use sub claim
        const token = authHeader.substring(7)
        const jwt = await verifyAuth0JWT(token, env)
        
        if (!jwt) {
          return new Response(
            JSON.stringify({ error: 'Invalid or expired token' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        
        // SECURITY: Always use JWT sub, ignore any client-provided user_id
        user_id = jwt.sub
      } else {
        // Guest checkout - generate secure server-side ID
        // Never trust client-provided user_id for security
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown'
        const timestamp = Date.now()
        const randomBytes = crypto.getRandomValues(new Uint8Array(8))
        const randomHex = Array.from(randomBytes)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
        
        // Create a secure guest ID using IP hash + timestamp + random
        // This prevents user_id manipulation while allowing guest checkout
        const ipHashBuffer = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(clientIP)
        )
        const ipHash = Array.from(new Uint8Array(ipHashBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
          .substring(0, 16)
        
        user_id = `guest-${ipHash}-${timestamp}-${randomHex.substring(0, 16)}`
      }

      // Validate cart
      const validation = await validateCart(cart, { sub: user_id }, env)
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Generate reference number
      const referenceNumber = generateReferenceNumber()

      // Calculate totals
      const totals = calculateTotals(validation.items!, cart)

      // Create order
      const order = await createOrder(
        {
          user_id: user_id,
          reference_number: referenceNumber,
          mode,
          ...totals,
          special_instructions,
          idempotency_key,
          customer_name,
          customer_email,
          customer_phone,
          delivery_address: delivery_address || undefined,
        },
        { sub: user_id },
        env
      )

      // Create order items
      await createOrderItems(order.id, cart, validation.items!, { sub: user_id }, env)

      // Return response
      const response: OrderResponse = {
        order_id: order.id,
        reference_number: referenceNumber,
        status: order.status,
        total_amount: totals.total_amount.toFixed(2),
      }

      return new Response(JSON.stringify(response), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (error: any) {
      console.error('Order submission error:', error)
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  },
}

