import mongoose, { Document, Schema } from 'mongoose';
import { SessionToken } from '@wppconnect-team/wppconnect/dist/token-store/types';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Readable } from 'stream';
import { GridFSBucket } from 'mongodb';

// MongoDB Schema for WPPConnect Session Storage
interface IWPPConnectSession extends Document {
  sessionName: string;
  tokenData: SessionToken;
  createdAt: Date;
  updatedAt: Date;
}

let WPPConnectSession: mongoose.Model<IWPPConnectSession>;
try {
  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession');
} catch (error) {
  const WPPConnectSessionSchema = new Schema<IWPPConnectSession>({
    sessionName: { type: String, required: true, unique: true, index: true },
    tokenData: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  WPPConnectSessionSchema.index({ sessionName: 1 });
  WPPConnectSessionSchema.index({ updatedAt: 1 });
  WPPConnectSession = mongoose.model<IWPPConnectSession>('WPPConnectSession', WPPConnectSessionSchema);
}

// ============================================
// Custom MongoDB TokenStore for WPPConnect
// Implements the exact TokenStore interface as a plain object
// ============================================

export class WPPConnectMongoTokenStore {
  private connected: boolean = false;

  constructor() {
    this.connected = false;
  }

  // Create a plain object that implements the TokenStore interface
  // This matches the exact pattern from WPPConnect documentation
  getTokenStore() {
    return {
      getToken: (sessionName: string) => this.getToken(sessionName),
      setToken: (sessionName: string, tokenData: SessionToken) => this.setToken(sessionName, tokenData),
      removeToken: (sessionName: string) => this.removeToken(sessionName),
      listTokens: () => this.listTokens()
    };
  }

  async connect(): Promise<void> {
    if (this.connected) {
      console.log('✅ WPPConnect MongoDB TokenStore already connected.');
      return;
    }
    try {
      // For standalone TokenStore, we don't need explicit connection checking
      // Mongoose connection is managed globally in app.ts
        this.connected = true;
        console.log('✅ WPPConnect MongoDB TokenStore connected successfully');
    } catch (error) {
      console.error('❌ WPPConnect MongoDB connection error:', error);
      throw error;
    }
  }

  async getToken(sessionName: string): Promise<SessionToken | undefined> {
    try {
      console.log(`🔍 TokenStore.getToken() called for: ${sessionName}`);
      const session = await WPPConnectSession.findOne({ sessionName });
      
      if (session && session.tokenData) {
        console.log(`📥 Retrieved WPPConnect session from MongoDB: ${sessionName}`);
        console.log(`📥 Token data keys: ${Object.keys(session.tokenData).join(', ')}`);
        
        const tokenData = session.tokenData;
        if (tokenData.WABrowserId && tokenData.WASecretBundle && tokenData.WAToken1 && tokenData.WAToken2) {
          console.log(`✅ Valid SessionToken found for ${sessionName}`);
          return tokenData as SessionToken;
        } else {
          console.log(`⚠️  Invalid SessionToken structure for ${sessionName}`);
          return undefined;
        }
      }
      
      console.log(`⚠️  No WPPConnect session found in MongoDB: ${sessionName}`);
      return undefined;
    } catch (error) {
      console.error(`❌ Error getting WPPConnect token for ${sessionName}:`, error);
      return undefined;
    }
  }

  async setToken(sessionName: string, tokenData: SessionToken): Promise<boolean> {
    try {
      console.log(`💾 TokenStore.setToken() called for: ${sessionName}`);
      console.log(`💾 Token data keys: ${Object.keys(tokenData || {}).join(', ')}`);
      console.log(`💾 Full token data:`, JSON.stringify(tokenData, null, 2));
      
      if (!tokenData.WABrowserId || !tokenData.WASecretBundle || !tokenData.WAToken1 || !tokenData.WAToken2) {
        console.error(`❌ Invalid SessionToken structure for ${sessionName}`);
        return false;
      }
      
      await WPPConnectSession.findOneAndUpdate(
        { sessionName },
        { 
          sessionName,
          tokenData,
          updatedAt: new Date()
        },
        { 
          upsert: true,
          new: true 
        }
      );
      
      console.log(`✅ Successfully saved WPPConnect session: ${sessionName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error setting WPPConnect token for ${sessionName}:`, error);
      return false;
    }
  }

  async removeToken(sessionName: string): Promise<boolean> {
    try {
      console.log(`🗑️  TokenStore.removeToken() called for: ${sessionName}`);
      await WPPConnectSession.deleteOne({ sessionName });
      console.log(`✅ Removed WPPConnect session: ${sessionName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error removing WPPConnect token for ${sessionName}:`, error);
      return false;
    }
  }

  async listTokens(): Promise<string[]> {
    try {
      console.log(`🔍 TokenStore.listTokens() called`);
      const sessions = await WPPConnectSession.find({}, 'sessionName');
      const sessionNames = sessions.map(session => session.sessionName);
      console.log(`📋 Found ${sessionNames.length} sessions: ${sessionNames.join(', ')}`);
      return sessionNames;
    } catch (error) {
      console.error('❌ Error listing WPPConnect tokens:', error);
      return [];
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.connected = false;
      console.log('🔌 WPPConnect MongoDB TokenStore disconnected');
    }
  }
}

// ============================================
// Browser Session Storage in MongoDB (GridFS)
// Store entire /tokens/{clientId}/ folder in MongoDB
// ============================================

let gridFSBucket: GridFSBucket | null = null;

function getGridFSBucket(): GridFSBucket {
  if (!gridFSBucket) {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection not established');
    }
    gridFSBucket = new GridFSBucket(db, {
      bucketName: 'wppconnect-browser-sessions'
    });
  }
  return gridFSBucket;
}

// Track ongoing uploads to prevent duplicates
const uploadLocks = new Map<string, Promise<boolean>>();

// Track last upload time to prevent rapid successive uploads
const lastUploadTime = new Map<string, number>();
const MIN_UPLOAD_INTERVAL = 10000; // 10 seconds minimum between uploads

/**
 * Extract real session tokens from browser Local Storage
 * WPPConnect stores authentication data in browser's Local Storage
 */
async function extractSessionTokensFromBrowser(clientId: string): Promise<SessionToken | null> {
  try {
    const tokensPath = path.join(process.cwd(), 'tokens', clientId);
    const localStoragePath = path.join(tokensPath, 'Default', 'Local Storage', 'leveldb');
    
    if (!fs.existsSync(localStoragePath)) {
      console.log(`⚠️  Local Storage not found for ${clientId}`);
      return null;
    }
    
    // Try to read session data from Local Storage files
    // WPPConnect stores tokens in browser's Local Storage
    const files = fs.readdirSync(localStoragePath);
    const logFiles = files.filter(f => f.endsWith('.log'));
    
    for (const file of logFiles) {
      try {
        const content = fs.readFileSync(path.join(localStoragePath, file), 'utf8');
        
        // Look for WPPConnect session tokens
        if (content.includes('WABrowserId') || content.includes('WASecretBundle')) {
          // Extract JSON-like structures containing session tokens
          const waBrowserIdMatch = content.match(/"WABrowserId":"([^"]+)"/);
          const waSecretBundleMatch = content.match(/"WASecretBundle":"([^"]+)"/);
          const waToken1Match = content.match(/"WAToken1":"([^"]+)"/);
          const waToken2Match = content.match(/"WAToken2":"([^"]+)"/);
          
          if (waBrowserIdMatch?.[1] && waSecretBundleMatch?.[1] && waToken1Match?.[1] && waToken2Match?.[1]) {
            const sessionToken: SessionToken = {
              WABrowserId: waBrowserIdMatch[1],
              WASecretBundle: waSecretBundleMatch[1],
              WAToken1: waToken1Match[1],
              WAToken2: waToken2Match[1]
            };
            
            console.log(`✅ Extracted real session tokens from browser storage for ${clientId}`);
            return sessionToken;
          }
        }
      } catch (err) {
        // Continue to next file
      }
    }
    
    console.log(`⚠️  Could not extract session tokens from browser storage for ${clientId}`);
    return null;
  } catch (error) {
    console.error(`❌ Error extracting session tokens for ${clientId}:`, error);
    return null;
  }
}

