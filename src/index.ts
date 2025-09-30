import dotenv from 'dotenv';
import mongoose from 'mongoose';
import WPPConnectWhatsAppBotApp from './app';
import { Environment } from './types';

// ============================================
// WPPConnect WhatsApp Bot Application Entry Point
// ============================================

// Load environment variables
dotenv.config();

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

async function startWPPConnectApplication(): Promise<void> {
  try {
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

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n⏹️  Received SIGINT, shutting down gracefully...');
      await app.gracefulShutdown();
      await mongoose.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n⏹️  Received SIGTERM, shutting down gracefully...');
      await app.gracefulShutdown();
      await mongoose.disconnect();
      process.exit(0);
    });

        } catch (error) {
    console.error('❌ Failed to start WPPConnect WhatsApp Bot Application:', error);
    process.exit(1);
  }
}

// Start the application
startWPPConnectApplication();
