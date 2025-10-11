import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import { MEMORY_CONFIG, suggestGC } from '../config/memory-config';

// ============================================
// WhatsApp-Specific Session Backup Service
// Only backs up WhatsApp Web data that's portable across servers
// Excludes environment-specific browser data
// Optimized for low memory usage with streaming
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
   * Get only WhatsApp Web essential data (portable across servers)
   */
  private getWhatsAppEssentialFiles(sessionPath: string): string[] {
    const essentialFiles: string[] = [];
    const defaultPath = path.join(sessionPath, 'Default');

    // WhatsApp Web specific files only
    const whatsappFiles = [
      'Cookies', // WhatsApp Web cookies
      'Cookies-journal',
      'Preferences', // Browser preferences
      'Secure Preferences', // Secure browser preferences
      'Local State' // Browser state (but we'll clean environment-specific parts)
    ];

    // WhatsApp Web specific folders only
    const whatsappFolders = [
      'IndexedDB', // WhatsApp Web data storage
      'Local Storage', // WhatsApp Web localStorage
      'Session Storage' // WhatsApp Web sessionStorage
    ];

    // Add WhatsApp-specific files
    for (const file of whatsappFiles) {
      const filePath = file === 'Local State' 
        ? path.join(sessionPath, file) // Root level
        : path.join(defaultPath, file); // Default level
      
      if (fs.existsSync(filePath)) {
        essentialFiles.push(file);
      }
    }

    // Add WhatsApp-specific folders
    for (const folder of whatsappFolders) {
      const folderPath = path.join(defaultPath, folder);
      if (fs.existsSync(folderPath)) {
        essentialFiles.push(folder);
      }
    }

    return essentialFiles;
  }

  /**
   * Clean Local State file to remove environment-specific data
   */
  private cleanLocalStateFile(localStatePath: string): string {
    try {
      const content = fs.readFileSync(localStatePath, 'utf8');
      const data = JSON.parse(content);
      
      // Remove environment-specific data
      if (data.profile && data.profile.info_cache) {
        // Keep profile info but remove environment-specific paths
        delete data.profile.info_cache.default;
      }
      
      // Remove browser-specific paths
      if (data.browser) {
        delete data.browser.user_data_dir;
      }
      
      return JSON.stringify(data, null, 2);
    } catch (error) {
      console.warn(`⚠️  Could not clean Local State file: ${error}`);
      return fs.readFileSync(localStatePath, 'utf8');
    }
  }

  /**
   * Backup only WhatsApp Web essential data
   */
  async backupWhatsAppSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📦 [${clientId}] Starting WhatsApp-specific session backup...`);
      
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

      // Get only WhatsApp essential files
      const essentialFiles = this.getWhatsAppEssentialFiles(sessionPath);
      console.log(`📋 [${clientId}] WhatsApp essential files: ${essentialFiles.join(', ')}`);

      if (essentialFiles.length === 0) {
        console.warn(`⚠️  [${clientId}] No WhatsApp essential files found`);
        return false;
      }

      // Create archive with WhatsApp data only - balanced compression
      const archive = archiver('zip', { 
        zlib: { level: MEMORY_CONFIG.BACKUP_COMPRESSION_LEVEL }, // Balanced compression
        highWaterMark: MEMORY_CONFIG.BACKUP_CHUNK_SIZE // Control memory usage
      });

      const uploadStream = this.gridFS.openUploadStream(`${clientId}_whatsapp_session.zip`, {
        metadata: {
          clientId,
          timestamp: new Date(),
          type: 'whatsapp_specific',
          fileCount: essentialFiles.length
        }
      });

      archive.pipe(uploadStream);

      // Add WhatsApp-specific files
      for (const file of essentialFiles) {
        const filePath = file === 'Local State' 
          ? path.join(sessionPath, file)
          : path.join(defaultPath, file);
          
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            // Add WhatsApp data directories
            archive.directory(filePath, file);
          } else if (file === 'Local State') {
            // Clean and add Local State
            const cleanedContent = this.cleanLocalStateFile(filePath);
            archive.append(cleanedContent, { name: file });
          } else {
            // Add regular files
            archive.file(filePath, { name: file });
          }
        }
      }

      await archive.finalize();

      return new Promise((resolve, reject) => {
        uploadStream.on('finish', () => {
          console.log(`✅ [${clientId}] WhatsApp session backed up to MongoDB (${archive.pointer()} bytes)`);
          
          // Suggest garbage collection after large operation
          if (MEMORY_CONFIG.GC_AFTER_LARGE_OPERATION) {
            suggestGC();
          }
          
          resolve(true);
        });

        uploadStream.on('error', (error) => {
          console.error(`❌ [${clientId}] WhatsApp backup failed:`, error);
          reject(error);
        });
      });

    } catch (error) {
      console.error(`❌ [${clientId}] WhatsApp session backup error:`, error);
      return false;
    }
  }

  /**
   * Restore WhatsApp session data to new environment
   */
  async restoreWhatsAppSession(clientId: string): Promise<boolean> {
    try {
      console.log(`📥 [${clientId}] Starting WhatsApp session restore...`);

      const sessionPath = path.join(process.cwd(), 'tokens', clientId);
      const defaultPath = path.join(sessionPath, 'Default');

      // Find the latest WhatsApp backup
      const files = await this.gridFS.find({ 
        filename: `${clientId}_whatsapp_session.zip`,
        'metadata.type': 'whatsapp_specific'
      })
        .sort({ uploadDate: -1 })
        .limit(1)
        .toArray();

      if (files.length === 0) {
        console.log(`📋 [${clientId}] No WhatsApp backup found in MongoDB`);
        return false;
      }

      const backupFile = files[0];
      if (!backupFile) {
        console.log(`📋 [${clientId}] No backup file found`);
        return false;
      }

      console.log(`📦 [${clientId}] Found WhatsApp backup from ${backupFile.uploadDate}`);

      // Create fresh session directory structure
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      fs.mkdirSync(sessionPath, { recursive: true });
      fs.mkdirSync(defaultPath, { recursive: true });

      // Download and extract WhatsApp backup
      const downloadStream = this.gridFS.openDownloadStream(backupFile._id);
      const extract = require('extract-zip');

      const tempZipPath = path.join(process.cwd(), 'temp', `${clientId}_whatsapp_restore.zip`);
      const writeStream = fs.createWriteStream(tempZipPath);

      await new Promise<void>((resolve, reject) => {
        downloadStream.pipe(writeStream);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
      });

      // Extract to temp directory first
      const tempExtractPath = path.join(process.cwd(), 'temp', `${clientId}_extract`);
      await extract(tempZipPath, { dir: tempExtractPath });
      
      // Move files to correct locations
      const extractedFiles = fs.readdirSync(tempExtractPath);
      for (const file of extractedFiles) {
        const sourcePath = path.join(tempExtractPath, file);
        const targetPath = file === 'Local State' 
          ? path.join(sessionPath, file) // Root level
          : path.join(defaultPath, file); // Default level
          
        fs.renameSync(sourcePath, targetPath);
      }

      // Clean up temp files
      fs.rmSync(tempExtractPath, { recursive: true, force: true });
      fs.unlinkSync(tempZipPath);

      // Wait for filesystem to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log(`✅ [${clientId}] WhatsApp session restored from MongoDB`);
      console.log(`📁 [${clientId}] Restored to: ${sessionPath}`);
      
      // Verify WhatsApp data
      const indexedDBPath = path.join(defaultPath, 'IndexedDB');
      if (fs.existsSync(indexedDBPath)) {
        console.log(`📋 [${clientId}] WhatsApp IndexedDB restored`);
      }
      
      return true;

    } catch (error) {
      console.error(`❌ [${clientId}] WhatsApp session restore error:`, error);
      return false;
    }
  }

  /**
   * List available WhatsApp backups
   */
  async listWhatsAppBackups(clientId: string = '*'): Promise<any[]> {
    try {
      let query: any = {};
      
      if (clientId !== '*') {
        query = { 
          filename: `${clientId}_whatsapp_session.zip`,
          'metadata.type': 'whatsapp_specific'
        };
      } else {
        query = { 
          filename: { $regex: /_whatsapp_session\.zip$/ },
          'metadata.type': 'whatsapp_specific'
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
      console.error(`❌ Error listing WhatsApp backups for ${clientId}:`, error);
      return [];
    }
  }

  /**
   * Delete old WhatsApp backups (keep only latest)
   * SAFETY: Always keeps at least 1 backup to prevent total session loss
   */
  async cleanupOldWhatsAppBackups(clientId: string, keepCount: number = 2): Promise<void> {
    try {
      const files = await this.gridFS.find({ 
        filename: `${clientId}_whatsapp_session.zip`,
        'metadata.type': 'whatsapp_specific'
      })
        .sort({ uploadDate: -1 })
        .toArray();

      // SAFETY: Always keep at least 1 backup
      const safeKeepCount = Math.max(keepCount, 1);
      
      if (files.length > safeKeepCount) {
        const toDelete = files.slice(safeKeepCount);
        
        console.log(`🗑️  [${clientId}] Found ${files.length} backups, keeping ${safeKeepCount}, deleting ${toDelete.length}`);
        
        for (const file of toDelete) {
          try {
            await this.gridFS.delete(file._id);
            console.log(`🗑️  [${clientId}] Deleted backup from ${file.uploadDate}`);
          } catch (deleteError) {
            console.error(`❌ Failed to delete backup ${file._id}:`, deleteError);
            // Continue with other deletions even if one fails
          }
        }
        
        console.log(`✅ [${clientId}] Cleanup completed: ${toDelete.length} old backup(s) removed`);
        
        // Suggest GC after cleanup
        suggestGC();
      } else {
        console.log(`📋 [${clientId}] Backup count (${files.length}) within limit (${safeKeepCount}), no cleanup needed`);
      }
    } catch (error) {
      console.error(`❌ Error cleaning up WhatsApp backups for ${clientId}:`, error);
    }
  }
}
