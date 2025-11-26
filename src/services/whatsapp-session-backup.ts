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
    const BACKUP_TIMEOUT_MS = 300000; // 5 minutes max for backup
    let archive: archiver.Archiver | null = null;
    let uploadStream: any = null;
    let backupStartedAt = Date.now();

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

      // Check if session appears to be authenticated before backing up
      const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
      const indexedDBPath = path.join(defaultPath, 'IndexedDB');
      
      if (!fs.existsSync(localStoragePath) && !fs.existsSync(indexedDBPath)) {
        console.warn(`⚠️  [${clientId}] Session folder exists but appears empty/unauthenticated - skipping backup`);
        return false;
      }

      // COMPREHENSIVE BACKUP: Archive entire session directory (like advance_whatsapp branch)
      // Only exclude problematic lock files that prevent restoration
      // This ensures 100% session preservation including all cache and state files
      console.log(`📦 [${clientId}] Starting COMPREHENSIVE session backup (entire directory)...`);
      console.log(`📁 [${clientId}] Backing up from: ${sessionPath}`);

      // Create archive with entire session - balanced compression
      archive = archiver('zip', { 
        zlib: { level: MEMORY_CONFIG.BACKUP_COMPRESSION_LEVEL }, // Balanced compression
        highWaterMark: MEMORY_CONFIG.BACKUP_CHUNK_SIZE // Control memory usage
      });

      // Track archive progress
      let filesArchived = 0;
      let archiveSize = 0;
      if (archive) {
        archive.on('entry', (entry) => {
          filesArchived++;
          if (filesArchived % 100 === 0 && archive) {
            const currentSize = archive.pointer() || 0;
            console.log(`📦 [${clientId}] Archiving... ${filesArchived} files processed, ${(currentSize / 1024 / 1024).toFixed(2)} MB`);
          }
        });

        archive.on('error', (err) => {
          console.error(`❌ [${clientId}] Archive error:`, err);
          throw err;
        });
      }

      uploadStream = this.gridFS.openUploadStream(`${clientId}_whatsapp_session.zip`, {
        metadata: {
          clientId,
          timestamp: new Date(),
          type: 'whatsapp_specific'
        }
      });

      archive.pipe(uploadStream);

      // Archive ENTIRE session directory, excluding ONLY problematic lock files
      // This matches advance_whatsapp branch approach for complete session preservation
      archive.directory(sessionPath, false, (entry) => {
        // Only exclude files that are guaranteed to cause issues during restoration
        const problematicFiles = [
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
        
        // Exclude only problematic lock files, include EVERYTHING else (cache, Service Worker, etc.)
        const entryName = entry.name || entry.prefix || '';
        if (problematicFiles.some(problem => entryName.includes(problem))) {
          return false;
        }
        return entry;
      });

      console.log(`📦 [${clientId}] Finalizing archive...`);
      await archive.finalize();
      archiveSize = archive.pointer() || 0;
      console.log(`📦 [${clientId}] Archive finalized: ${filesArchived} files, ${(archiveSize / 1024 / 1024).toFixed(2)} MB`);

      // Wait for upload to complete with timeout
      return await Promise.race([
        new Promise<boolean>((resolve, reject) => {
          uploadStream.on('finish', async () => {
            const elapsed = ((Date.now() - backupStartedAt) / 1000).toFixed(1);
            console.log(`✅ [${clientId}] WhatsApp session backed up to MongoDB in ${elapsed}s`);
            console.log(`📦 [${clientId}] Backup size: ${(archiveSize / 1024 / 1024).toFixed(2)} MB, ${filesArchived} files`);
            console.log(`📦 [${clientId}] GridFS file ID: ${uploadStream.id}`);
            
            // Verify backup was actually saved
            try {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for GridFS to index
              const verifyFiles = await this.gridFS.find({ 
                filename: `${clientId}_whatsapp_session.zip`,
                'metadata.clientId': clientId
              }).sort({ uploadDate: -1 }).limit(1).toArray();
              
              if (verifyFiles.length > 0 && verifyFiles[0]?._id && uploadStream?.id && verifyFiles[0]._id.equals(uploadStream.id)) {
                const fileSize = verifyFiles[0].length || 0;
                console.log(`✅ [${clientId}] Backup verified in MongoDB (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
              } else {
                console.warn(`⚠️  [${clientId}] Backup verification: file found but might be different`);
              }
            } catch (verifyError) {
              console.warn(`⚠️  [${clientId}] Could not verify backup:`, verifyError);
            }
            
            // Suggest garbage collection after large operation
            if (MEMORY_CONFIG.GC_AFTER_LARGE_OPERATION) {
              suggestGC();
            }
            
            resolve(true);
          });

          uploadStream.on('error', (error: Error) => {
            console.error(`❌ [${clientId}] GridFS upload error:`, error);
            reject(error);
          });
        }),
        new Promise<boolean>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Backup timeout after ${BACKUP_TIMEOUT_MS / 1000} seconds`));
          }, BACKUP_TIMEOUT_MS);
        })
      ]);

    } catch (error: any) {
      const elapsed = ((Date.now() - backupStartedAt) / 1000).toFixed(1);
      console.error(`❌ [${clientId}] WhatsApp session backup error after ${elapsed}s:`, error);
      
      // Cleanup: abort archive if still in progress
      if (archive) {
        try {
          // Try to abort if archive is still active
          if (typeof (archive as any).abort === 'function') {
            (archive as any).abort();
          }
        } catch (abortError) {
          // Ignore abort errors
        }
      }
      
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

      // Check if existing session folder has valid authentication data
      // Only delete if it's clearly corrupted or unpaired
      let shouldDeleteExisting = false;
      if (fs.existsSync(sessionPath)) {
        const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
        const indexedDBPath = path.join(defaultPath, 'IndexedDB');
        
        // Check if session appears to be valid
        const hasValidData = fs.existsSync(localStoragePath) && fs.existsSync(indexedDBPath);
        
        if (hasValidData) {
          console.log(`⚠️  [${clientId}] Existing session folder found with valid data - preserving it`);
          console.log(`⚠️  [${clientId}] If you want to restore from backup, delete the folder manually first`);
          // Don't restore if valid session exists - it would delete the working session!
          return false;
        } else {
          console.log(`🗑️  [${clientId}] Existing session folder appears corrupted/empty - removing for restore`);
          shouldDeleteExisting = true;
        }
      }
      
      // Only delete if we determined the existing folder is corrupted
      if (shouldDeleteExisting) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      
      // Create fresh directories
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

      // COMPREHENSIVE RESTORE: Extract entire session directory directly
      // The ZIP contains the full session structure (tokens/{clientId}/...)
      // Extract to a temp location first, then move to final location
      const tempExtractPath = path.join(process.cwd(), 'temp', `${clientId}_extract`);
      
      // Extract ZIP to temp location
      await extract(tempZipPath, { dir: tempExtractPath });
      
      // The extracted files are in tempExtractPath/{clientId}/...
      // Move everything from tempExtractPath/{clientId} to sessionPath
      const extractedClientPath = path.join(tempExtractPath, clientId);
      
      if (fs.existsSync(extractedClientPath)) {
        // If ZIP contains clientId folder, move its contents to sessionPath
        const extractedContents = fs.readdirSync(extractedClientPath);
        for (const item of extractedContents) {
          const sourcePath = path.join(extractedClientPath, item);
          const targetPath = path.join(sessionPath, item);
          if (fs.statSync(sourcePath).isDirectory()) {
            // Use cpSync for directories to preserve structure
            fs.cpSync(sourcePath, targetPath, { recursive: true });
          } else {
            fs.copyFileSync(sourcePath, targetPath);
          }
        }
      } else {
        // If ZIP was archived with root=false, files are directly in tempExtractPath
        // Move all contents from tempExtractPath to sessionPath
        const extractedContents = fs.readdirSync(tempExtractPath);
        for (const item of extractedContents) {
          const sourcePath = path.join(tempExtractPath, item);
          const targetPath = path.join(sessionPath, item);
          if (fs.statSync(sourcePath).isDirectory()) {
            fs.cpSync(sourcePath, targetPath, { recursive: true });
          } else {
            fs.copyFileSync(sourcePath, targetPath);
          }
        }
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
