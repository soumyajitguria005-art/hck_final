import express, { Request, Response, NextFunction } from 'express';
import { authenticateUser } from './auth.js';
import healthRouter from './routes/health.js';
import datasetRouter from './routes/dataset.js';
import timetableRouter from './routes/timetable.js';
import examsRouter from './routes/exams.js';
import bookingsRouter from './routes/bookings.js';
import disruptionsRouter from './routes/disruptions.js';
import calendarRouter from './routes/calendar.js';
import auditRouter from './routes/audit.js';
import usersRouter from './routes/users.js';

export function createExpressApp() {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Global authentication middleware (populates req.user)
  app.use('/api', authenticateUser as any);

  // Mount API routers
  app.use('/api', healthRouter);
  app.use('/api', datasetRouter);
  app.use('/api', timetableRouter);
  app.use('/api', examsRouter);
  app.use('/api', bookingsRouter);
  app.use('/api', disruptionsRouter);
  app.use('/api', calendarRouter);
  app.use('/api', auditRouter);
  app.use('/api', usersRouter);

  // 404 handler for undefined API routes
  app.all('/api/*', (req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: { code: 'ENDPOINT_NOT_FOUND', message: `API endpoint '${req.method} ${req.path}' does not exist` },
    });
  });

  // Central error handling middleware
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    const code = err.code || 'INTERNAL_SERVER_ERROR';
    // Sanitize any internal server file paths from error messages
    const message = (err.message || 'An unexpected error occurred').replace(/\/app\/[^\s]+/g, '[path]');

    res.status(status).json({
      success: false,
      error: { code, message },
    });
  });

  return app;
}
