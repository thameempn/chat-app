/**
 * Authentication Route Handlers
 * REST API endpoints for user authentication and account management
 */

import {
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  changePassword,
  listUsers,
  deactivateUser,
} from './auth-service';
import { requireAuth, requireRole, rateLimitAuth } from './auth-middleware';

interface RouteHandler {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  middleware?: Function[];
  handler: (req: any, res: any) => Promise<void>;
}

/**
 * POST /auth/register
 * Creates a new user account and returns authentication tokens
 */
async function handleRegister(req: any, res: any): Promise<void> {
  const { email, name, password, role } = req.body;

  if (!email || !name || !password) {
    res.status(400).json({
      error: 'Email, name, and password are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const result = await registerUser({ email, name, password, role });

  if (!result.success) {
    res.status(400).json({
      error: result.error,
      code: 'REGISTRATION_FAILED',
    });
    return;
  }

  res.status(201).json({
    message: 'Registration successful',
    user: result.user,
    token: result.token?.token,
    refreshToken: result.token?.refreshToken,
    expiresAt: result.token?.expiresAt,
  });
}

/**
 * POST /auth/login
 * Authenticates a user and returns tokens
 */
async function handleLogin(req: any, res: any): Promise<void> {
  const { email, password } = req.body;
  const deviceInfo = req.headers['user-agent'];

  if (!email || !password) {
    res.status(400).json({
      error: 'Email and password are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const result = await loginUser(email, password, deviceInfo);

  if (!result.success) {
    res.status(401).json({
      error: result.error,
      code: 'LOGIN_FAILED',
    });
    return;
  }

  res.status(200).json({
    message: 'Login successful',
    user: result.user,
    token: result.token?.token,
    refreshToken: result.token?.refreshToken,
    expiresAt: result.token?.expiresAt,
  });
}

/**
 * POST /auth/logout
 * Revokes the current authentication token
 */
async function handleLogout(req: any, res: any): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    await logoutUser(token);
  }

  res.status(200).json({ message: 'Logged out successfully' });
}

/**
 * POST /auth/refresh
 * Refreshes an expired access token using a refresh token
 */
async function handleRefresh(req: any, res: any): Promise<void> {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({
      error: 'Refresh token is required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const result = await refreshAccessToken(refreshToken);

  if (!result.success) {
    res.status(401).json({
      error: result.error,
      code: 'REFRESH_FAILED',
    });
    return;
  }

  res.status(200).json({
    token: result.token?.token,
    refreshToken: result.token?.refreshToken,
    expiresAt: result.token?.expiresAt,
  });
}

/**
 * PUT /auth/password
 * Changes the authenticated user's password
 */
async function handleChangePassword(req: any, res: any): Promise<void> {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!currentPassword || !newPassword) {
    res.status(400).json({
      error: 'Current password and new password are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const result = await changePassword(userId, currentPassword, newPassword);

  if (!result.success) {
    res.status(400).json({
      error: result.error,
      code: 'PASSWORD_CHANGE_FAILED',
    });
    return;
  }

  res.status(200).json({ message: 'Password changed successfully' });
}

/**
 * GET /auth/me
 * Returns the currently authenticated user's profile
 */
async function handleGetProfile(req: any, res: any): Promise<void> {
  res.status(200).json({ user: req.user });
}

/**
 * GET /admin/users
 * Lists all users (admin only)
 */
async function handleListUsers(_req: any, res: any): Promise<void> {
  const userList = await listUsers();
  res.status(200).json({ users: userList });
}

/**
 * POST /admin/users/:id/deactivate
 * Deactivates a user account (admin only)
 */
async function handleDeactivateUser(req: any, res: any): Promise<void> {
  const adminId = req.user?.id;
  const targetUserId = req.params?.id;

  if (!adminId || !targetUserId) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const result = await deactivateUser(adminId, targetUserId);

  if (!result.success) {
    res.status(400).json({
      error: result.error,
      code: 'DEACTIVATION_FAILED',
    });
    return;
  }

  res.status(200).json({ message: 'User deactivated successfully' });
}

/**
 * Returns all auth route definitions for registration with a router
 */
export function getAuthRoutes(): RouteHandler[] {
  return [
    {
      method: 'POST',
      path: '/auth/register',
      middleware: [rateLimitAuth()],
      handler: handleRegister,
    },
    {
      method: 'POST',
      path: '/auth/login',
      middleware: [rateLimitAuth()],
      handler: handleLogin,
    },
    {
      method: 'POST',
      path: '/auth/logout',
      middleware: [requireAuth()],
      handler: handleLogout,
    },
    {
      method: 'POST',
      path: '/auth/refresh',
      middleware: [rateLimitAuth()],
      handler: handleRefresh,
    },
    {
      method: 'PUT',
      path: '/auth/password',
      middleware: [requireAuth()],
      handler: handleChangePassword,
    },
    {
      method: 'GET',
      path: '/auth/me',
      middleware: [requireAuth()],
      handler: handleGetProfile,
    },
    {
      method: 'GET',
      path: '/admin/users',
      middleware: [requireAuth(), requireRole('admin')],
      handler: handleListUsers,
    },
    {
      method: 'POST',
      path: '/admin/users/:id/deactivate',
      middleware: [requireAuth(), requireRole('admin')],
      handler: handleDeactivateUser,
    },
  ];
}
