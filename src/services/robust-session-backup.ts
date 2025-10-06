import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';

// ============================================
// Robust WhatsApp Web Session Backup Service
// Complete session preservation with browser state management
// ============================================

export class RobustSessionBackup {
  private gridFS: GridFSBucket;

  constructor() {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not available');
    }
    this.gridFS = new GridFSBucket(db, { bucketName: 'whatsapp_sessions' });
  }

  /**
   * Complete session backup - backs up EVERYTHING except problematic files
   */
  async backupCompleteSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📦 [${clientId}] Starting COMPLETE session backup...`);
      
      const sessionPath = path.join(process.cwd(), 'tokens', clientId);
      if (!fs.existsSync(sessionPath)) {
        console.warn(`⚠️  [${clientId}] Session path not found: ${sessionPath}`);
        return false;
      }

      // Create archive with COMPLETE session
      const archive = archiver('zip', { 
        zlib: { level: 1 } // Fast compression
      });

      const uploadStream = this.gridFS.openUploadStream(`${clientId}_complete_session.zip`, {
        metadata: {
          clientId,
          timestamp: new Date(),
          type: 'complete_session'
        }
      });

      archive.pipe(uploadStream);

      // Add ENTIRE session directory (excluding only the most problematic files)
      archive.directory(sessionPath, false, (entry) => {
        // Only exclude files that are guaranteed to cause crashes
        const problematicFiles = [
          'SingletonLock',
          'lockfile',
          'DevToolsActivePort'
        ];
        
        if (problematicFiles.some(problem => entry.name.includes(problem))) {
          return false;
        }
        return entry;
      });

      await archive.finalize();

      return new Promise((resolve, reject) => {
        uploadStream.on('finish', () => {
          console.log(`✅ [${clientId}] COMPLETE session backed up to MongoDB (${archive.pointer()} bytes)`);
          resolve(true);
        });

        uploadStream.on('error', (error) => {
          console.error(`❌ [${clientId}] Complete backup failed:`, error);
          reject(error);
        });
      });

    } catch (error) {
      console.error(`❌ [${clientId}] Complete session backup error:`, error);
      return false;
    }
  }

  /**
   * Restore complete session with proper browser state management
   */
  async restoreCompleteSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📥 [${clientId}] Starting COMPLETE session restore...`);

      const sessionPath = path.join(process.cwd(), 'tokens', clientId);

      // Find the latest complete backup
      const files = await this.gridFS.find({ 
        filename: `${clientId}_complete_session.zip`,
        'metadata.type': 'complete_session'
      })
        .sort({ uploadDate: -1 })
        .limit(1)
        .toArray();

      if (files.length === 0) {
        console.log(`📋 [${clientId}] No complete backup found in MongoDB`);
        return false;
      }

      const backupFile = files[0];
      if (!backupFile) {
        console.log(`📋 [${clientId}] No backup file found`);
        return false;
      }

      console.log(`📦 [${clientId}] Found complete backup from ${backupFile.uploadDate}`);

      // COMPLETELY remove existing session directory
      if (fs.existsSync(sessionPath)) {
        console.log(`🧹 [${clientId}] Completely removing existing session...`);
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      // Create fresh session directory
      fs.mkdirSync(sessionPath, { recursive: true });

      // Download and extract complete backup
      const downloadStream = this.gridFS.openDownloadStream(backupFile._id);
      const extract = require('extract-zip');

      const tempZipPath = path.join(process.cwd(), 'temp', `${clientId}_complete_restore.zip`);
      const writeStream = fs.createWriteStream(tempZipPath);

      await new Promise<void>((resolve, reject) => {
        downloadStream.pipe(writeStream);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
      });

      // Extract to session directory
      await extract(tempZipPath, { dir: sessionPath });
      
      // Clean up temp file
      fs.unlinkSync(tempZipPath);

      // Clean up any lock files that might prevent session restoration
      this.cleanupAllLockFiles(sessionPath);

      // Wait for filesystem to fully stabilize
      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`✅ [${clientId}] COMPLETE session restored from MongoDB`);
      console.log(`📁 [${clientId}] Restored to: ${sessionPath}`);
      
      // Verify session structure
      const defaultPath = path.join(sessionPath, 'Default');
      if (fs.existsSync(defaultPath)) {
        const files = fs.readdirSync(defaultPath);
        console.log(`📋 [${clientId}] Default folder contains: ${files.length} items`);
      }

      const localStatePath = path.join(sessionPath, 'Local State');
      if (fs.existsSync(localStatePath)) {
        const stat = fs.statSync(localStatePath);
        console.log(`📋 [${clientId}] Local State file: ${stat.size} bytes`);
      }
      
      return true;

    } catch (error) {
      console.error(`❌ [${clientId}] Complete session restore error:`, error);
      return false;
    }
  }

  /**
   * Aggressive cleanup of ALL lock files
   */
  private cleanupAllLockFiles(sessionPath: string): void {
    const lockFiles = [
      'SingletonLock',
      'lockfile',
      'SingletonSocket', 
      'SingletonCookie',
      'DevToolsActivePort',
      'RunningChromeVersion',
      'Last Version',
      'ChromeFeatureState',
      'Variations'
    ];

    console.log(`🧹 Cleaning up ALL lock files in ${sessionPath}...`);

    // Clean root level
    for (const lockFile of lockFiles) {
      const lockPath = path.join(sessionPath, lockFile);
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          console.log(`🧹 Cleaned up root lock file: ${lockFile}`);
        } catch (error) {
          console.warn(`⚠️  Could not remove root lock file ${lockFile}:`, error);
        }
      }
    }

    // Clean Default level
    const defaultPath = path.join(sessionPath, 'Default');
    if (fs.existsSync(defaultPath)) {
      for (const lockFile of lockFiles) {
        const lockPath = path.join(defaultPath, lockFile);
        if (fs.existsSync(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
            console.log(`🧹 Cleaned up Default lock file: ${lockFile}`);
          } catch (error) {
            console.warn(`⚠️  Could not remove Default lock file ${lockFile}:`, error);
          }
        }
      }
    }
  }

  /**
   * List available complete backups
   */
  async listCompleteBackups(clientId: string = '*'): Promise<any[]> {
    try {
      let query: any = {};
      
      if (clientId !== '*') {
        query = { 
          filename: `${clientId}_complete_session.zip`,
          'metadata.type': 'complete_session'
        };
      } else {
        query = { 
          filename: { $regex: /_complete_session\.zip$/ },
          'metadata.type': 'complete_session'
        };
      }
      
      const files = await this.gridFS.find(query)
        .sort({ uploadDate: -1 })
        .toArray();
      
      return files.map(file => ({
        id: file._id,
        filename: file.filename,
        uploadDate: file.uploadDate,
        size: file.length,
        metadata: file.metadata
      }));
    } catch (error) {
      console.error(`❌ Error listing complete backups for ${clientId}:`, error);
      return [];
    }
  }

  /**
   * Delete old complete backups (keep only latest)
   */
  async cleanupOldCompleteBackups(clientId: string, keepCount: number = 2): Promise<void> {
    try {
      const files = await this.gridFS.find({ 
        filename: `${clientId}_complete_session.zip`,
        'metadata.type': 'complete_session'
      })
        .sort({ uploadDate: -1 })
        .toArray();

      if (files.length > keepCount) {
        const toDelete = files.slice(keepCount);
        for (const file of toDelete) {
          await this.gridFS.delete(file._id);
          console.log(`🗑️  [${clientId}] Deleted old complete backup from ${file.uploadDate}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error cleaning up complete backups for ${clientId}:`, error);
    }
  }
}
