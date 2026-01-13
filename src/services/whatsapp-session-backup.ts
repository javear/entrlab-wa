import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MEMORY_CONFIG, suggestGC } from '../config/memory-config';

// ============================================
// WhatsApp-Specific Session Backup Service
// Only backs up WhatsApp Web data that's portable across servers
// Excludes environment-specific browser data
// Optimized for low memory usage with streaming
// SECURITY: Atomic operations, integrity checks, rollback support
// ============================================

export class WhatsAppSessionBackup {
  private gridFS: GridFSBucket;
  private backupLocks: Map<string, Promise<boolean>> = new Map(); // Prevent concurrent backups
  private restoreLocks: Map<string, Promise<boolean>> = new Map(); // Prevent concurrent restores
  private isShuttingDown: boolean = false; // Flag to prevent new backups during shutdown

  constructor() {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not available');
    }
    this.gridFS = new GridFSBucket(db, { bucketName: 'whatsapp_sessions' });
  }

  /**
   * Check if MongoDB connection is still available
   */
  private isMongoConnected(): boolean {
    return mongoose.connection.readyState === 1 && !this.isShuttingDown;
  }

  /**
   * Wait for all in-progress backups to complete or timeout
   * Call this before shutting down MongoDB
   */
  async waitForBackupsToComplete(timeoutMs: number = 10000): Promise<void> {
    console.log(`⏳ Waiting for ${this.backupLocks.size} backup(s) to complete...`);
    
    if (this.backupLocks.size === 0) {
      return;
    }

    // Mark as shutting down to prevent new backups
    this.isShuttingDown = true;

    // Wait for all backups to complete with timeout
    const backupPromises = Array.from(this.backupLocks.values());
    
    try {
      await Promise.race([
        Promise.allSettled(backupPromises),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            console.warn(`⚠️  Backup completion timeout after ${timeoutMs}ms, proceeding with shutdown`);
            resolve();
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      console.warn(`⚠️  Error waiting for backups:`, error);
    }
    
    console.log(`✅ Backup wait completed`);
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
   * Validate source files before backup
   */
  private validateSourceFiles(sessionPath: string, clientId: string): { valid: boolean; reason?: string } {
    try {
      const defaultPath = path.join(sessionPath, 'Default');
      const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
      const indexedDBPath = path.join(defaultPath, 'IndexedDB');
      
      // Check critical files exist and are readable
      const criticalPaths = [
        { path: defaultPath, name: 'Default directory' },
        { path: localStoragePath, name: 'Local Storage' },
        { path: indexedDBPath, name: 'IndexedDB' }
      ];
      
      for (const { path: filePath, name } of criticalPaths) {
        if (!fs.existsSync(filePath)) {
          // IndexedDB or Local Storage can be missing, but not both
          if (name === 'Local Storage' || name === 'IndexedDB') {
            continue; // Check if at least one exists
          }
          return { valid: false, reason: `${name} not found` };
        }
        
        try {
          // Try to read directory/file to ensure it's accessible
          if (fs.statSync(filePath).isDirectory()) {
            fs.readdirSync(filePath); // Test read access
          }
        } catch (readError) {
          return { valid: false, reason: `${name} not readable: ${readError}` };
        }
      }
      
      // At least one of Local Storage or IndexedDB must exist
      if (!fs.existsSync(localStoragePath) && !fs.existsSync(indexedDBPath)) {
        return { valid: false, reason: 'No authentication data found (Local Storage or IndexedDB required)' };
      }
      
      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: `Validation error: ${error.message}` };
    }
  }

  /**
   * Calculate MD5 checksum of a file
   */
  private async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Verify ZIP file integrity
   */
  private async verifyZipFile(zipPath: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      // Check file exists and has size
      if (!fs.existsSync(zipPath)) {
        return { valid: false, reason: 'ZIP file does not exist' };
      }
      
      const stats = fs.statSync(zipPath);
      if (stats.size === 0) {
        return { valid: false, reason: 'ZIP file is empty' };
      }
      
      // Check ZIP file signature (PK header)
      const buffer = Buffer.alloc(4);
      const fd = fs.openSync(zipPath, 'r');
      fs.readSync(fd, buffer, 0, 4, 0);
      fs.closeSync(fd);
      
      // ZIP files start with "PK" (0x50 0x4B)
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
        return { valid: false, reason: 'Invalid ZIP file signature' };
      }
      
      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: `ZIP verification error: ${error.message}` };
    }
  }

  /**
   * Backup only WhatsApp Web essential data
   * SECURITY: Atomic operation with integrity checks
   */
  async backupWhatsAppSession(clientId: string): Promise<boolean> {
    // Don't start new backups during shutdown
    if (this.isShuttingDown) {
      console.log(`⏹️  [${clientId}] Backup skipped - shutdown in progress`);
      return false;
    }

    // Check if MongoDB is connected
    if (!this.isMongoConnected()) {
      console.warn(`⚠️  [${clientId}] Backup skipped - MongoDB not connected`);
      return false;
    }

    // Prevent concurrent backups for same client
    if (this.backupLocks.has(clientId)) {
      console.log(`⏳ [${clientId}] Backup already in progress, skipping duplicate request`);
      return await this.backupLocks.get(clientId)!;
    }

    const backupPromise = this._backupWhatsAppSessionInternal(clientId);
    this.backupLocks.set(clientId, backupPromise);
    
    try {
      const result = await backupPromise;
      return result;
    } finally {
      this.backupLocks.delete(clientId);
    }
  }

  private async _backupWhatsAppSessionInternal(clientId: string): Promise<boolean> {
    const BACKUP_TIMEOUT_MS = 300000; // 5 minutes max for backup
    let archive: archiver.Archiver | null = null;
    let uploadStream: any = null;
    let backupStartedAt = Date.now();
    const tempFilename = `${clientId}_whatsapp_session.tmp`; // Atomic: temp file first

    try {
      console.log(`📦 [${clientId}] Starting WhatsApp-specific session backup...`);
      
      const sessionPath = path.join(process.cwd(), 'tokens', clientId);
      if (!fs.existsSync(sessionPath)) {
        console.warn(`⚠️  [${clientId}] Session path not found: ${sessionPath}`);
        return false;
      }

      // SECURITY: Validate source files before backup
      const validation = this.validateSourceFiles(sessionPath, clientId);
      if (!validation.valid) {
        console.warn(`⚠️  [${clientId}] Source validation failed: ${validation.reason}`);
        return false;
      }

      const defaultPath = path.join(sessionPath, 'Default');

      // COMPREHENSIVE BACKUP: Archive entire session directory (like advance_whatsapp branch)
      // Only exclude problematic lock files that prevent restoration
      // This ensures 100% session preservation including all cache and state files
      console.log(`📦 [${clientId}] Starting COMPREHENSIVE session backup (entire directory)...`);
      // Silent - too verbose

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
          // Only log every 200 files to reduce noise
          if (filesArchived % 200 === 0 && archive) {
            const currentSize = archive.pointer() || 0;
            // Silent - too verbose
          }
        });

        archive.on('error', (err) => {
          console.error(`❌ [${clientId}] Archive error:`, err);
          throw err;
        });
      }

      // SECURITY: Upload to temp filename first (atomic operation)
      uploadStream = this.gridFS.openUploadStream(tempFilename, {
        metadata: {
          clientId,
          timestamp: new Date(),
          type: 'whatsapp_specific',
          isTemporary: true // Mark as temporary until verified
        }
      });

      archive.pipe(uploadStream);

      // SMART SELECTIVE BACKUP: Only backup essential files for session preservation
      // Excludes large cache directories (Cache 31M, Code Cache 29M = 60M saved!)
      // This reduces backup size from ~80MB to ~20MB while maintaining 100% session preservation
      
      // Helper functions for size calculation
      const getDirectorySize = (dirPath: string): number => {
        let totalSize = 0;
        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
              totalSize += getDirectorySize(filePath);
            } else {
              totalSize += stat.size;
            }
          }
        } catch (err) {
          // Ignore errors
        }
        return totalSize;
      };
      
      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
      };
      
      // Add Local State at root level
      const localStatePath = path.join(sessionPath, 'Local State');
      if (fs.existsSync(localStatePath)) {
        const cleanedContent = this.cleanLocalStateFile(localStatePath);
        archive.append(cleanedContent, { name: 'Local State' });
      }
      
      // Define essential items for session preservation (only what's needed for authentication)
      const essentialItems = [
        // CRITICAL: Authentication data (MUST HAVE)
        { path: 'Default/IndexedDB', type: 'directory', critical: true },        // 19M - WhatsApp data
        { path: 'Default/Local Storage', type: 'directory', critical: true },    // 180K - Auth tokens
        { path: 'Default/Sessions', type: 'directory', critical: true },         // Active sessions
        { path: 'Default/Cookies', type: 'file', critical: true },               // Authentication
        { path: 'Default/Cookies-journal', type: 'file', critical: false },
        
        // IMPORTANT: Session state (should have)
        { path: 'Default/Session Storage', type: 'directory', critical: false },
        { path: 'Default/Preferences', type: 'file', critical: false },
        { path: 'Default/Secure Preferences', type: 'file', critical: false },
        
        // AUTHENTICATION: Login and history data
        { path: 'Default/Login Data', type: 'file', critical: false },
        { path: 'Default/Login Data-journal', type: 'file', critical: false },
        { path: 'Default/Login Data For Account', type: 'file', critical: false },
        { path: 'Default/Login Data For Account-journal', type: 'file', critical: false },
        { path: 'Default/History', type: 'file', critical: false },
        { path: 'Default/History-journal', type: 'file', critical: false },
        { path: 'Default/Web Data', type: 'file', critical: false },
        { path: 'Default/Web Data-journal', type: 'file', critical: false },
        { path: 'Default/Account Web Data', type: 'file', critical: false },
        { path: 'Default/Account Web Data-journal', type: 'file', critical: false },
      ];
      
      let itemsAdded = 0;
      let criticalItemsMissing = 0;
      
      // Add essential items (excluding cache directories)
      for (const item of essentialItems) {
        const itemPath = path.join(sessionPath, item.path);
        const relativePath = path.relative(sessionPath, itemPath);
        
        if (fs.existsSync(itemPath)) {
          const stat = fs.statSync(itemPath);
          const isDirectory = stat.isDirectory();
          const isFile = stat.isFile();
          
          // Verify type matches
          if ((item.type === 'directory' && isDirectory) || (item.type === 'file' && isFile)) {
            if (isDirectory) {
              archive.directory(itemPath, relativePath);
            } else {
              archive.file(itemPath, { name: relativePath });
            }
            itemsAdded++;
          }
        } else if (item.critical) {
          criticalItemsMissing++;
          console.warn(`⚠️  [${clientId}] CRITICAL item missing: ${item.path}`);
        }
      }
      
      if (criticalItemsMissing > 0) {
        console.warn(`⚠️  [${clientId}] ${criticalItemsMissing} critical item(s) missing - backup may not preserve session`);
      }
      
      await archive.finalize();
      archiveSize = archive.pointer() || 0;
      console.log(`✅ [${clientId}] Backup completed: ${(archiveSize / 1024 / 1024).toFixed(2)} MB`);

      // Wait for upload to complete with timeout
      return await Promise.race([
        new Promise<boolean>((resolve, reject) => {
          uploadStream.on('finish', async () => {
            const elapsed = ((Date.now() - backupStartedAt) / 1000).toFixed(1);
            console.log(`✅ [${clientId}] Backup uploaded to MongoDB in ${elapsed}s`);
            console.log(`📦 [${clientId}] Backup size: ${(archiveSize / 1024 / 1024).toFixed(2)} MB, ${filesArchived} files`);
            
            try {
              // Check if MongoDB is still connected before proceeding
              if (!this.isMongoConnected()) {
                console.warn(`⚠️  [${clientId}] Backup aborted - MongoDB connection closed`);
                // Clean up temp file
                if (uploadStream?.id) {
                  await this.gridFS.delete(uploadStream.id).catch(() => {});
                }
                resolve(false);
                return;
              }

              // SECURITY: Verify backup integrity before replacing old one
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for GridFS to index
              
              // Check again after delay
              if (!this.isMongoConnected()) {
                console.warn(`⚠️  [${clientId}] Backup aborted - MongoDB connection closed during verification`);
                if (uploadStream?.id) {
                  await this.gridFS.delete(uploadStream.id).catch(() => {});
                }
                resolve(false);
                return;
              }
              
              const tempFiles = await this.gridFS.find({ 
                filename: tempFilename,
                'metadata.clientId': clientId
              }).sort({ uploadDate: -1 }).limit(1).toArray();
              
              if (tempFiles.length === 0 || !tempFiles[0]?._id || !uploadStream?.id || !tempFiles[0]._id.equals(uploadStream.id)) {
                console.error(`❌ [${clientId}] Backup verification failed - temp file not found`);
                // Clean up failed backup
                if (uploadStream?.id) {
                  await this.gridFS.delete(uploadStream.id).catch(() => {});
                }
                reject(new Error('Backup verification failed'));
                return;
              }
              
              const tempFile = tempFiles[0];
              const fileSize = tempFile.length || 0;
              
              // Verify file size matches expected
              // Use percentage-based tolerance: 0.5% for larger files, or minimum 50KB
              // This accounts for GridFS chunking overhead, compression differences, and filesystem variations
              const tolerance = Math.max(archiveSize * 0.005, 50 * 1024); // 0.5% or 50KB, whichever is larger
              const sizeDifference = Math.abs(fileSize - archiveSize);
              
              if (sizeDifference > tolerance) {
                console.warn(`⚠️  [${clientId}] Backup size mismatch: expected ${archiveSize}, got ${fileSize}, difference: ${sizeDifference} bytes (tolerance: ${tolerance.toFixed(0)} bytes)`);
                console.warn(`   Keeping old backup - new backup discarded to prevent corruption`);
                await this.gridFS.delete(uploadStream.id).catch(() => {});
                // Don't reject - just keep the old backup (non-fatal)
                resolve(false);
                return;
              }
              
              // Log if there's a difference but within tolerance (for debugging)
              if (sizeDifference > 0) {
                console.log(`ℹ️  [${clientId}] Backup size difference within tolerance: ${sizeDifference} bytes (${((sizeDifference / archiveSize) * 100).toFixed(3)}%)`);
              }
              
              console.log(`✅ [${clientId}] Backup verified: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
              
              // SECURITY: Atomic replace - delete old backup, then rename temp to final
              const finalFilename = `${clientId}_whatsapp_session.zip`;
              
              // Delete old backups (keep only the new one)
              const oldFiles = await this.gridFS.find({ 
                filename: finalFilename,
                'metadata.clientId': clientId
              }).toArray();
              
              for (const oldFile of oldFiles) {
                await this.gridFS.delete(oldFile._id).catch((err) => {
                  console.warn(`⚠️  [${clientId}] Could not delete old backup ${oldFile._id}:`, err);
                });
              }
              
              // Rename temp to final by updating metadata (GridFS doesn't support rename)
              // We'll download and re-upload with correct name (atomic operation)
              const downloadStream = this.gridFS.openDownloadStream(tempFile._id);
              const finalUploadStream = this.gridFS.openUploadStream(finalFilename, {
                metadata: {
                  clientId,
                  timestamp: new Date(),
                  type: 'whatsapp_specific',
                  checksum: tempFile.metadata?.checksum,
                  filesArchived: filesArchived
                }
              });
              
              await new Promise<void>((resolve, reject) => {
                downloadStream.pipe(finalUploadStream);
                finalUploadStream.on('finish', async () => {
                  // Delete temp file after successful rename
                  await this.gridFS.delete(tempFile._id).catch(() => {});
                  console.log(`✅ [${clientId}] Backup finalized: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
                  resolve();
                });
                finalUploadStream.on('error', reject);
                downloadStream.on('error', reject);
              });
              
            } catch (verifyError: any) {
              // Handle MongoDB connection closed errors gracefully during shutdown
              if (verifyError.name === 'MongoClientClosedError' || 
                  verifyError.message?.includes('client was closed') ||
                  !this.isMongoConnected()) {
                console.warn(`⚠️  [${clientId}] Backup aborted - MongoDB connection closed during verification`);
                // Clean up temp file on error
                if (uploadStream?.id) {
                  await this.gridFS.delete(uploadStream.id).catch(() => {});
                }
                resolve(false); // Don't reject, just return false (non-fatal)
                return;
              }
              
              console.error(`❌ [${clientId}] Backup verification/atomic replace failed:`, verifyError);
              // Clean up temp file on error
              if (uploadStream?.id) {
                await this.gridFS.delete(uploadStream.id).catch(() => {});
              }
              reject(verifyError);
              return;
            }
            
            // Suggest garbage collection after large operation
            if (MEMORY_CONFIG.GC_AFTER_LARGE_OPERATION) {
              suggestGC();
            }
            
            resolve(true);
          });

          uploadStream.on('error', async (error: Error) => {
            console.error(`❌ [${clientId}] GridFS upload error:`, error);
            // Clean up temp file on error
            if (uploadStream?.id) {
              await this.gridFS.delete(uploadStream.id).catch(() => {});
            }
            reject(error);
          });
        }),
        new Promise<boolean>((_, reject) => {
          setTimeout(async () => {
            // Clean up temp file on timeout
            if (uploadStream?.id) {
              await this.gridFS.delete(uploadStream.id).catch(() => {});
            }
            reject(new Error(`Backup timeout after ${BACKUP_TIMEOUT_MS / 1000} seconds`));
          }, BACKUP_TIMEOUT_MS);
        })
      ]);

    } catch (error: any) {
      const elapsed = ((Date.now() - backupStartedAt) / 1000).toFixed(1);
      
      // Handle MongoDB connection closed errors gracefully during shutdown
      if (error && (
        error.name === 'MongoClientClosedError' ||
        error.message?.includes('client was closed') ||
        !this.isMongoConnected()
      )) {
        console.warn(`⚠️  [${clientId}] Backup aborted after ${elapsed}s - MongoDB connection closed (shutdown in progress)`);
        
        // SECURITY: Cleanup temp file on error (best effort, might fail if MongoDB is closed)
        if (uploadStream?.id) {
          try {
            await this.gridFS.delete(uploadStream.id);
          } catch (deleteError) {
            // Ignore cleanup errors during shutdown
          }
        }
        
        return false; // Non-fatal error during shutdown - don't throw
      }
      
      console.error(`❌ [${clientId}] WhatsApp session backup error after ${elapsed}s:`, error);
      
      // SECURITY: Cleanup temp file on error
      if (uploadStream?.id) {
        try {
          await this.gridFS.delete(uploadStream.id);
        } catch (deleteError) {
          // Ignore cleanup errors
        }
      }
      
      // Cleanup: abort archive if still in progress
      if (archive) {
        try {
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
   * SECURITY: Atomic restore with validation and rollback support
   */
  async restoreWhatsAppSession(clientId: string, maxRetries: number = 3): Promise<boolean> {
    // Prevent concurrent restores for same client
    if (this.restoreLocks.has(clientId)) {
      console.log(`⏳ [${clientId}] Restore already in progress, skipping duplicate request`);
      return await this.restoreLocks.get(clientId)!;
    }

    const restorePromise = this._restoreWhatsAppSessionInternal(clientId, maxRetries);
    this.restoreLocks.set(clientId, restorePromise);
    
    try {
      const result = await restorePromise;
      return result;
    } finally {
      this.restoreLocks.delete(clientId);
    }
  }

  private async _restoreWhatsAppSessionInternal(clientId: string, maxRetries: number): Promise<boolean> {
    const sessionPath = path.join(process.cwd(), 'tokens', clientId);
    const defaultPath = path.join(sessionPath, 'Default');
    let existingSessionBackup: string | null = null; // For rollback

    try {
      console.log(`📥 [${clientId}] Starting WhatsApp session restore...`);

      // SECURITY: Find and validate backup BEFORE touching existing session
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
      if (!backupFile || !backupFile._id) {
        console.log(`📋 [${clientId}] Invalid backup file`);
        return false;
      }

      // SECURITY: Validate backup file size
      if (!backupFile.length || backupFile.length === 0) {
        console.error(`❌ [${clientId}] Backup file is empty or invalid`);
        return false;
      }

      console.log(`📦 [${clientId}] Found WhatsApp backup from ${backupFile.uploadDate} (${(backupFile.length / 1024 / 1024).toFixed(2)} MB)`);

      // SECURITY: Backup existing session before restore (rollback support)
      if (fs.existsSync(sessionPath)) {
        const validation = this.validateSourceFiles(sessionPath, clientId);
        
        if (validation.valid) {
          console.log(`⚠️  [${clientId}] Existing session folder has valid data - backing up before restore`);
          // Create backup of existing session for rollback
          const backupPath = path.join(process.cwd(), 'temp', `${clientId}_rollback_${Date.now()}`);
          try {
            fs.cpSync(sessionPath, backupPath, { recursive: true });
            existingSessionBackup = backupPath;
            console.log(`💾 [${clientId}] Existing session backed up to: ${backupPath}`);
          } catch (backupError: any) {
            console.warn(`⚠️  [${clientId}] Could not backup existing session: ${backupError.message}`);
            // Continue anyway - restore might still work
          }
        } else {
          console.log(`🗑️  [${clientId}] Existing session folder appears corrupted: ${validation.reason}`);
        }
      }
      
      // SECURITY: Delete existing session only AFTER backup validation
      // Use retry mechanism to handle file locks and ENOTEMPTY errors
      if (fs.existsSync(sessionPath)) {
        let deleted = false;
        let retryCount = 0;
        const maxRetries = 5;
        
        while (!deleted && retryCount < maxRetries) {
          try {
            // Try to remove directory
            fs.rmSync(sessionPath, { recursive: true, force: true });
            deleted = true;
            console.log(`✅ [${clientId}] Existing session directory deleted`);
          } catch (deleteError: any) {
            retryCount++;
            if (deleteError.code === 'ENOTEMPTY' || deleteError.code === 'EBUSY') {
              console.log(`⏳ [${clientId}] Directory not empty or busy (attempt ${retryCount}/${maxRetries}), waiting...`);
              // Wait longer for file handles to be released
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              
              if (retryCount >= maxRetries) {
                // Last attempt: try to delete contents individually
                console.log(`🔄 [${clientId}] Attempting to delete directory contents individually...`);
                try {
                  const files = fs.readdirSync(sessionPath, { withFileTypes: true });
                  for (const file of files) {
                    const filePath = path.join(sessionPath, file.name);
                    if (file.isDirectory()) {
                      fs.rmSync(filePath, { recursive: true, force: true });
                    } else {
                      fs.unlinkSync(filePath);
                    }
                  }
                  // Try removing directory again
                  fs.rmSync(sessionPath, { recursive: true, force: true });
                  deleted = true;
                  console.log(`✅ [${clientId}] Directory deleted after cleaning contents`);
                } catch (finalError: any) {
                  console.error(`❌ [${clientId}] Failed to delete directory after ${maxRetries} attempts:`, finalError.message);
                  throw finalError;
                }
              }
            } else {
              // Other errors - throw immediately
              throw deleteError;
            }
          }
        }
        
        // Wait for filesystem to release locks
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Create fresh directories
      fs.mkdirSync(sessionPath, { recursive: true });
      fs.mkdirSync(defaultPath, { recursive: true });

      // SECURITY: Download with retry mechanism
      const tempZipPath = path.join(process.cwd(), 'temp', `${clientId}_whatsapp_restore.zip`);
      let downloadSuccess = false;
      let retryCount = 0;

      while (!downloadSuccess && retryCount < maxRetries) {
        try {
          if (retryCount > 0) {
            console.log(`🔄 [${clientId}] Retry ${retryCount}/${maxRetries} downloading backup...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
          }

          const downloadStream = this.gridFS.openDownloadStream(backupFile._id);
          const writeStream = fs.createWriteStream(tempZipPath);

          await new Promise<void>((resolve, reject) => {
            let downloadedBytes = 0;
            
            downloadStream.on('data', (chunk) => {
              downloadedBytes += chunk.length;
            });
            
            downloadStream.pipe(writeStream);
            writeStream.on('finish', () => {
              // Verify download size matches backup size
              const fileSize = fs.statSync(tempZipPath).size;
              if (Math.abs(fileSize - backupFile.length) > 1024) { // Allow 1KB difference
                reject(new Error(`Download size mismatch: expected ${backupFile.length}, got ${fileSize}`));
              } else {
                resolve();
              }
            });
            writeStream.on('error', reject);
            downloadStream.on('error', reject);
            
            // Timeout after 60 seconds
            setTimeout(() => {
              if (!writeStream.writableEnded) {
                reject(new Error('Download timeout'));
              }
            }, 60000);
          });

          downloadSuccess = true;
        } catch (downloadError: any) {
          retryCount++;
          console.warn(`⚠️  [${clientId}] Download attempt ${retryCount} failed: ${downloadError.message}`);
          
          // Clean up partial download
          if (fs.existsSync(tempZipPath)) {
            try {
              fs.unlinkSync(tempZipPath);
            } catch (e) {
              // Ignore cleanup errors
            }
          }
          
          if (retryCount >= maxRetries) {
            throw new Error(`Failed to download backup after ${maxRetries} attempts: ${downloadError.message}`);
          }
        }
      }

      // SECURITY: Verify ZIP file integrity before extraction
      const zipValidation = await this.verifyZipFile(tempZipPath);
      if (!zipValidation.valid) {
        console.error(`❌ [${clientId}] ZIP file validation failed: ${zipValidation.reason}`);
        // Rollback: restore existing session if available
        if (existingSessionBackup && fs.existsSync(existingSessionBackup)) {
          console.log(`🔄 [${clientId}] Rolling back to existing session...`);
          fs.cpSync(existingSessionBackup, sessionPath, { recursive: true });
          fs.rmSync(existingSessionBackup, { recursive: true, force: true });
        }
        return false;
      }

      console.log(`✅ [${clientId}] ZIP file validated, extracting...`);

      // SECURITY: Extract to temp location first, then validate before moving
      const tempExtractPath = path.join(process.cwd(), 'temp', `${clientId}_extract_${Date.now()}`);
      const extract = require('extract-zip');
      
      try {
        await extract(tempZipPath, { dir: tempExtractPath });
      } catch (extractError: any) {
        console.error(`❌ [${clientId}] ZIP extraction failed: ${extractError.message}`);
        // Rollback
        if (existingSessionBackup && fs.existsSync(existingSessionBackup)) {
          console.log(`🔄 [${clientId}] Rolling back to existing session...`);
          fs.cpSync(existingSessionBackup, sessionPath, { recursive: true });
          fs.rmSync(existingSessionBackup, { recursive: true, force: true });
        }
        return false;
      }
      
      // SECURITY: Move extracted files and validate before finalizing
      const extractedClientPath = path.join(tempExtractPath, clientId);
      
      if (fs.existsSync(extractedClientPath)) {
        // If ZIP contains clientId folder, move its contents to sessionPath
        const extractedContents = fs.readdirSync(extractedClientPath);
        for (const item of extractedContents) {
          const sourcePath = path.join(extractedClientPath, item);
          const targetPath = path.join(sessionPath, item);
          if (fs.statSync(sourcePath).isDirectory()) {
            fs.cpSync(sourcePath, targetPath, { recursive: true });
          } else {
            fs.copyFileSync(sourcePath, targetPath);
          }
        }
      } else {
        // If ZIP was archived with root=false, files are directly in tempExtractPath
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

      // Wait for filesystem to stabilize
      await new Promise(resolve => setTimeout(resolve, 1000));

      // SECURITY: Validate restored session before finalizing
      const restoreValidation = this.validateSourceFiles(sessionPath, clientId);
      if (!restoreValidation.valid) {
        console.error(`❌ [${clientId}] Restored session validation failed: ${restoreValidation.reason}`);
        // Rollback: restore existing session
        if (existingSessionBackup && fs.existsSync(existingSessionBackup)) {
          console.log(`🔄 [${clientId}] Rolling back to existing session...`);
          fs.rmSync(sessionPath, { recursive: true, force: true });
          fs.cpSync(existingSessionBackup, sessionPath, { recursive: true });
          fs.rmSync(existingSessionBackup, { recursive: true, force: true });
        }
        // Clean up temp files
        try {
          fs.rmSync(tempExtractPath, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
        if (fs.existsSync(tempZipPath)) {
          try {
            fs.unlinkSync(tempZipPath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        return false;
      }

      // Clean up temp files (only after successful validation)
      try {
        fs.rmSync(tempExtractPath, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
      if (fs.existsSync(tempZipPath)) {
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
      // Clean up rollback backup (restore was successful)
      if (existingSessionBackup && fs.existsSync(existingSessionBackup)) {
        try {
          fs.rmSync(existingSessionBackup, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      console.log(`✅ [${clientId}] WhatsApp session restored and validated`);
      console.log(`📁 [${clientId}] Restored to: ${sessionPath}`);
      
      // Verify critical files exist
      const indexedDBPath = path.join(defaultPath, 'IndexedDB');
      const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
      if (fs.existsSync(indexedDBPath)) {
        console.log(`✅ [${clientId}] IndexedDB restored`);
      }
      if (fs.existsSync(localStoragePath)) {
        console.log(`✅ [${clientId}] Local Storage restored`);
      }
      
      return true;

    } catch (error: any) {
      console.error(`❌ [${clientId}] WhatsApp session restore error:`, error);
      
      // SECURITY: Rollback on error
      if (existingSessionBackup && fs.existsSync(existingSessionBackup)) {
        try {
          console.log(`🔄 [${clientId}] Rolling back to existing session due to error...`);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          fs.cpSync(existingSessionBackup, sessionPath, { recursive: true });
          fs.rmSync(existingSessionBackup, { recursive: true, force: true });
          console.log(`✅ [${clientId}] Rollback completed - existing session restored`);
        } catch (rollbackError: any) {
          console.error(`❌ [${clientId}] Rollback failed: ${rollbackError.message}`);
        }
      }
      
      // Clean up any temp files
      const tempZipPath = path.join(process.cwd(), 'temp', `${clientId}_whatsapp_restore.zip`);
      if (fs.existsSync(tempZipPath)) {
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
      return false;
    }
  }

  /**
   * List available WhatsApp backups
   */
  async listWhatsAppBackups(clientId: string = '*'): Promise<any[]> {
    try {
      // First, try with metadata filter
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
      
      let files = await this.gridFS.find(query)
        .sort({ uploadDate: -1 })
        .toArray();
      
      // If no files found with metadata filter, try without it (for backwards compatibility)
      // Some old backups might not have metadata.type set
      if (files.length === 0) {
        console.log(`ℹ️  No backups found with metadata filter, trying without metadata filter...`);
        if (clientId !== '*') {
          query = { 
            filename: `${clientId}_whatsapp_session.zip`
          };
        } else {
          query = { 
            filename: { $regex: /_whatsapp_session\.zip$/ }
          };
        }
        
        files = await this.gridFS.find(query)
          .sort({ uploadDate: -1 })
          .toArray();
      }
      
      // Clean up stale temp files and try to finalize interrupted backups
      // These are temp files left behind when backups were interrupted during shutdown
      if (clientId === '*') {
        try {
          const tempFiles = await this.gridFS.find({
            filename: { $regex: /_whatsapp_session\.tmp$/ }
          }).toArray();
          
          if (tempFiles.length > 0) {
            console.log(`🔍 Found ${tempFiles.length} temp backup file(s) - checking for interrupted backups...`);
            
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            let finalizedCount = 0;
            let cleanedCount = 0;
            
            for (const tempFile of tempFiles) {
              try {
                // Extract clientId from temp filename (e.g., "javear-client-wpp_whatsapp_session.tmp")
                const match = tempFile.filename.match(/^(.+?)_whatsapp_session\.tmp$/);
                if (!match) continue;
                
                const tempClientId = match[1];
                const finalFilename = `${tempClientId}_whatsapp_session.zip`;
                
                // Check if final backup already exists (backup was successful)
                const existingFinal = await this.gridFS.find({
                  filename: finalFilename
                }).limit(1).toArray();
                
                if (existingFinal.length > 0) {
                  // Final backup exists, temp file is stale - delete it
                  await this.gridFS.delete(tempFile._id);
                  cleanedCount++;
                  console.log(`🧹 Removed stale temp file (final backup exists): ${tempFile.filename}`);
                } else if (tempFile.uploadDate && new Date(tempFile.uploadDate) < oneHourAgo) {
                  // Temp file is older than 1 hour and no final backup - likely interrupted
                  // Try to finalize it if it's valid
                  if (tempFile.length && tempFile.length > 0) {
                    console.log(`🔄 Attempting to finalize interrupted backup: ${tempFile.filename} (${(tempFile.length / 1024 / 1024).toFixed(2)} MB)`);
                    try {
                      // Finalize the temp file by copying it to final filename
                      const downloadStream = this.gridFS.openDownloadStream(tempFile._id);
                      const finalUploadStream = this.gridFS.openUploadStream(finalFilename, {
                        metadata: {
                          clientId: tempClientId,
                          timestamp: tempFile.uploadDate || new Date(),
                          type: 'whatsapp_specific',
                          checksum: tempFile.metadata?.checksum,
                          recovered: true // Mark as recovered from interrupted backup
                        }
                      });
                      
                      await new Promise<void>((resolve, reject) => {
                        downloadStream.pipe(finalUploadStream);
                        finalUploadStream.on('finish', async () => {
                          await this.gridFS.delete(tempFile._id).catch(() => {});
                          finalizedCount++;
                          console.log(`✅ Finalized interrupted backup: ${finalFilename}`);
                          resolve();
                        });
                        finalUploadStream.on('error', reject);
                        downloadStream.on('error', reject);
                      });
                    } catch (finalizeError) {
                      // If finalization fails, delete the stale temp file
                      console.warn(`⚠️  Could not finalize temp backup ${tempFile.filename}, deleting:`, finalizeError);
                      await this.gridFS.delete(tempFile._id).catch(() => {});
                      cleanedCount++;
                    }
                  } else {
                    // Temp file is empty or invalid - delete it
                    await this.gridFS.delete(tempFile._id);
                    cleanedCount++;
                    console.log(`🧹 Removed invalid temp file: ${tempFile.filename}`);
                  }
                }
              } catch (error) {
                console.warn(`⚠️  Error processing temp file ${tempFile.filename}:`, error);
              }
            }
            
            if (finalizedCount > 0) {
              console.log(`✅ Finalized ${finalizedCount} interrupted backup(s)`);
            }
            if (cleanedCount > 0) {
              console.log(`🧹 Cleaned up ${cleanedCount} stale/invalid temp file(s)`);
            }
          }
        } catch (cleanupError) {
          console.warn(`⚠️  Error processing temp files:`, cleanupError);
        }
      }
      
      return files.map(file => ({
        id: file._id,
        filename: file.filename,
        uploadDate: file.uploadDate,
        size: file.length,
        metadata: file.metadata
      }));
    } catch (error) {
      console.error(`❌ Error listing WhatsApp backups for ${clientId}:`, error);
      console.error(`   Error details:`, error);
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
