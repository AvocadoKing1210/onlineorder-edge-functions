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

interface OrderSubmissionRequest {
  cart: CartItem[]
  mode: 'dine_in' | 'takeout' | 'delivery'
  special_instructions?: string
  idempotency_key?: string
  user_id?: string // For guest checkout
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

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      audience: env.AUTH0_AUDIENCE || `https://${env.AUTH0_DOMAIN}/api/v2/`,
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
      // Parse request
      const body: OrderSubmissionRequest = await request.json()
      const { cart, mode, special_instructions, idempotency_key, user_id: bodyUserId } = body

      // Get user_id - either from JWT (authenticated) or request body (guest)
      // Auth0 is optional - only verify if token provided, otherwise use guest user_id
      const authHeader = request.headers.get('Authorization')
      let user_id: string

      if (authHeader?.startsWith('Bearer ')) {
        // Optional: Verify Auth0 JWT for authenticated users
        const token = authHeader.substring(7)
        const jwt = await verifyAuth0JWT(token, env)
        user_id = jwt?.sub || bodyUserId || `guest-${Date.now()}`
      } else if (bodyUserId) {
        // Guest checkout - use provided user_id (no Auth0 verification needed)
        user_id = bodyUserId
      } else {
        // Generate guest user_id if none provided
        user_id = `guest-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
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

