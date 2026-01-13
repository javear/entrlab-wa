import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import WPPConnectWhatsAppBotApp from './app';
import { Environment } from './types';

// ============================================
// WPPConnect WhatsApp Bot Application Entry Point
// ============================================

// Load environment variables
dotenv.config();

// ============================================
// Suppress expected Puppeteer protocol errors from WPPConnect
// These errors occur during wapi.js injection when pages are loading/navigating
// They are handled by WPPConnect's internal retry logic and are non-fatal
// ============================================
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Filter out expected Puppeteer protocol errors
const shouldSuppressError = (message: string): boolean => {
  if (typeof message !== 'string') return false;
  
  const suppressedPatterns = [
    'Protocol error (DOM.describeNode): Cannot find context',
    'Protocol error (DOM.resolveNode): No node with given id found',
    'Execution context was destroyed, most likely because of a navigation',
    'wapi.js failed',
    'Cannot find context with specified id',
    'No node with given id found'
  ];
  
  return suppressedPatterns.some(pattern => message.includes(pattern));
};

console.error = (...args: any[]) => {
  // Check all arguments for suppressed patterns (handle both strings and Error objects)
  const message = args.map(arg => {
    if (arg instanceof Error) return arg.message || arg.toString();
    return String(arg);
  }).join(' ');
  
  // Suppress expected Puppeteer errors from WPPConnect
  if (shouldSuppressError(message)) {
    // Optionally log at debug level (commented out to reduce noise)
    // originalConsoleWarn('🔇 Suppressed expected Puppeteer error:', message.substring(0, 80));
    return;
  }
  originalConsoleError.apply(console, args);
};

console.warn = (...args: any[]) => {
  // Check all arguments for suppressed patterns (handle both strings and Error objects)
  const message = args.map(arg => {
    if (arg instanceof Error) return arg.message || arg.toString();
    return String(arg);
  }).join(' ');
  
  // Suppress expected Puppeteer warnings from WPPConnect
  if (shouldSuppressError(message)) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

// PID file path - use Railway volume if available, otherwise current directory
const PID_FILE = process.env.RAILWAY_VOLUME_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_PATH, '.wppconnect.pid')
  : path.join(process.cwd(), '.wppconnect.pid');

// Define environment interface
const env: Environment = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || '3003',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-bot',
  JWT_SECRET: process.env.JWT_SECRET,
  WA_JWT_SECRET: process.env.WA_JWT_SECRET,
  CHROMIUM_PATH: process.env.CHROMIUM_PATH,
  FW_ENDPOINT: process.env.FW_ENDPOINT,
  FW_ENDPOINT_WORKFLOW: process.env.FW_ENDPOINT_WORKFLOW,
  ALLOWED_NUMBERS: process.env.ALLOWED_NUMBERS,
  UPLOAD_USER_ID: process.env.UPLOAD_USER_ID || undefined,
  UPLOAD_AUTH_TOKEN: process.env.UPLOAD_AUTH_TOKEN || undefined,
  AUTO_RESTART_CRON: process.env.AUTO_RESTART_CRON || undefined,
  AUTO_RESTART_METHOD: process.env.AUTO_RESTART_METHOD || undefined
};

/**
 * Check if another instance is running and clean up stale PID file
 * In Railway/Docker, the old process is already gone when container restarts
 */
async function checkAndCleanupPidFile(): Promise<void> {
  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      
      // Check if process is actually running
      try {
        process.kill(oldPid, 0); // Signal 0 checks if process exists
        
        // Process exists - this shouldn't happen in Railway/Docker
        // but handle it just in case
        if (oldPid === process.pid) {
          console.log(`⚠️  PID file contains current process ID, removing stale file`);
          fs.unlinkSync(PID_FILE);
        } else {
          console.log(`⚠️  Found running process with PID: ${oldPid}, sending SIGTERM...`);
          process.kill(oldPid, 'SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Try to remove PID file
          if (fs.existsSync(PID_FILE)) {
            fs.unlinkSync(PID_FILE);
          }
        }
      } catch (err) {
        // Process doesn't exist - normal case in Railway/Docker restart
        console.log(`ℹ️  Cleaning up stale PID file (old PID: ${oldPid})`);
        fs.unlinkSync(PID_FILE);
      }
    } catch (error) {
      console.error('⚠️  Error reading PID file:', error);
      // Remove corrupted PID file
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
    }
  }
}

