import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const emptyReviewStats = {
  averageRating: 0,
  totalReviews: 0,
  reviewCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
}
const localReviewsPath = path.join(process.cwd(), 'data', 'reviews.json')

interface ReviewRecord {
  id: number
  customer_name: string
  customer_email?: string
  product_name?: string
  rating: number
  review_text: string
  verified_purchase: boolean
  is_approved?: boolean
  created_at: string
}

function isMissingTableError(error: { code?: string; message?: string }, tableName: string) {
  return (
    error.code === 'PGRST205' ||
    error.message?.includes(`relation "${tableName}" does not exist`) ||
    error.message?.includes(`table 'public.${tableName}'`)
  )
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  // The service key is preferred for server-side reads, but the publishable
  // key keeps the read-only reviews endpoint functional in preview deployments
  // where only public Supabase credentials are available.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error('Supabase credentials are not configured')
  }

  return createClient(url, key)
}

function escapeHtml(text: string): string {
  const htmlEscapeMap: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (char) => htmlEscapeMap[char])
}

async function readLocalReviews(): Promise<ReviewRecord[]> {
  try {
    const file = await fs.readFile(localReviewsPath, 'utf8')
    const reviews = JSON.parse(file)
    return Array.isArray(reviews) ? reviews : []
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[v0] Failed to read local reviews fallback:', error)
    }
    return []
  }
}

async function saveLocalReview(review: Omit<ReviewRecord, 'id' | 'created_at'>): Promise<ReviewRecord> {
  const reviews = await readLocalReviews()
  const savedReview: ReviewRecord = {
    ...review,
    id: Date.now(),
    created_at: new Date().toISOString(),
    is_approved: true,
  }

  await fs.mkdir(path.dirname(localReviewsPath), { recursive: true })
  await fs.writeFile(localReviewsPath, JSON.stringify([savedReview, ...reviews], null, 2))
  return savedReview
}

function buildReviewsPayload(reviews: ReviewRecord[]) {
  const approvedReviews = reviews
    .filter((review) => review.is_approved !== false)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  const reviewCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let totalRating = 0

  approvedReviews.forEach((review) => {
    reviewCounts[review.rating as keyof typeof reviewCounts]++
    totalRating += review.rating
  })

  const totalReviews = approvedReviews.length
  const averageRating = totalReviews > 0 ? totalRating / totalReviews : 0

  return {
    reviews: approvedReviews,
    stats: {
      averageRating: Number(averageRating.toFixed(1)),
      totalReviews,
      reviewCounts,
    },
  }
}

// GET: Fetch approved reviews with statistics
export async function GET(request: NextRequest) {
  try {
    console.log('[v0] GET /api/reviews request received')
    
    let supabase
    try {
      supabase = getSupabaseClient()
      console.log('[v0] Supabase client initialized for GET request')
    } catch (clientError) {
      console.warn('[v0] Supabase is not configured; using local reviews fallback.', clientError)
      return NextResponse.json(buildReviewsPayload(await readLocalReviews()))
    }

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100', 10)

    console.log('[v0] Fetching approved reviews with limit:', limit)

    // Fetch approved reviews sorted by newest first
    const { data: reviews, error: reviewsError } = await supabase
      .from('reviews')
      .select('id, customer_name, rating, review_text, created_at, verified_purchase')
      .eq('is_approved', true)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (reviewsError) {
      const fullError = {
        message: reviewsError.message,
        code: reviewsError.code,
        details: reviewsError.details,
        hint: reviewsError.hint,
      }
      console.warn('[v0] Supabase error fetching reviews:', JSON.stringify(fullError, null, 2))
      
      let errorMessage = 'Failed to fetch reviews'
      let errorCode = 'FETCH_FAILED'
      let statusCode = 500

      if (isMissingTableError(reviewsError, 'reviews')) {
        console.warn('[v0] Reviews table not found; using local reviews fallback.')
        return NextResponse.json(buildReviewsPayload(await readLocalReviews()))
      } else if (reviewsError.message?.includes('permission denied')) {
        errorMessage = 'Permission denied. Check Row Level Security (RLS) policies.'
        errorCode = 'PERMISSION_DENIED'
        statusCode = 403
        console.warn('[v0] Permission denied accessing reviews table')
      } else if (reviewsError.message?.includes('invalid')) {
        errorMessage = 'Invalid query or schema issue'
        errorCode = 'INVALID_QUERY'
        statusCode = 400
      } else if (reviewsError.message?.includes('connection') || reviewsError.message?.includes('ENOTFOUND') || reviewsError.message?.includes('timeout')) {
        errorMessage = 'Database connection failed. Please try again later.'
        errorCode = 'CONNECTION_FAILED'
        statusCode = 503
      }

      return NextResponse.json(
        { 
          error: errorMessage,
          code: errorCode,
          details: process.env.NODE_ENV === 'development' ? fullError : undefined
        },
        { status: statusCode }
      )
    }

    console.log('[v0] Reviews fetched successfully:', reviews?.length || 0, 'reviews')

    return NextResponse.json(buildReviewsPayload(reviews || []))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An error occurred'
    console.error('[v0] Unexpected error in GET /api/reviews:', error)
      // Reviews are optional content. Keep the page usable when Supabase is
      // unavailable, misconfigured, or has not been initialized yet.
      console.warn('[v0] Falling back to local reviews after Supabase read failure')
      return NextResponse.json(buildReviewsPayload(await readLocalReviews()))
  }
}