/**
 * Extract and save session tokens from browser Local Storage to MongoDB
 * 
 * PRIMARY PURPOSE: Extract WABrowserId, WASecretBundle, WAToken1, WAToken2
 * from Chromium's Local Storage and save to MongoDB for cross-server use
 * 
 * SECONDARY: Also backs up browser folder to GridFS (for debugging/fallback)
 * 
 * NOTE: Session tokens in MongoDB are sufficient for authentication across
 * any server. Browser folder is temporary and not relied upon for deployment.
 */
export async function uploadBrowserSessionToMongo(clientId: string): Promise<boolean> {
  // Check if upload is already in progress
  if (uploadLocks.has(clientId)) {
    console.log(`⏳ Upload already in progress for ${clientId}, skipping duplicate request`);
    return true; // Return true to indicate session will be saved
  }

  // Check if we've uploaded too recently (debounce)
  const lastUpload = lastUploadTime.get(clientId);
  if (lastUpload) {
    const timeSinceLastUpload = Date.now() - lastUpload;
    if (timeSinceLastUpload < MIN_UPLOAD_INTERVAL) {
      console.log(`⏭️  Skipping upload for ${clientId} - uploaded ${Math.round(timeSinceLastUpload / 1000)}s ago (min interval: ${MIN_UPLOAD_INTERVAL / 1000}s)`);
      return true; // Return true since we have a recent upload
    }
  }

  // Create upload promise with timeout
  const uploadPromise = (async (): Promise<boolean> => {
    try {
      const tokensPath = path.join(process.cwd(), 'tokens', clientId);
      
      if (!fs.existsSync(tokensPath)) {
        console.log(`⚠️  Browser session folder not found for ${clientId}`);
        return false;
      }

      const bucket = getGridFSBucket();
      
      // ATOMIC REPLACE STRATEGY:
      // 1. Upload to temporary filename (clientId.tmp)
      // 2. Only delete old backup AFTER new upload succeeds
      // 3. This prevents corruption if upload fails mid-way
      const tempFilename = `${clientId}.tmp`;

      console.log(`📦 Compressing browser session folder for ${clientId}...`);

      // Create zip archive with fastest compression (store mode = no compression for max speed)
      const archive = archiver('zip', { zlib: { level: 0 } }); // Level 0 = store only, no compression (fastest)
      const uploadStream = bucket.openUploadStream(tempFilename, {
        metadata: { 
          clientId, 
          uploadedAt: new Date(),
          type: 'browser-session',
          isTemporary: true
        }
      });

      // Set up abort mechanism
      let uploadAborted = false;
      const abortUpload = () => {
        if (!uploadAborted) {
          uploadAborted = true;
          console.log(`⚠️  Aborting upload for ${clientId} due to timeout`);
          try {
            archive.abort();
            uploadStream.destroy();
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      };

      archive.pipe(uploadStream);
      
      // Add directory but exclude lock files to prevent "profile in use" errors
      // These lock files should never be preserved across restarts
      archive.glob('**/*', {
        cwd: tokensPath,
        ignore: [
          'SingletonLock',
          'SingletonSocket', 
          'SingletonCookie',
          'lockfile',
          '**/SingletonLock',
          '**/SingletonSocket',
          '**/SingletonCookie',
          '**/lockfile'
        ]
      });
      
      // Finalize in background
      archive.finalize().catch((err) => {
        if (!uploadAborted) {
          console.error(`❌ Archive finalize error for ${clientId}:`, err);
        }
      });

      // Add timeout to prevent hanging during shutdown (longer for reliability)
      let cleanupDone = false; // Track if cleanup already happened
      const result = await Promise.race([
        new Promise<boolean>(async (resolve, reject) => {
          uploadStream.on('finish', async () => {
            if (!uploadAborted) {
              try {
                // ATOMIC REPLACE: Now that upload succeeded, replace old backup with new one
                console.log(`🔄 Replacing old backup with new one for ${clientId}...`);
                
                // Delete old backup files (with actual clientId filename)
                const oldFiles = await bucket.find({ filename: clientId }).toArray();
                for (const file of oldFiles) {
                  await bucket.delete(file._id);
                }
                
                // Rename temp file to actual filename by re-uploading with correct name
                // (GridFS doesn't support rename, so we download and re-upload)
                const tempFiles = await bucket.find({ filename: tempFilename }).toArray();
                if (tempFiles.length > 0 && tempFiles[0]) {
                  const tempFile = tempFiles[0];
                  const downloadStream = bucket.openDownloadStream(tempFile._id);
                  const finalUploadStream = bucket.openUploadStream(clientId, {
                    metadata: { 
                      clientId, 
                      uploadedAt: new Date(),
                      type: 'browser-session',
                      isTemporary: false
                    }
                  });
                  
                  await new Promise<void>((resolveRename, rejectRename) => {
                    downloadStream.pipe(finalUploadStream);
                    finalUploadStream.on('finish', () => resolveRename());
                    finalUploadStream.on('error', (err) => rejectRename(err));
                  });
                  
                  // Delete temp file - mark cleanup as done
                  if (tempFile._id && !cleanupDone) {
                    cleanupDone = true;
                    await bucket.delete(tempFile._id);
                  }
                }
                
                console.log(`✅ Browser session uploaded to MongoDB for ${clientId} (atomic replace)`);
                lastUploadTime.set(clientId, Date.now()); // Record successful upload time
                
                // Also extract and save session tokens for cross-server portability
                extractSessionTokensFromBrowser(clientId).then(async (sessionToken) => {
                  if (sessionToken) {
                    try {
                      await WPPConnectSession.findOneAndUpdate(
                        { sessionName: clientId },
                        { 
                          sessionName: clientId,
                          tokenData: sessionToken,
                          updatedAt: new Date()
                        },
                        { upsert: true, new: true }
                      );
                      console.log(`✅ Saved extracted session tokens to MongoDB for ${clientId}`);
                    } catch (tokenError) {
                      console.error(`❌ Failed to save session tokens for ${clientId}:`, tokenError);
                    }
                  }
                }).catch(err => console.error(`Error extracting tokens: ${err}`));
                
                resolve(true);
              } catch (replaceError) {
                console.error(`❌ Error during atomic replace for ${clientId}:`, replaceError);
                // Don't reject - just keep old backup
                // This prevents crash if temp file was already deleted by timeout
                console.log(`⚠️  Keeping old backup for ${clientId} due to atomic replace error`);
                resolve(false);
              }
            }
          });
          uploadStream.on('error', (error) => {
            if (!uploadAborted) {
              console.error(`❌ Error uploading browser session for ${clientId}:`, error);
              // Clean up temp file on error - only if not already done
              if (!cleanupDone) {
                cleanupDone = true;
                bucket.find({ filename: tempFilename }).toArray().then(tempFiles => {
                  tempFiles.forEach(file => bucket.delete(file._id).catch(() => {}));
                }).catch(() => {});
              }
              resolve(false); // Don't reject - just keep old backup
            }
          });
        }),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            abortUpload();
            console.log(`⏱️  Upload timeout for ${clientId} after 30s, keeping old backup...`);
            // Clean up temp file on timeout - only if not already done
            if (!cleanupDone) {
              cleanupDone = true;
              bucket.find({ filename: tempFilename }).toArray().then(tempFiles => {
                tempFiles.forEach(file => bucket.delete(file._id).catch(() => {}));
              }).catch(() => {});
            }
            resolve(false); // Return false instead of rejecting to prevent crash
          }, 30000); // 30 seconds for reliable upload
        })
      ]);
      
      // Even on timeout, record attempt time to prevent immediate retries
      if (!result) {
        lastUploadTime.set(clientId, Date.now());
      }
      
      return result;
    } catch (error) {
      console.error(`❌ Failed to upload browser session for ${clientId}:`, error);
      return false;
    } finally {
      // Remove lock when done
      uploadLocks.delete(clientId);
    }
  })();

  // Store the promise in locks
  uploadLocks.set(clientId, uploadPromise);
  
  return uploadPromise;
}

