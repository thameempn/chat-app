/**
 * Authentication Middleware
 * Express-style middleware for protecting routes with token-based auth
 */

import { validateToken } from './auth-service';

interface Request {
  headers: Record<string, string | undefined>;
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

interface Response {
  status: (code: number) => Response;
  json: (body: unknown) => void;
}

type NextFunction = () => void;

/**
 * Extracts the bearer token from the Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Middleware that requires a valid authentication token
 * Attaches the authenticated user to the request object
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers['authorization']);

    if (!token) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const result = await validateToken(token);

    if (!result.valid || !result.user) {
      res.status(401).json({
        error: result.error || 'Invalid token',
        code: 'INVALID_TOKEN',
      });
      return;
    }

    req.user = {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
    };

    next();
  };
}

/**
 * Middleware that requires a specific role
 * Must be used after requireAuth()
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        requiredRoles: roles,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware that optionally authenticates (doesn't fail if no token)
 * Useful for routes that behave differently for authenticated vs anonymous users
 */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers['authorization']);

    if (token) {
      const result = await validateToken(token);
      if (result.valid && result.user) {
        req.user = {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          role: result.user.role,
        };
      }
    }

    next();
  };
}

/**
 * Rate limiting middleware for auth endpoints
 * Prevents brute force attacks by tracking requests per IP
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;

export function rateLimitAuth() {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    const now = Date.now();

    let entry = rateLimitMap.get(ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }

    entry.count += 1;

    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({
        error: 'Too many requests. Please try again later.',
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}