/**
 * Write current process PID to file
 */
function writePidFile(): void {
  fs.writeFileSync(PID_FILE, process.pid.toString());
  console.log(`📝 PID file created: ${PID_FILE} (PID: ${process.pid})`);
}

/**
 * Remove PID file on exit
 */
function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      console.log('🧹 PID file removed');
            }
        } catch (error) {
    console.error('⚠️  Error removing PID file:', error);
  }
}

async function startWPPConnectApplication(): Promise<void> {
  try {
    console.log('🔍 Checking for stale PID files...');
    
    // Clean up any stale PID file from previous instance
    await checkAndCleanupPidFile();
    
    // NOTE: We don't delete the entire /tokens folder anymore because:
    // 1. The restore process already handles cleaning individual client folders before restoring
    // 2. Complete deletion can cause timing issues with session restoration
    // 3. Keeping existing folders allows faster reconnection for already-restored sessions
    // 
    // If you need to force a complete clean state, you can uncomment the following code:
    /*
    const tokensPath = path.join(process.cwd(), 'tokens');
    if (fs.existsSync(tokensPath)) {
      console.log('🧹 Cleaning up old /tokens folder for fresh session restore...');
      try {
        fs.rmSync(tokensPath, { recursive: true, force: true });
        console.log('✅ /tokens folder removed - sessions will restore from MongoDB');
      } catch (error) {
        console.warn('⚠️  Could not remove /tokens folder:', error);
      }
    }
    */
    console.log('ℹ️  /tokens folder will be managed per-client during session restoration');
    
    console.log('🚀 Starting WPPConnect WhatsApp Bot Application...');
    console.log('🔧 Environment variables:');
    console.log(`  - NODE_ENV: ${env.NODE_ENV}`);
    console.log(`  - PORT: ${env.PORT}`);
    console.log(`  - MONGODB_URI: ${env.MONGODB_URI ? 'SET' : 'NOT SET'}`);
    console.log(`  - JWT_SECRET: ${env.JWT_SECRET ? 'SET' : 'NOT SET'} (for inference API)`);
    console.log(`  - WA_JWT_SECRET: ${env.WA_JWT_SECRET ? 'SET' : 'NOT SET'} (for WhatsApp Bot API)`);
    console.log(`  - CHROMIUM_PATH: ${env.CHROMIUM_PATH || 'DEFAULT'}`);
    console.log(`  - FW_ENDPOINT: ${env.FW_ENDPOINT || 'NOT SET'}`);
    console.log(`  - ALLOWED_NUMBERS: ${env.ALLOWED_NUMBERS || 'NOT SET'}`);
    console.log(`  - UPLOAD_USER_ID: ${env.UPLOAD_USER_ID ? 'SET' : 'NOT SET'}`);
    console.log(`  - UPLOAD_AUTH_TOKEN: ${env.UPLOAD_AUTH_TOKEN ? 'SET' : 'NOT SET'}`);
    console.log(`  - AUTO_RESTART_CRON: ${env.AUTO_RESTART_CRON || 'NOT SET'}`);
    console.log(`  - AUTO_RESTART_METHOD: ${env.AUTO_RESTART_METHOD || 'NOT SET'}`);

    // Connect to MongoDB
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(env.MONGODB_URI!);
    console.log('✅ Connected to MongoDB successfully');

    // Create and start WPPConnect application
    const app = new WPPConnectWhatsAppBotApp(env);
    await app.start(parseInt(env.PORT || '3003'));
    
    // Write PID file after successful start
    writePidFile();

    // Handle graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n⏹️  Received ${signal}, shutting down gracefully...`);
      await app.gracefulShutdown();
      await mongoose.disconnect();
      cleanupPidFile();
      process.exit(0);
    };
    
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    
    // Also handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught Exception:', error);
      cleanupPidFile();
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      cleanupPidFile();
      process.exit(1);
    });

        } catch (error) {
    console.error('❌ Failed to start WPPConnect WhatsApp Bot Application:', error);
    cleanupPidFile();
    process.exit(1);
  }
}

// Start the application
startWPPConnectApplication();