// POST: Submit a new review
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    console.log('[v0] Review POST request received with body:', body)
    
    const { customer_name, customer_email, product_name, rating, review_text } = body

    // Validation with detailed error messages
    if (!customer_name || !customer_name.trim()) {
      console.warn('[v0] Review validation failed: missing customer_name')
      return NextResponse.json(
        { error: 'Customer name is required', code: 'MISSING_NAME' },
        { status: 400 }
      )
    }

    if (customer_name.trim().length < 2) {
      console.warn('[v0] Review validation failed: name too short')
      return NextResponse.json(
        { error: 'Name must be at least 2 characters', code: 'INVALID_NAME_LENGTH' },
        { status: 400 }
      )
    }

    if (!customer_email || !EMAIL_REGEX.test(customer_email)) {
      console.warn('[v0] Review validation failed: invalid email')
      return NextResponse.json(
        { error: 'Valid email is required', code: 'INVALID_EMAIL' },
        { status: 400 }
      )
    }

    if (!product_name || !product_name.trim()) {
      console.warn('[v0] Review validation failed: missing product_name')
      return NextResponse.json(
        { error: 'Product name is required', code: 'MISSING_PRODUCT' },
        { status: 400 }
      )
    }

    if (!rating || rating < 1 || rating > 5) {
      console.warn('[v0] Review validation failed: invalid rating', rating)
      return NextResponse.json(
        { error: 'Rating must be between 1 and 5', code: 'INVALID_RATING' },
        { status: 400 }
      )
    }

    if (!review_text || !review_text.trim()) {
      console.warn('[v0] Review validation failed: missing review_text')
      return NextResponse.json(
        { error: 'Review text is required', code: 'MISSING_REVIEW' },
        { status: 400 }
      )
    }

    const reviewLength = review_text.trim().length
    if (reviewLength < 20 || reviewLength > 1000) {
      console.warn('[v0] Review validation failed: review length invalid', reviewLength)
      return NextResponse.json(
        { 
          error: `Review must be between 20 and 1000 characters (current: ${reviewLength})`, 
          code: 'INVALID_REVIEW_LENGTH',
          currentLength: reviewLength
        },
        { status: 400 }
      )
    }

    let supabase
    try {
      supabase = getSupabaseClient()
      console.log('[v0] Supabase client initialized successfully')
    } catch (clientError) {
      console.warn('[v0] Supabase is not configured; saving review locally.', clientError)
      const review = await saveLocalReview({
        customer_name: escapeHtml(customer_name.trim()),
        customer_email: customer_email.toLowerCase().trim(),
        product_name: escapeHtml(product_name.trim()),
        rating,
        review_text: escapeHtml(review_text.trim()),
        verified_purchase: false,
      })
      return NextResponse.json(
        {
          message: 'Review submitted successfully. It is now visible on the site.',
          review,
        },
        { status: 201 }
      )
    }

    // Insert review as approved so it appears on the site immediately.
    console.log('[v0] Attempting to insert review into database')
    const { data, error } = await supabase
      .from('reviews')
      .insert([
        {
          customer_name: escapeHtml(customer_name.trim()),
          customer_email: customer_email.toLowerCase().trim(),
          product_name: escapeHtml(product_name.trim()),
          rating,
          review_text: escapeHtml(review_text.trim()),
          is_approved: true,
          verified_purchase: false,
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (error) {
      const fullError = {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      }
      console.error('[v0] Supabase error inserting review:', JSON.stringify(fullError, null, 2))
      
      // Provide more specific error messages based on error type
      let errorMessage = 'Failed to submit review'
      let errorCode = 'DB_INSERT_FAILED'
      let statusCode = 500

      if (isMissingTableError(error, 'reviews')) {
        console.warn('[v0] Reviews table not found; saving review locally.')
        const review = await saveLocalReview({
          customer_name: escapeHtml(customer_name.trim()),
          customer_email: customer_email.toLowerCase().trim(),
          product_name: escapeHtml(product_name.trim()),
          rating,
          review_text: escapeHtml(review_text.trim()),
          verified_purchase: false,
        })
        return NextResponse.json(
          {
            message: 'Review submitted successfully. It is now visible on the site.',
            review,
          },
          { status: 201 }
        )
      } else if (error.message?.includes('permission denied')) {
        errorMessage = 'Permission denied. Check Row Level Security (RLS) policies.'
        errorCode = 'PERMISSION_DENIED'
        statusCode = 403
      } else if (error.message?.includes('duplicate')) {
        errorMessage = 'Duplicate review. You may have already submitted a review for this product.'
        errorCode = 'DUPLICATE_REVIEW'
        statusCode = 409
      } else if (error.message?.includes('connection') || error.message?.includes('ENOTFOUND') || error.message?.includes('timeout')) {
        errorMessage = 'Database connection failed. Please try again later.'
        errorCode = 'CONNECTION_FAILED'
        statusCode = 503
      }

      return NextResponse.json(
        { 
          error: errorMessage,
          code: errorCode,
          details: process.env.NODE_ENV === 'development' ? fullError : undefined
        },
        { status: statusCode }
      )
    }

    console.log('[v0] Review inserted successfully:', data?.[0])
    return NextResponse.json(
      {
        message: 'Review submitted successfully. It is now visible on the site.',
        review: data?.[0],
      },
      { status: 201 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An error occurred'
    console.error('[v0] Unexpected error in review submission:', error)
    return NextResponse.json(
      { 
        error: errorMessage || 'An unexpected error occurred', 
        code: 'INTERNAL_SERVER_ERROR'
      },
      { status: 500 }
    )
  }
}
