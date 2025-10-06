import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';

// ============================================
// WhatsApp Web Session Backup Service
// Only backs up ESSENTIAL files to prevent Chromium crashes
// ============================================

export class WhatsAppSessionBackup {
  private gridFS: GridFSBucket;

  constructor() {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not available');
    }
    this.gridFS = new GridFSBucket(db, { bucketName: 'whatsapp_sessions' });
  }

  /**
   * Essential files/folders for WhatsApp Web session preservation
   * Excludes cache, temporary files, and lock files that cause crashes
   */
  private getEssentialFiles(sessionPath: string): string[] {
    const essentialFiles: string[] = [];
    const defaultPath = path.join(sessionPath, 'Default');

    // Core session files (WhatsApp Web requires these for session persistence)
    const coreFiles = [
      'Cookies',
      'Cookies-journal', 
      'History',
      'History-journal',
      'Login Data',
      'Login Data-journal',
      'Login Data For Account',
      'Login Data For Account-journal',
      'Preferences',
      'Secure Preferences',
      'Web Data',
      'Web Data-journal',
      'Local State',
      'Network Persistent State', // Network session data
      'TransportSecurity', // SSL/TLS session data
      'Trust Tokens', // Trust token data
      'Trust Tokens-journal'
    ];

    // Essential folders (excluding cache and temporary data)
    const essentialFolders = [
      'IndexedDB', // WhatsApp Web data storage
      'Local Storage', // WhatsApp Web localStorage
      'Session Storage', // WhatsApp Web sessionStorage
      'Sessions', // Active browser sessions
      'WebStorage', // Additional web storage
      'blob_storage' // Blob storage for WhatsApp media
    ];

    // Add core files
    for (const file of coreFiles) {
      const filePath = path.join(defaultPath, file);
      if (fs.existsSync(filePath)) {
        essentialFiles.push(file);
      }
    }

    // Add essential folders (but exclude problematic subfolders)
    for (const folder of essentialFolders) {
      const folderPath = path.join(defaultPath, folder);
      if (fs.existsSync(folderPath)) {
        essentialFiles.push(folder);
      }
    }

    return essentialFiles;
  }

  /**
   * Exclude files that cause Chromium crashes or are unnecessary
   */
  private shouldExcludeFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    
    // Exclude lock files (cause crashes)
    const lockFiles = [
      'SingletonLock',
      'lockfile', 
      'SingletonSocket',
      'SingletonCookie',
      'DevToolsActivePort'
    ];

    // Exclude cache directories (unnecessary and large)
    const cacheDirs = [
      'Cache',
      'GPUCache',
      'Code Cache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'GrShaderCache',
      'ShaderCache'
    ];

    // Exclude temporary files
    const tempFiles = [
      'BrowserMetrics-spare.pma',
      'first_party_sets.db-journal',
      '*.tmp',
      '*.log'
    ];

    // Check lock files
    if (lockFiles.some(lock => fileName.includes(lock))) {
      return true;
    }

    // Check cache directories
    if (cacheDirs.some(cache => filePath.includes(cache))) {
      return true;
    }

    // Check temporary files
    if (tempFiles.some(temp => fileName.includes(temp.replace('*', '')))) {
      return true;
    }

    return false;
  }

  /**
   * Compress and upload session to MongoDB GridFS
   */
  async backupSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📦 [${clientId}] Starting session backup...`);
      
      const sessionPath = path.join(process.cwd(), 'tokens', clientId);
      if (!fs.existsSync(sessionPath)) {
        console.warn(`⚠️  [${clientId}] Session path not found: ${sessionPath}`);
        return false;
      }

      const defaultPath = path.join(sessionPath, 'Default');
      if (!fs.existsSync(defaultPath)) {
        console.warn(`⚠️  [${clientId}] Default profile not found: ${defaultPath}`);
        return false;
      }

      // Get essential files only
      const essentialFiles = this.getEssentialFiles(sessionPath);
      console.log(`📋 [${clientId}] Essential files: ${essentialFiles.join(', ')}`);

      if (essentialFiles.length === 0) {
        console.warn(`⚠️  [${clientId}] No essential files found`);
        return false;
      }

      // Create archive with essential files only
      const archive = archiver('zip', { 
        zlib: { level: 1 } // Fast compression
      });

      const uploadStream = this.gridFS.openUploadStream(`${clientId}_session.zip`, {
        metadata: {
          clientId,
          timestamp: new Date(),
          fileCount: essentialFiles.length
        }
      });

      archive.pipe(uploadStream);

      // Add entire Default directory structure (excluding problematic files)
      if (fs.existsSync(defaultPath)) {
        archive.directory(defaultPath, 'Default', (entry) => {
          if (this.shouldExcludeFile(entry.name)) {
            return false;
          }
          return entry;
        });
      }

      // Also add any root-level session files (excluding problematic ones)
      const rootFiles = fs.readdirSync(sessionPath);
      for (const file of rootFiles) {
        if (file === 'Default') continue; // Already added above
        
        const filePath = path.join(sessionPath, file);
        if (!this.shouldExcludeFile(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            archive.directory(filePath, file, (entry) => {
              if (this.shouldExcludeFile(entry.name)) {
                return false;
              }
              return entry;
            });
          } else {
            archive.file(filePath, { name: file });
          }
        }
      }

      await archive.finalize();

      return new Promise((resolve, reject) => {
        uploadStream.on('finish', () => {
          console.log(`✅ [${clientId}] Session backed up to MongoDB (${archive.pointer()} bytes)`);
          resolve(true);
        });

        uploadStream.on('error', (error) => {
          console.error(`❌ [${clientId}] Backup failed:`, error);
          reject(error);
        });
      });

    } catch (error) {
      console.error(`❌ [${clientId}] Session backup error:`, error);
      return false;
    }
  }

  /**
   * Download and restore session from MongoDB GridFS
   */
  async restoreSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📥 [${clientId}] Starting session restore...`);

      const sessionPath = path.join(process.cwd(), 'tokens', clientId);
      const defaultPath = path.join(sessionPath, 'Default');

      // Find the latest backup
      const files = await this.gridFS.find({ filename: `${clientId}_session.zip` })
        .sort({ uploadDate: -1 })
        .limit(1)
        .toArray();

      if (files.length === 0) {
        console.log(`📋 [${clientId}] No backup found in MongoDB`);
        return false;
      }

      const backupFile = files[0];
      if (!backupFile) {
        console.log(`📋 [${clientId}] No backup file found`);
        return false;
      }

      console.log(`📦 [${clientId}] Found backup from ${backupFile.uploadDate}`);

      // Clean existing session (but keep lock files for safety)
      if (fs.existsSync(defaultPath)) {
        console.log(`🧹 [${clientId}] Cleaning existing session...`);
        const files = fs.readdirSync(defaultPath);
        for (const file of files) {
          const filePath = path.join(defaultPath, file);
          if (!this.shouldExcludeFile(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        }
      } else {
        fs.mkdirSync(defaultPath, { recursive: true });
      }

      // Download and extract backup
      const downloadStream = this.gridFS.openDownloadStream(backupFile._id);
      const extract = require('extract-zip');

      const tempZipPath = path.join(process.cwd(), 'temp', `${clientId}_restore.zip`);
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

      console.log(`✅ [${clientId}] Session restored from MongoDB`);
      console.log(`📁 [${clientId}] Restored to: ${sessionPath}`);
      
      // Verify Default folder exists
      if (fs.existsSync(defaultPath)) {
        const files = fs.readdirSync(defaultPath);
        console.log(`📋 [${clientId}] Default folder contains: ${files.length} items`);
      } else {
        console.error(`❌ [${clientId}] Default folder missing after restore!`);
        return false;
      }
      
      return true;

    } catch (error) {
      console.error(`❌ [${clientId}] Session restore error:`, error);
      return false;
    }
  }

  /**
   * List available backups for a client or all backups
   */
  async listBackups(clientId: string = '*'): Promise<any[]> {
    try {
      let query: any = {};
      
      if (clientId !== '*') {
        query = { filename: `${clientId}_session.zip` };
      } else {
        // List all session backups
        query = { filename: { $regex: /_session\.zip$/ } };
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
      console.error(`❌ Error listing backups for ${clientId}:`, error);
      return [];
    }
  }

  /**
   * Delete old backups (keep only latest)
   */
  async cleanupOldBackups(clientId: string, keepCount: number = 3): Promise<void> {
    try {
      const files = await this.gridFS.find({ filename: `${clientId}_session.zip` })
        .sort({ uploadDate: -1 })
        .toArray();

      if (files.length > keepCount) {
        const toDelete = files.slice(keepCount);
        for (const file of toDelete) {
          await this.gridFS.delete(file._id);
          console.log(`🗑️  [${clientId}] Deleted old backup from ${file.uploadDate}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error cleaning up backups for ${clientId}:`, error);
    }
  }
}
