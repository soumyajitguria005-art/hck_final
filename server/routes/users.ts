import { Router, Response } from 'express';
import crypto from 'crypto';
import { AuthenticatedRequest, requireAuth, requireRole } from '../auth.js';
import { storage, UserRecord } from '../storage.js';

const router = Router();

// GET /api/users/me - Retrieve current authenticated user profile
router.get('/users/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    data: req.user,
  });
});

// GET /api/users - List users with role & department scoping
router.get('/users', requireRole('admin', 'department_coordinator'), async (req: AuthenticatedRequest, res: Response) => {
  const allUsers = Object.values(await storage.getAllUsers());
  let result = allUsers.map((u) => {
    // Strip sensitive auth tokens and password hashes
    const { auth_tokens, password_hash, ...safeUser } = u;
    return safeUser;
  });

  // Department Coordinators can only inspect users in their own department
  if (req.user!.role === 'department_coordinator') {
    const userDept = req.user!.department;
    result = result.filter((u) => u.department === userDept);
  }

  res.json({
    success: true,
    count: result.length,
    data: result,
  });
});

// POST /api/users - Create persistent user account (Admin only)
router.post('/users', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const {
    id,
    username,
    display_name,
    email,
    role,
    department,
    faculty_id,
    student_group_id,
    club_name,
    password,
  } = req.body;

  if (!id || !username || !display_name || !email || !role) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Missing required user fields (id, username, display_name, email, role).' },
    });
    return;
  }

  const validRoles = ['admin', 'department_coordinator', 'faculty', 'club', 'student'];
  if (!validRoles.includes(role)) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_ROLE', message: `Role '${role}' is invalid. Allowed: ${validRoles.join(', ')}` },
    });
    return;
  }

  try {
    const password_hash = password
      ? crypto.createHash('sha256').update(password).digest('hex')
      : undefined;

    const userPayload = {
      id: String(id).trim(),
      username: String(username).trim(),
      display_name: String(display_name).trim(),
      email: String(email).trim(),
      role,
      status: 'active' as const,
      department: department ? String(department).trim() : undefined,
      faculty_id: faculty_id ? String(faculty_id).trim() : undefined,
      student_group_id: student_group_id ? String(student_group_id).trim() : undefined,
      club_name: club_name ? String(club_name).trim() : undefined,
      auth_tokens: [`token-${id}-${Date.now()}`],
      password_hash,
    };

    const createdUser = await storage.createUser(userPayload);

    await storage.logAudit({
      user_id: req.user!.id,
      user_name: req.user!.name,
      role: req.user!.role,
      action: 'CREATE_USER_ACCOUNT',
      resource_type: 'user',
      resource_id: createdUser.id,
      details: { username: createdUser.username, role: createdUser.role },
      status: 'success',
    });

    const { auth_tokens, password_hash: _ph, ...safeUser } = createdUser;
    res.status(201).json({
      success: true,
      message: `User account '${createdUser.username}' created successfully`,
      data: safeUser,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: { code: 'REFERENTIAL_INTEGRITY_ERROR', message: err.message },
    });
  }
});

// PUT /api/users/:id - Update persistent user account (Admin only)
router.put('/users/:id', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.params.id;
  const updates = req.body;

  try {
    // Prevent updating immutable ID or injecting plaintext password
    delete updates.id;
    if (updates.password) {
      updates.password_hash = crypto.createHash('sha256').update(updates.password).digest('hex');
      delete updates.password;
    }

    const updatedUser = await storage.updateUser(userId, updates);

    await storage.logAudit({
      user_id: req.user!.id,
      user_name: req.user!.name,
      role: req.user!.role,
      action: 'UPDATE_USER_ACCOUNT',
      resource_type: 'user',
      resource_id: userId,
      details: { updated_fields: Object.keys(updates) },
      status: 'success',
    });

    const { auth_tokens, password_hash: _ph, ...safeUser } = updatedUser;
    res.json({
      success: true,
      message: `User account '${userId}' updated successfully`,
      data: safeUser,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: { code: 'USER_UPDATE_FAILED', message: err.message },
    });
  }
});

export default router;
