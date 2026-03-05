/**
 * Authentication Service
 * Handles user authentication, token management, and session validation
 */

import { createHash, randomBytes } from 'crypto';

interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  isActive: boolean;
  role: 'admin' | 'user' | 'moderator';
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

interface AuthToken {
  token: string;
  userId: string;
  expiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  deviceInfo?: string;
}

interface LoginResult {
  success: boolean;
  user?: Omit<User, 'passwordHash' | 'salt'>;
  token?: AuthToken;
  error?: string;
}

interface RegisterInput {
  email: string;
  name: string;
  password: string;
  role?: 'user' | 'moderator';
}

// In-memory storage for demo purposes
const users: Map<string, User> = new Map();
const tokens: Map<string, AuthToken> = new Map();
const refreshTokens: Map<string, AuthToken> = new Map();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 8;

/**
 * Hashes a password with the given salt using SHA-256
 */
function hashPassword(password: string, salt: string): string {
  return createHash('sha256')
    .update(password + salt)
    .digest('hex');
}

/**
 * Generates a secure random token
 */
function generateToken(): string {
  return randomBytes(48).toString('hex');
}

/**
 * Validates password strength requirements
 */
function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates email format
 */
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Strips sensitive fields from user object
 */
function sanitizeUser(user: User): Omit<User, 'passwordHash' | 'salt'> {
  const { passwordHash, salt, ...safeUser } = user;
  return safeUser;
}

/**
 * Registers a new user account
 */
export async function registerUser(input: RegisterInput): Promise<LoginResult> {
  const { email, name, password, role = 'user' } = input;

  // Validate email
  if (!validateEmail(email)) {
    return { success: false, error: 'Invalid email format' };
  }

  // Check for duplicate email
  for (const user of users.values()) {
    if (user.email.toLowerCase() === email.toLowerCase()) {
      return { success: false, error: 'Email already registered' };
    }
  }

  // Validate password strength
  const passwordValidation = validatePasswordStrength(password);
  if (!passwordValidation.valid) {
    return { success: false, error: passwordValidation.errors.join('; ') };
  }

  // Create user
  const salt = randomBytes(16).toString('hex');
  const id = randomBytes(16).toString('hex');
  const user: User = {
    id,
    email: email.toLowerCase(),
    name,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: new Date(),
    lastLoginAt: null,
    isActive: true,
    role,
    failedLoginAttempts: 0,
    lockedUntil: null,
  };

  users.set(id, user);

  // Auto-login after registration
  const token = createAuthToken(id);

  return {
    success: true,
    user: sanitizeUser(user),
    token,
  };
}

/**
 * Creates authentication tokens for a user
 */
function createAuthToken(userId: string, deviceInfo?: string): AuthToken {
  const now = new Date();
  const authToken: AuthToken = {
    token: generateToken(),
    userId,
    expiresAt: new Date(now.getTime() + TOKEN_EXPIRY_MS),
    refreshToken: generateToken(),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_EXPIRY_MS),
    deviceInfo,
  };

  tokens.set(authToken.token, authToken);
  refreshTokens.set(authToken.refreshToken, authToken);

  return authToken;
}

/**
 * Authenticates a user with email and password
 */
export async function loginUser(
  email: string,
  password: string,
  deviceInfo?: string
): Promise<LoginResult> {
  // Find user by email
  let targetUser: User | undefined;
  for (const user of users.values()) {
    if (user.email === email.toLowerCase()) {
      targetUser = user;
      break;
    }
  }

  if (!targetUser) {
    return { success: false, error: 'Invalid email or password' };
  }

  // Check if account is locked
  if (targetUser.lockedUntil && targetUser.lockedUntil > new Date()) {
    const remainingMs = targetUser.lockedUntil.getTime() - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    return {
      success: false,
      error: `Account locked. Try again in ${remainingMin} minute(s)`,
    };
  }

  // Check if account is active
  if (!targetUser.isActive) {
    return { success: false, error: 'Account is deactivated' };
  }

  // Verify password
  const hash = hashPassword(password, targetUser.salt);
  if (hash !== targetUser.passwordHash) {
    // Increment failed attempts
    targetUser.failedLoginAttempts += 1;

    if (targetUser.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      targetUser.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      targetUser.failedLoginAttempts = 0;
      return {
        success: false,
        error: 'Too many failed attempts. Account locked for 15 minutes',
      };
    }

    return { success: false, error: 'Invalid email or password' };
  }

  // Reset failed attempts on successful login
  targetUser.failedLoginAttempts = 0;
  targetUser.lockedUntil = null;
  targetUser.lastLoginAt = new Date();

  // Create token
  const token = createAuthToken(targetUser.id, deviceInfo);

  return {
    success: true,
    user: sanitizeUser(targetUser),
    token,
  };
}

