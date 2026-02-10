// routes/wifi_admin.js
import { Router } from 'express';
import AccessCode from '../models/AccessCode.js';
import AccessLog from '../models/AccessLog.js';
import { ensureAuth } from '../middleware/authGuard.js';

const router = Router();

// Middleware: Only admins can access
router.use(ensureAuth);
router.use((req, res, next) => {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).send('Access denied. Admins only.');
  }
  next();
});

// ==================== ADMIN DASHBOARD ====================

router.get('/dashboard', async (req, res) => {
  try {
    const now = new Date();
    
    // Get all active codes
    const activeCodes = await AccessCode.find({ 
      isActive: true,
      expiresAt: { $gt: now }
    })
    .populate('createdBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .lean();
    
    // Get expired codes (last 30 days)
    const expiredCodes = await AccessCode.find({
      $or: [
        { isActive: false },
        { expiresAt: { $lte: now } }
      ],
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    })
    .populate('createdBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
    
    // Get recent access logs
    const recentAccess = await AccessLog.find()
      .populate('accessCode', 'code description')
      .sort({ accessedAt: -1 })
      .limit(100)
      .lean();
    
    // Stats
    const stats = {
      totalActive: activeCodes.length,
      totalExpired: expiredCodes.length,
      totalAccessesToday: await AccessLog.countDocuments({
        accessedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
      totalAccessesWeek: await AccessLog.countDocuments({
        accessedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      })
    };
    
    res.render('admin/wifi/dashboard', {
      activeCodes,
      expiredCodes,
      recentAccess,
      stats
    });
    
  } catch (error) {
    console.error('WiFi dashboard error:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// ==================== CREATE ACCESS CODE ====================

router.get('/create', (req, res) => {
  res.render('admin/wifi/create');
});

router.post('/create', async (req, res) => {
  try {
    const { description, duration, maxUses, maxDevices } = req.body;
    
    // Generate unique code
    const code = await AccessCode.generateCode();
    
    // Calculate expiration
    const durationHours = parseInt(duration) || 24;
    const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    
    // Create code
    const accessCode = await AccessCode.create({
      code,
      createdBy: req.user._id,
      description: description || '',
      expiresAt,
      maxUses: maxUses ? parseInt(maxUses) : null,
      maxDevices: maxDevices ? parseInt(maxDevices) : null,
      isActive: true
    });
    
    res.json({
      success: true,
      code: accessCode.code,
      expiresAt: accessCode.expiresAt,
      message: 'Access code created successfully'
    });
    
  } catch (error) {
    console.error('Create code error:', error);
    res.status(500).json({ success: false, message: 'Error creating code' });
  }
});

// ==================== QUICK CREATE (AJAX) ====================

router.post('/quick-create', async (req, res) => {
  try {
    const { hours } = req.body;
    
    const code = await AccessCode.generateCode();
    const expiresAt = new Date(Date.now() + (parseInt(hours) || 24) * 60 * 60 * 1000);
    
    const accessCode = await AccessCode.create({
      code,
      createdBy: req.user._id,
      description: `Quick ${hours}h code`,
      expiresAt,
      isActive: true
    });
    
    res.json({
      success: true,
      code: accessCode.code,
      expiresAt: accessCode.expiresAt
    });
    
  } catch (error) {
    console.error('Quick create error:', error);
    res.status(500).json({ success: false, message: 'Error' });
  }
});

// ==================== VIEW CODE DETAILS ====================

router.get('/code/:id', async (req, res) => {
  try {
    const code = await AccessCode.findById(req.params.id)
      .populate('createdBy', 'firstName lastName email')
      .populate('revokedBy', 'firstName lastName')
      .lean();
    
    if (!code) {
      return res.status(404).send('Code not found');
    }
    
    // Get access logs for this code
    const accessLogs = await AccessLog.find({ accessCode: code._id })
      .sort({ accessedAt: -1 })
      .lean();
    
    // Get stats
    const stats = await AccessLog.getStats(code._id);
    
    res.render('admin/wifi/code-details', {
      code,
      accessLogs,
      stats
    });
    
  } catch (error) {
    console.error('View code error:', error);
    res.status(500).send('Error loading code details');
  }
});

// ==================== REVOKE CODE ====================

router.post('/revoke/:id', async (req, res) => {
  try {
    const { reason } = req.body;
    
    const code = await AccessCode.findById(req.params.id);
    if (!code) {
      return res.status(404).json({ success: false, message: 'Code not found' });
    }
    
    await code.revoke(req.user._id, reason || 'Revoked by admin');
    
    res.json({
      success: true,
      message: 'Code revoked successfully'
    });
    
  } catch (error) {
    console.error('Revoke code error:', error);
    res.status(500).json({ success: false, message: 'Error revoking code' });
  }
});

// ==================== REACTIVATE CODE ====================

router.post('/reactivate/:id', async (req, res) => {
  try {
    const code = await AccessCode.findById(req.params.id);
    if (!code) {
      return res.status(404).json({ success: false, message: 'Code not found' });
    }
    
    // Check if expired
    if (code.expiresAt < new Date()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot reactivate expired code. Create a new one.' 
      });
    }
    
    code.isActive = true;
    code.revokedAt = null;
    code.revokedBy = null;
    code.revokeReason = null;
    await code.save();
    
    res.json({
      success: true,
      message: 'Code reactivated successfully'
    });
    
  } catch (error) {
    console.error('Reactivate code error:', error);
    res.status(500).json({ success: false, message: 'Error reactivating code' });
  }
});

// ==================== DELETE CODE ====================

router.delete('/code/:id', async (req, res) => {
  try {
    await AccessCode.findByIdAndDelete(req.params.id);
    
    // Also delete access logs if desired
    // await AccessLog.deleteMany({ accessCode: req.params.id });
    
    res.json({
      success: true,
      message: 'Code deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete code error:', error);
    res.status(500).json({ success: false, message: 'Error deleting code' });
  }
});

// ==================== ANALYTICS ====================

router.get('/analytics', async (req, res) => {
  try {
    const { range = '7d' } = req.query;
    
    // Calculate date range
    const now = new Date();
    let startDate;
    
    switch(range) {
      case '24h':
        startDate = new Date(now - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
    }
    
    // Get access logs for the period
    const logs = await AccessLog.find({
      accessedAt: { $gte: startDate, $lte: now }
    }).populate('accessCode', 'code description');
    
    // Aggregate stats
    const stats = {
      totalAccesses: logs.length,
      uniqueIPs: [...new Set(logs.map(l => l.ipAddress))].length,
      uniqueDevices: [...new Set(logs.map(l => l.deviceFingerprint).filter(Boolean))].length,
      successRate: ((logs.filter(l => l.success).length / logs.length) * 100).toFixed(2),
      deviceBreakdown: {}
    };
    
    // Device breakdown
    logs.forEach(log => {
      const device = log.device || 'unknown';
      stats.deviceBreakdown[device] = (stats.deviceBreakdown[device] || 0) + 1;
    });
    
    // Daily activity
    const dailyActivity = {};
    logs.forEach(log => {
      const date = log.accessedAt.toISOString().split('T')[0];
      dailyActivity[date] = (dailyActivity[date] || 0) + 1;
    });
    
    res.render('admin/wifi/analytics', {
      stats,
      dailyActivity,
      range,
      logs: logs.slice(0, 100) // Recent 100
    });
    
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).send('Error loading analytics');
  }
});

// ==================== CLEANUP EXPIRED CODES ====================

router.post('/cleanup', async (req, res) => {
  try {
    const count = await AccessCode.cleanExpired();
    
    res.json({
      success: true,
      message: `Cleaned up ${count} expired codes`
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ success: false, message: 'Error during cleanup' });
  }
});

export default router;
