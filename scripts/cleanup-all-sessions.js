/**
 * Cleanup script to remove ALL WhatsApp sessions:
 * 1. Deletes local tokens/ folder
 * 2. Deletes MongoDB GridFS backups (whatsapp_sessions and wppconnect_tokens buckets)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { GridFSBucket } = require('mongodb');

async function cleanupAllSessions() {
  try {
    // Connect to MongoDB
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;

    // 1. Delete local tokens folder
    const tokensPath = path.join(process.cwd(), 'tokens');
    if (fs.existsSync(tokensPath)) {
      console.log(`🗑️  Deleting local tokens folder: ${tokensPath}`);
      fs.rmSync(tokensPath, { recursive: true, force: true });
      console.log('✅ Local tokens folder deleted');
    } else {
      console.log('ℹ️  Local tokens folder does not exist');
    }

    // 2. Delete MongoDB GridFS backups - whatsapp_sessions bucket
    console.log('\n🗑️  Deleting MongoDB GridFS backups (whatsapp_sessions bucket)...');
    const whatsappSessionsBucket = new GridFSBucket(db, { bucketName: 'whatsapp_sessions' });
    const whatsappFiles = await whatsappSessionsBucket.find({}).toArray();
    console.log(`📋 Found ${whatsappFiles.length} files in whatsapp_sessions bucket`);
    
    for (const file of whatsappFiles) {
      try {
        await whatsappSessionsBucket.delete(file._id);
        console.log(`✅ Deleted: ${file.filename}`);
      } catch (error) {
        console.error(`❌ Error deleting ${file.filename}:`, error.message);
      }
    }

    // 3. Delete MongoDB GridFS backups - wppconnect_tokens bucket
    console.log('\n🗑️  Deleting MongoDB GridFS backups (wppconnect_tokens bucket)...');
    const tokensBucket = new GridFSBucket(db, { bucketName: 'wppconnect_tokens' });
    const tokenFiles = await tokensBucket.find({}).toArray();
    console.log(`📋 Found ${tokenFiles.length} files in wppconnect_tokens bucket`);
    
    for (const file of tokenFiles) {
      try {
        await tokensBucket.delete(file._id);
        console.log(`✅ Deleted: ${file.filename}`);
      } catch (error) {
        console.error(`❌ Error deleting ${file.filename}:`, error.message);
      }
    }

    console.log('\n✅ All sessions cleaned up!');
    console.log('📋 Next steps:');
    console.log('   1. Restart your application');
    console.log('   2. Create a new client - it will require QR code scan');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error cleaning up sessions:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

cleanupAllSessions();