/**
 * Validates an access token and returns the associated user
 */
export async function validateToken(
  tokenStr: string
): Promise<{ valid: boolean; user?: Omit<User, 'passwordHash' | 'salt'>; error?: string }> {
  const authToken = tokens.get(tokenStr);

  if (!authToken) {
    return { valid: false, error: 'Token not found' };
  }

  if (authToken.expiresAt < new Date()) {
    tokens.delete(tokenStr);
    return { valid: false, error: 'Token expired' };
  }

  const user = users.get(authToken.userId);
  if (!user || !user.isActive) {
    return { valid: false, error: 'User not found or inactive' };
  }

  return { valid: true, user: sanitizeUser(user) };
}

/**
 * Refreshes an expired access token using a refresh token
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ success: boolean; token?: AuthToken; error?: string }> {
  const existingToken = refreshTokens.get(refreshToken);

  if (!existingToken) {
    return { success: false, error: 'Invalid refresh token' };
  }

  if (existingToken.refreshExpiresAt < new Date()) {
    refreshTokens.delete(refreshToken);
    tokens.delete(existingToken.token);
    return { success: false, error: 'Refresh token expired' };
  }

  // Revoke old tokens
  tokens.delete(existingToken.token);
  refreshTokens.delete(refreshToken);

  // Create new token pair
  const user = users.get(existingToken.userId);
  if (!user || !user.isActive) {
    return { success: false, error: 'User not found or inactive' };
  }

  const newToken = createAuthToken(user.id, existingToken.deviceInfo);
  return { success: true, token: newToken };
}

/**
 * Logs out a user by revoking their tokens
 */
export async function logoutUser(tokenStr: string): Promise<void> {
  const authToken = tokens.get(tokenStr);
  if (authToken) {
    tokens.delete(tokenStr);
    refreshTokens.delete(authToken.refreshToken);
  }
}

/**
 * Changes a user's password
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const user = users.get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  // Verify current password
  const currentHash = hashPassword(currentPassword, user.salt);
  if (currentHash !== user.passwordHash) {
    return { success: false, error: 'Current password is incorrect' };
  }

  // Validate new password
  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join('; ') };
  }

  // Update password
  const newSalt = randomBytes(16).toString('hex');
  user.salt = newSalt;
  user.passwordHash = hashPassword(newPassword, newSalt);

  // Revoke all existing tokens for this user
  for (const [key, token] of tokens.entries()) {
    if (token.userId === userId) {
      tokens.delete(key);
      refreshTokens.delete(token.refreshToken);
    }
  }

  return { success: true };
}

/**
 * Lists all users (admin only)
 */
export async function listUsers(): Promise<Omit<User, 'passwordHash' | 'salt'>[]> {
  return Array.from(users.values()).map(sanitizeUser);
}

/**
 * Deactivates a user account (admin only)
 */
export async function deactivateUser(
  adminId: string,
  targetUserId: string
): Promise<{ success: boolean; error?: string }> {
  const admin = users.get(adminId);
  if (!admin || admin.role !== 'admin') {
    return { success: false, error: 'Unauthorized' };
  }

  const target = users.get(targetUserId);
  if (!target) {
    return { success: false, error: 'User not found' };
  }

  target.isActive = false;

  // Revoke all tokens
  for (const [key, token] of tokens.entries()) {
    if (token.userId === targetUserId) {
      tokens.delete(key);
      refreshTokens.delete(token.refreshToken);
    }
  }

  return { success: true };
}
