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

// PID file path
const PID_FILE = path.join(process.cwd(), '.wppconnect.pid');

// Define environment interface
const env: Environment = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || '3003',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-bot',
  JWT_SECRET: process.env.JWT_SECRET,
  WA_JWT_SECRET: process.env.WA_JWT_SECRET,
  CHROMIUM_PATH: process.env.CHROMIUM_PATH,
  FW_ENDPOINT: process.env.FW_ENDPOINT,
  ALLOWED_NUMBERS: process.env.ALLOWED_NUMBERS,
  UPLOAD_USER_ID: process.env.UPLOAD_USER_ID || undefined,
  UPLOAD_AUTH_TOKEN: process.env.UPLOAD_AUTH_TOKEN || undefined,
  AUTO_RESTART_CRON: process.env.AUTO_RESTART_CRON || undefined,
  AUTO_RESTART_METHOD: process.env.AUTO_RESTART_METHOD || undefined
};

/**
 * Check if another instance is running and gracefully shut it down
 */
async function checkAndShutdownExistingInstance(): Promise<void> {
  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      console.log(`⚠️  Found existing instance with PID: ${oldPid}`);
      
      // Check if process is actually running
      try {
        process.kill(oldPid, 0); // Signal 0 checks if process exists
        console.log(`📤 Sending graceful shutdown signal (SIGTERM) to PID ${oldPid}...`);
        
        // Send SIGTERM for graceful shutdown
        process.kill(oldPid, 'SIGTERM');
        
        // Wait for graceful shutdown (15 seconds)
        console.log('⏳ Waiting for existing instance to shut down gracefully (15 seconds)...');
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        // Check if still running
        try {
          process.kill(oldPid, 0);
          console.log(`⚠️  Instance still running after 15s, force killing PID ${oldPid}...`);
          process.kill(oldPid, 'SIGKILL');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch {
          console.log(`✅ Existing instance shut down gracefully`);
        }
        
        // Clean up PID file
        if (fs.existsSync(PID_FILE)) {
          fs.unlinkSync(PID_FILE);
        }
      } catch (err) {
        // Process doesn't exist, just remove stale PID file
        console.log(`ℹ️  PID ${oldPid} not running, removing stale PID file`);
        if (fs.existsSync(PID_FILE)) {
          fs.unlinkSync(PID_FILE);
                }
            }
        } catch (error) {
      console.error('⚠️  Error checking existing instance:', error);
      // Remove corrupted PID file if it exists
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
    console.log('🔍 Checking for existing server instances...');
    
    // Check for existing instance and shut it down gracefully FIRST
    await checkAndShutdownExistingInstance();
    
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
