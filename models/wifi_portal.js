// routes/wifi_portal.js
import { Router } from 'express';
import AccessCode from '../models/AccessCode.js';
import AccessLog from '../models/AccessLog.js';

const router = Router();

// Your actual Starlink WiFi password (store in environment variable)
const WIFI_PASSWORD = process.env.STARLINK_WIFI_PASSWORD || 'YourStarlinkPassword123';
const WIFI_SSID = process.env.WIFI_SSID || 'Starlink';

// ==================== USER PORTAL HOME ====================

router.get('/', (req, res) => {
  res.render('wifi/portal', {
    error: null,
    success: null
  });
});

// ==================== VALIDATE ACCESS CODE ====================

router.post('/validate', async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || code.trim().length === 0) {
      return res.render('wifi/portal', {
        error: 'Please enter an access code',
        success: null
      });
    }
    
    // Find the access code
    const accessCode = await AccessCode.findOne({ 
      code: code.trim().toUpperCase() 
    });
    
    // Generate device fingerprint
    const deviceFingerprint = generateFingerprint(req);
    
    // Check if code exists
    if (!accessCode) {
      await logFailedAccess(code, req, 'Invalid code');
      return res.render('wifi/portal', {
        error: 'Invalid access code. Please check and try again.',
        success: null
      });
    }
    
    // Check if code is active
    if (!accessCode.isActive) {
      await logFailedAccess(code, req, 'Code is inactive');
      return res.render('wifi/portal', {
        error: 'This access code has been deactivated.',
        success: null
      });
    }
    
    // Check if code is revoked
    if (accessCode.revokedAt) {
      await logFailedAccess(code, req, 'Code is revoked');
      return res.render('wifi/portal', {
        error: 'This access code has been revoked.',
        success: null
      });
    }
    
    // Check if code is expired
    if (accessCode.expiresAt < new Date()) {
      await logFailedAccess(code, req, 'Code expired');
      return res.render('wifi/portal', {
        error: 'This access code has expired.',
        success: null
      });
    }
    
    // Check max uses
    if (accessCode.maxUses && accessCode.currentUses >= accessCode.maxUses) {
      await logFailedAccess(code, req, 'Max uses reached');
      return res.render('wifi/portal', {
        error: 'This access code has reached its maximum number of uses.',
        success: null
      });
    }
    
    // Check max devices (if set)
    if (accessCode.maxDevices) {
      const uniqueDevices = await AccessLog.distinct('deviceFingerprint', {
        accessCode: accessCode._id,
        deviceFingerprint: { $ne: null }
      });
      
      if (uniqueDevices.length >= accessCode.maxDevices && 
          !uniqueDevices.includes(deviceFingerprint)) {
        await logFailedAccess(code, req, 'Max devices reached');
        return res.render('wifi/portal', {
          error: 'This access code has reached its maximum device limit.',
          success: null
        });
      }
    }
    
    // CODE IS VALID - Log successful access
    await logSuccessfulAccess(accessCode, req, deviceFingerprint);
    
    // Increment usage count
    await accessCode.recordUse();
    
    // Calculate expiry info
    const now = new Date();
    const timeRemaining = accessCode.expiresAt - now;
    const hoursRemaining = Math.floor(timeRemaining / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
    
    // Show WiFi credentials
    res.render('wifi/success', {
      wifiSSID: WIFI_SSID,
      wifiPassword: WIFI_PASSWORD,
      code: accessCode.code,
      expiresAt: accessCode.expiresAt,
      hoursRemaining,
      minutesRemaining,
      usesRemaining: accessCode.maxUses ? (accessCode.maxUses - accessCode.currentUses) : null
    });
    
  } catch (error) {
    console.error('Validate code error:', error);
    res.render('wifi/portal', {
      error: 'An error occurred. Please try again.',
      success: null
    });
  }
});

// ==================== HELPER FUNCTIONS ====================

function generateFingerprint(req) {
  // Simple device fingerprint based on User-Agent + IP
  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || req.connection.remoteAddress || '';
  
  // Create hash (simple version - you can use crypto for better hashing)
  const fingerprint = Buffer.from(ua + ip).toString('base64').substring(0, 32);
  
  return fingerprint;
}

async function logSuccessfulAccess(accessCode, req, deviceFingerprint) {
  try {
    // Parse user agent
    const ua = req.headers['user-agent'] || '';
    let device = 'desktop';
    let browser = 'unknown';
    
    if (/mobile/i.test(ua)) device = 'mobile';
    else if (/tablet/i.test(ua)) device = 'tablet';
    
    if (/chrome/i.test(ua)) browser = 'Chrome';
    else if (/safari/i.test(ua)) browser = 'Safari';
    else if (/firefox/i.test(ua)) browser = 'Firefox';
    else if (/edge/i.test(ua)) browser = 'Edge';
    
    await AccessLog.create({
      accessCode: accessCode._id,
      code: accessCode.code,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: ua,
      device,
      browser,
      deviceFingerprint,
      passwordShown: true,
      success: true,
      accessedAt: new Date()
    });
  } catch (error) {
    console.error('Log access error:', error);
  }
}

async function logFailedAccess(code, req, reason) {
  try {
    const ua = req.headers['user-agent'] || '';
    let device = 'desktop';
    
    if (/mobile/i.test(ua)) device = 'mobile';
    else if (/tablet/i.test(ua)) device = 'tablet';
    
    await AccessLog.create({
      code: code.trim().toUpperCase(),
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: ua,
      device,
      deviceFingerprint: generateFingerprint(req),
      passwordShown: false,
      success: false,
      failureReason: reason,
      accessedAt: new Date()
    });
  } catch (error) {
    console.error('Log failed access error:', error);
  }
}

export default router;
