import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnPath } from '@/app/staff/sign-in/return-path';
import { LOCALE_HEADER, documentLocaleFromQuery } from '@/app/document-locale';

// TAB-P0-14/01 (#726): visitors to staff pages without a session cookie are
// sent to the sign-in page. This is navigation only: every staff API still
// verifies the signed, server-revocable session itself.
// TAB-UI-01: every page request also forwards the active locale so the root
// layout can set <html lang dir>; the header is overwritten, never trusted.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith('/operations') &&
    !request.cookies.has('tabibi_staff_session')
  ) {
    const url = request.nextUrl.clone();
    const target = safeReturnPath(`${url.pathname}${url.search}`);
    url.pathname = '/staff/sign-in';
    url.search = '';
    if (target) url.searchParams.set('returnTo', target);
    return NextResponse.redirect(url);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    LOCALE_HEADER,
    documentLocaleFromQuery(request.nextUrl.searchParams),
  );
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
