import { Request, Response, NextFunction } from 'express';
import { storage, UserRecord } from './storage.js';

export type UserRole = 'admin' | 'department_coordinator' | 'faculty' | 'club' | 'student';

export interface UserProfile {
  id: string;
  name: string;
  role: UserRole;
  department?: string;
  facultyId?: string;
  studentGroupId?: string;
  clubName?: string;
  username: string;
  email: string;
  status: 'active' | 'suspended' | 'pending';
}

export interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

function userRecordToProfile(record: UserRecord): UserProfile {
  return {
    id: record.id,
    name: record.display_name,
    role: record.role,
    department: record.department,
    facultyId: record.faculty_id,
    studentGroupId: record.student_group_id,
    clubName: record.club_name,
    username: record.username,
    email: record.email,
    status: record.status,
  };
}

export async function authenticateUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  const allowDemoAuth = !isProduction || process.env.ENABLE_DEMO_AUTH === 'true';

  // Support Authorization header (Bearer <token_or_id>)
  let token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  // In non-production or when explicit demo auth is enabled, support x-user-id header or asUser query
  if (!token && allowDemoAuth) {
    if (req.headers['x-user-id']) {
      token = String(req.headers['x-user-id']).trim();
    } else if (req.query.asUser) {
      token = String(req.query.asUser).trim();
    }
  }

  // Look up user dynamically from persistent storage
  let userRecord: UserRecord | null = null;

  if (token) {
    if (!allowDemoAuth) {
      // In strict production: only permit valid secure auth tokens (reject user ID, username, or role alias demo shortcuts)
      const candidate = await storage.getUserByToken(token);
      const isDemoAlias = candidate && (
        token === candidate.id ||
        token === candidate.username ||
        token === candidate.role ||
        ['admin', 'faculty', 'club', 'student', 'department_coordinator'].includes(token)
      );
      if (candidate && !isDemoAlias) {
        userRecord = candidate;
      }
    } else {
      userRecord = (await storage.getUserByToken(token)) || (await storage.getUserById(token)) || (await storage.getUserByUsername(token));
      if (!userRecord) {
        const allUsers = Object.values(await storage.getAllUsers());
        userRecord = allUsers.find((u) => u.role === token) || null;
      }
    }

    if (!userRecord) {
      res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: `Invalid authentication token or user identity: '${token}'` },
      });
      return;
    }
  } else {
    // No authentication credentials provided: unauthenticated request
    req.user = undefined;
    next();
    return;
  }

  if (userRecord.status === 'suspended') {
    res.status(403).json({
      success: false,
      error: { code: 'ACCOUNT_SUSPENDED', message: `Account '${userRecord.username}' is currently suspended.` },
    });
    return;
  }

  // Server-authoritative assignment: req.user is populated directly from storage
  req.user = userRecordToProfile(userRecord);
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return;
  }
  next();
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Role '${req.user.role}' is not authorized to perform this operation. Required: ${allowedRoles.join(', ')}`,
        },
      });
      return;
    }

    next();
  };
}

export function assertNotSelfApproval(req: AuthenticatedRequest, creatorId?: string): void {
  if (creatorId && req.user && req.user.id === creatorId) {
    const error = new Error('Self-approval violation: Users cannot approve or reject their own submissions.');
    (error as any).status = 403;
    (error as any).code = 'SELF_APPROVAL_FORBIDDEN';
    throw error;
  }
}