/**
 * Clean Chromium lock files from browser session folder
 * These files prevent profile from being used on different servers/processes
 */
function cleanChromiumLockFiles(tokensPath: string): void {
  const lockFiles = [
    'SingletonLock',
    'SingletonSocket', 
    'SingletonCookie',
    'lockfile'
  ];
  
  let cleanedCount = 0;
  for (const lockFile of lockFiles) {
    const lockPath = path.join(tokensPath, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        cleanedCount++;
      } catch (error) {
        console.warn(`⚠️  Could not remove lock file ${lockFile}:`, error);
      }
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} Chromium lock file(s) from ${tokensPath}`);
  }
}

/**
 * Download browser session folder from MongoDB GridFS
 * Extracts the zip to /tokens/{clientId}/
 */
export async function downloadBrowserSessionFromMongo(clientId: string): Promise<boolean> {
  try {
    const bucket = getGridFSBucket();
    
    const files = await bucket.find({ filename: clientId }).toArray();
    if (files.length === 0) {
      console.log(`📋 No browser session found in MongoDB for ${clientId}`);
      return false;
    }

    console.log(`📥 Downloading browser session from MongoDB for ${clientId}...`);

    const tokensPath = path.join(process.cwd(), 'tokens', clientId);
    
    // Create tokens directory if it doesn't exist
    if (!fs.existsSync(path.join(process.cwd(), 'tokens'))) {
      fs.mkdirSync(path.join(process.cwd(), 'tokens'), { recursive: true });
    }

    // Download and extract
    const downloadStream = bucket.openDownloadStreamByName(clientId);
    const extract = require('extract-zip');
    const tmpZipPath = path.join(process.cwd(), 'tokens', `${clientId}.zip`);

    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(tmpZipPath);
      
      downloadStream.pipe(writeStream);
      
      writeStream.on('finish', async () => {
        try {
          await extract(tmpZipPath, { dir: tokensPath });
          fs.unlinkSync(tmpZipPath); // Clean up zip file
          
          // CRITICAL: Clean Chromium lock files after extraction
          // This allows the session to work on different servers/processes
          cleanChromiumLockFiles(tokensPath);
          
          console.log(`✅ Browser session extracted to /tokens/${clientId}/`);
          resolve(true);
        } catch (error) {
          console.error(`❌ Error extracting browser session for ${clientId}:`, error);
          reject(error);
        }
      });
      
      writeStream.on('error', (error) => {
        console.error(`❌ Error downloading browser session for ${clientId}:`, error);
        reject(error);
      });
    });
  } catch (error) {
    console.error(`❌ Failed to download browser session for ${clientId}:`, error);
    return false;
  }
}

/**
 * Delete browser session from MongoDB GridFS
 */
export async function deleteBrowserSessionFromMongo(clientId: string): Promise<boolean> {
  try {
    const bucket = getGridFSBucket();
    const files = await bucket.find({ filename: clientId }).toArray();
    
    for (const file of files) {
      await bucket.delete(file._id);
    }
    
    if (files.length > 0) {
      console.log(`🗑️  Deleted browser session from MongoDB for ${clientId}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Failed to delete browser session for ${clientId}:`, error);
    return false;
  }
}

/**
 * List all browser sessions in MongoDB
 */
export async function listBrowserSessionsInMongo(): Promise<string[]> {
  try {
    const bucket = getGridFSBucket();
    const files = await bucket.find({}).toArray();
    const clientIds = files.map(file => file.filename as string);
    return [...new Set(clientIds)]; // Remove duplicates
  } catch (error) {
    console.error('❌ Failed to list browser sessions:', error);
    return [];
  }
}

// ============================================
// Standalone MongoDB TokenStore Object
// This follows the exact pattern from WPPConnect documentation
// ============================================

export function createMongoTokenStore(): any {
  return {
    getToken: (sessionName: string) => {
      console.log(`🔍 TokenStore.getToken() called for: ${sessionName}`);
      return new Promise((resolve) => {
        WPPConnectSession.findOne({ sessionName })
          .then(session => {
            if (session && session.tokenData) {
              console.log(`📥 Retrieved WPPConnect session from MongoDB: ${sessionName}`);
              console.log(`📥 Token data keys: ${Object.keys(session.tokenData).join(', ')}`);
              
              const tokenData = session.tokenData;
              if (tokenData.WABrowserId && tokenData.WASecretBundle && tokenData.WAToken1 && tokenData.WAToken2) {
                console.log(`✅ Valid SessionToken found for ${sessionName}`);
                resolve(tokenData as SessionToken);
              } else {
                console.log(`⚠️  Invalid SessionToken structure for ${sessionName}`);
                resolve(undefined);
              }
            } else {
              console.log(`⚠️  No WPPConnect session found in MongoDB: ${sessionName}`);
              resolve(undefined);
            }
          })
          .catch(error => {
            console.error(`❌ Error getting WPPConnect token for ${sessionName}:`, error);
            resolve(undefined);
          });
      });
    },

    setToken: (sessionName: string, tokenData: SessionToken) => {
      console.log(`💾 TokenStore.setToken() called for: ${sessionName}`);
      console.log(`💾 Token data keys: ${Object.keys(tokenData || {}).join(', ')}`);
      console.log(`💾 Full token data:`, JSON.stringify(tokenData, null, 2));
      
      return new Promise((resolve) => {
        // Relaxed validation - WPPConnect might not pass all keys immediately
        if (!tokenData || Object.keys(tokenData).length === 0) {
          console.error(`❌ Invalid SessionToken structure for ${sessionName} - empty or null`);
          resolve(false);
          return;
        }
        
        WPPConnectSession.findOneAndUpdate(
          { sessionName },
          { 
            sessionName,
            tokenData,
            updatedAt: new Date()
          },
          { 
            upsert: true,
            new: true 
          }
        )
        .then(() => {
          console.log(`✅ Successfully saved WPPConnect session: ${sessionName}`);
          resolve(true);
        })
        .catch(error => {
          console.error(`❌ Error setting WPPConnect token for ${sessionName}:`, error);
          resolve(false);
        });
      });
    },

    removeToken: (sessionName: string) => {
      return new Promise((resolve) => {
        WPPConnectSession.deleteOne({ sessionName })
          .then(() => {
            console.log(`🗑️  Removed WPPConnect session: ${sessionName}`);
            resolve(true);
          })
          .catch(error => {
            console.error(`❌ Error removing WPPConnect token for ${sessionName}:`, error);
            resolve(false);
          });
      });
    },

    listTokens: () => {
      console.log(`🔍 TokenStore.listTokens() called`);
      return new Promise((resolve) => {
        WPPConnectSession.find({}, 'sessionName')
          .then(sessions => {
            const sessionNames = sessions.map(session => session.sessionName);
            console.log(`📋 Found ${sessionNames.length} sessions: ${sessionNames.join(', ')}`);
            resolve(sessionNames);
          })
          .catch(error => {
            console.error('❌ Error listing WPPConnect tokens:', error);
            resolve([]);
          });
      });
    }
  };
}