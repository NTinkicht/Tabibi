import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnPath } from '@/app/staff/sign-in/return-path';

// TAB-P0-14/01 (#726): visitors to staff pages without a session cookie are
// sent to the sign-in page. This is navigation only: every staff API still
// verifies the signed, server-revocable session itself.
export function middleware(request: NextRequest) {
  if (request.cookies.has('tabibi_staff_session')) return NextResponse.next();
  const url = request.nextUrl.clone();
  const target = safeReturnPath(`${url.pathname}${url.search}`);
  url.pathname = '/staff/sign-in';
  url.search = '';
  if (target) url.searchParams.set('returnTo', target);
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/operations/:path*'] };
