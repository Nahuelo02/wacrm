// ============================================================
// GET /api/v1/media/:mediaId — server-to-server media download.
//
// Public-API counterpart of /api/whatsapp/media/[mediaId], which is
// the dashboard-side proxy (cookie session → user → account). This
// route is for callers like glowylamps' agent, which has no Supabase
// session and submits an `Authorization: Bearer wacrm_live_…` header
// instead.
//
// Why a separate route:
//   - The dashboard route reads the caller's `profile.account_id` and
//     decrypts `whatsapp_config.access_token` tied to that profile.
//     That requires a Supabase user session, which a server caller
//     like glowylamps does not have.
//   - This route authenticates with an API key carrying the `media:read`
//     scope, which the dashboard route does NOT check. Keeping the two
//     routes separate means callers that bypass cookies can't
//     accidentally be invoked as a logged-in user, and vice versa.
//   - The two endpoints audit-log differently (UI vs S2S), so future
//     security reviews can tell traffic flows apart.
//
// Required scope: media:read.
// Returns: the raw media bytes with `Content-Type` and `Cache-Control`,
//          same envelope as the dashboard route.
// Errors: JSON envelope via toApiErrorResponse (mapped from ApiError).
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse } from '@/lib/api/v1/respond';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    // 1) Bearer + scope check — authType='api_key', ctx.accountId fixed.
    const ctx = await requireApiKey(request, 'media:read');

    const { mediaId } = await params;
    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      );
    }

    // 2) Resolve the WhatsApp token for this account. ONE row per
    //    account (post-multi-user), so we don't disambiguate by user.
    //    ctx.supabase is the service-role client — RLS is bypassed, which
    //    is correct: the API key's scope lookup already nailed the
    //    account; we own that account and only that account.
    const { data: config, error: configError } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', ctx.accountId)
      .single();

    if (configError || !config?.access_token) {
      return NextResponse.json(
        { error: 'WhatsApp not configured for this account' },
        { status: 400 }
      );
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch (decryptErr) {
      console.error('[v1.media] access_token decrypt failed:', decryptErr);
      return NextResponse.json(
        { error: 'Failed to decrypt WhatsApp credentials' },
        { status: 500 }
      );
    }

    // 3) Resolve Meta's CDN URL and pull the bytes. Same helpers the
    //    inbound mirror uses (issues #466), so behavior is identical
    //    to what the dashboard route serves.
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        // Same TTL the dashboard route uses — Meta gives us a CDN URL
        // with its own ~5 min lifetime, so the proxy can be cached a
        // bit longer than that to absorb concurrent agent downloads.
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
