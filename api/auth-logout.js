import {
  isSecureRequest,
  serializeCookie,
  SESSION_COOKIE_NAME
} from '../lib/server/github-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'Lax',
    path: '/',
    maxAge: 0
  }));
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    success: true,
    authenticated: false
  });
}
