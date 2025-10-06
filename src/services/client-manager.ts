import { create, Whatsapp } from '@wppconnect-team/wppconnect';
import mongoose from 'mongoose';
import { 
  WPPConnectMongoTokenStore, 
  createMongoTokenStore,
  uploadBrowserSessionToMongo,
  downloadBrowserSessionFromMongo,
  deleteBrowserSessionFromMongo,
  listBrowserSessionsInMongo
} from './tokenstore';
import fs from 'fs';
import path from 'path';

// ============================================
// WPPConnect Client Manager
// ============================================

export interface WPPConnectClientInfo {
  clientId: string;
  client: Whatsapp;
  isReady: boolean;
  phoneNumber?: string | undefined;
  qrCode?: string | undefined;
  lastActivity: Date;
  status: 'initializing' | 'qr_required' | 'authenticated' | 'ready' | 'disconnected' | 'error' | 'session_saved';
  ai_agent_code?: string | undefined;
}

export interface WPPConnectClientManagerConfig {
  chromiumPath: string;
  puppeteerArgs: string[];
  mongoUri: string;
  backupSyncIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  healthCheckIntervalMs?: number;
}

export class WPPConnectClientManager {
  private clients: Map<string, WPPConnectClientInfo> = new Map();
  private config: WPPConnectClientManagerConfig;
  private messageHandlers: ((clientId: string, message: any) => Promise<void>)[] = [];
  private tokenStore: WPPConnectMongoTokenStore | null = null;
  private standaloneTokenStore: any = null;
  private isMongoConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private sessionBackupInterval: NodeJS.Timeout | null = null;
  private retryAttempts: Map<string, number> = new Map();

  constructor(config: WPPConnectClientManagerConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    await this.initializeMongoDB();
    this.startHealthCheck();
    this.startPeriodicSessionBackup();
  }

  private async initializeMongoDB(): Promise<void> {
    try {
      if (mongoose.connection.readyState === 1) {
        this.isMongoConnected = true;
        this.tokenStore = new WPPConnectMongoTokenStore();
        // Standalone TokenStore doesn't need explicit connection
        // Create standalone TokenStore for WPPConnect
        this.standaloneTokenStore = createMongoTokenStore();
        console.log('✅ WPPConnect MongoDB TokenStore initialized');
      } else {
        throw new Error('MongoDB connection not available');
      }
    } catch (error) {
      console.error('❌ Failed to initialize WPPConnect MongoDB:', error);
      throw error;
    }
  }

  public async createClient(clientId: string): Promise<WPPConnectClientInfo> {
    if (this.clients.has(clientId)) {
      throw new Error(`Client with ID '${clientId}' already exists`);
    }

    console.log(`🚀 Creating new WPPConnect client: ${clientId}`);

    if (!this.isMongoConnected || !this.tokenStore) {
      throw new Error('MongoDB connection is required. Please ensure MONGODB_URI is set and MongoDB is connected.');
    }

    // Check for and clean up any broken sessions in MongoDB
    await this.detectAndCleanupBrokenSession(clientId);

    console.log(`🔗 Using WPPConnect MongoDB TokenStore for client ${clientId}`);

    // Add placeholder client info immediately so it's queryable
    const placeholderClientInfo: WPPConnectClientInfo = {
      clientId,
      client: null as any, // Will be set after creation
      isReady: false,
      lastActivity: new Date(),
      status: 'initializing'
    };
    this.clients.set(clientId, placeholderClientInfo);
    console.log(`📝 Client ${clientId} added to map with 'initializing' status`);

    try {
      // BULLETPROOF SESSION RESTORATION - MONGODB ONLY (NO LOCAL FILES)
      // Session tokens stored in MongoDB work across ANY server/deployment
      // No dependency on /tokens folder (which is not committed to git)
      
      console.log(`🔍 TokenStore type: ${typeof this.standaloneTokenStore}`);
      console.log(`🔍 TokenStore keys: ${this.standaloneTokenStore ? Object.keys(this.standaloneTokenStore).join(', ') : 'null'}`);
      
      // Try to restore session tokens from MongoDB
      let sessionToken = null;
      try {
        sessionToken = await this.standaloneTokenStore.getToken(clientId);
        if (sessionToken && sessionToken.WABrowserId && sessionToken.WASecretBundle) {
          console.log(`✅ Found valid session tokens in MongoDB for ${clientId}`);
          console.log(`🔄 Token keys: ${Object.keys(sessionToken).join(', ')}`);
          console.log(`🎯 Using session tokens from MongoDB - works across ANY server!`);
        } else {
          console.log(`📝 No session tokens found in MongoDB for ${clientId}`);
          console.log(`📝 Will generate QR code for authentication`);
        }
      } catch (error) {
        console.error(`❌ Error retrieving session token for ${clientId}:`, error);
        console.log(`📝 Will generate QR code for authentication`);
      }
      
      const client = await create({
        session: clientId,
        tokenStore: this.standaloneTokenStore, // Custom MongoDB TokenStore
        sessionToken: sessionToken || undefined, // Pass saved token if available
        
        // Browser configuration
        headless: true,
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: false, // Disable console QR - use API endpoint instead
        folderNameToken: 'tokens', // Store browser sessions in /tokens directory
        
        // Browser options - let WPPConnect handle session persistence through tokenStore
        puppeteerOptions: {
          executablePath: this.config.chromiumPath,
          args: this.config.puppeteerArgs,
          // Increase timeout for browser launch (helpful for restored sessions)
          timeout: 60000,
          // Handle process errors gracefully
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false
        },
        
        // Browser arguments (optimized for memory)
        browserArgs: this.config.puppeteerArgs,
        
        // Callbacks
        statusFind: async (statusSession, session) => {
          console.log(`📊 WPPConnect Status for ${session}: ${statusSession}`);
          this.updateClientStatus(clientId, statusSession);
          
          // Save session tokens to MongoDB after successful authentication
          if (statusSession === 'qrReadSuccess' || statusSession === 'isLogged' || statusSession === 'inChat') {
            try {
              const clientInfo = this.clients.get(clientId);
              if (clientInfo && clientInfo.client) {
                console.log(`💾 Saving session tokens to MongoDB for ${clientId} after ${statusSession}`);
                
                // Wait for browser to finish writing session files
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Get session token from WPPConnect client
                const sessionToken = await clientInfo.client.getSessionTokenBrowser();
                console.log(`🔍 Retrieved session token from WPPConnect:`, JSON.stringify(sessionToken, null, 2));
                
                // Save to MongoDB via TokenStore
                if (sessionToken && Object.keys(sessionToken).length > 0) {
                  const saved = await this.standaloneTokenStore.setToken(clientId, sessionToken);
                  if (saved) {
                    console.log(`✅ Session tokens saved to MongoDB for ${clientId}`);
                    console.log(`🎯 Session will work across ANY server deployment!`);
                  } else {
                    console.error(`❌ Failed to save session tokens to MongoDB for ${clientId}`);
                  }
                } else {
                  console.warn(`⚠️  No valid session token retrieved from WPPConnect for ${clientId}`);
                  
                  // Fallback: Try extracting from browser folder
                  console.log(`📁 Attempting fallback: extracting from browser folder...`);
                  const uploaded = await uploadBrowserSessionToMongo(clientId);
                  if (uploaded) {
                    console.log(`✅ Fallback extraction successful`);
                  }
                }
              }
            } catch (error) {
              console.error(`❌ Error saving session tokens for ${clientId}:`, error);
            }
          }
        },
        
        catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
          console.log(`📱 QR Code generated for ${clientId} (attempt ${attempts}) - Access via /api/whatsapp/clients/${clientId}/qr-image`);
          this.updateClientQR(clientId, base64Qr);
        },
        
        // Auto-close settings
        autoClose: 180000, // 3 minutes to allow testing
        
        // Additional options
        disableWelcome: true,
        updatesLog: true
      });

      console.log(`✅ WPPConnect client created: ${clientId}`);

      // Set up message handler
      client.onMessage(async (message) => {
        console.log(`📨 Message received on WPPConnect client ${clientId}:`, message.body);
        for (const handler of this.messageHandlers) {
          try {
            await handler(clientId, message);
          } catch (error) {
            console.error(`❌ Error in message handler for ${clientId}:`, error);
          }
        }
      });

      // Set up ready handler with comprehensive session sync
      client.onStateChange(async (state) => {
        console.log(`🔄 WPPConnect client ${clientId} state changed: ${state}`);
        
        if (state === 'CONNECTED') {
          // Update client to ready state when connected
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'ready';
            clientInfo.isReady = true;
            clientInfo.lastActivity = new Date();
            console.log(`✅ WPPConnect client ${clientId} is now READY (CONNECTED)`);
            
            // Extract and sync session tokens to MongoDB on CONNECTED state
            try {
              console.log(`🔄 Extracting session tokens after CONNECTED state for ${clientId}`);
              await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for session stabilization
              const uploaded = await uploadBrowserSessionToMongo(clientId);
              if (uploaded) {
                console.log(`✅ Session tokens extracted and synced to MongoDB for ${clientId}`);
              }
            } catch (error) {
              console.error(`❌ Failed to extract session tokens on CONNECTED for ${clientId}:`, error);
            }
          }
          this.updateClientPhoneNumber(clientId);
        }
        
        // Handle disconnection states
        if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          console.log(`📴 Client ${clientId} unpaired/disconnected - removing session from MongoDB`);
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
            
            // Delete session from MongoDB when unpaired
            try {
              await deleteBrowserSessionFromMongo(clientId);
              console.log(`🗑️  Session deleted from MongoDB for unpaired client ${clientId}`);
            } catch (error) {
              console.error(`❌ Failed to delete session for unpaired ${clientId}:`, error);
            }
          }
        }
        
        // Handle conflict - might indicate session change
        if (state === 'CONFLICT') {
          console.log(`⚠️  Client ${clientId} in CONFLICT state - session may have been taken over by another device`);
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
            
            // Delete old session from MongoDB
            try {
              await deleteBrowserSessionFromMongo(clientId);
              console.log(`🗑️  Session deleted from MongoDB for conflicted client ${clientId}`);
            } catch (error) {
              console.error(`❌ Failed to delete conflicted session for ${clientId}:`, error);
            }
          }
        }
      });

      // Update the placeholder with the actual client instance
      const existingClientInfo = this.clients.get(clientId);
      if (existingClientInfo) {
        existingClientInfo.client = client;
        existingClientInfo.lastActivity = new Date();
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        
        // Note: WPPConnect automatically handles session persistence through tokenStore
        console.log(`🔄 WPPConnect will automatically manage session persistence via tokenStore`);
        
        // Update phone number if client is already authenticated (restored session)
        if (existingClientInfo.isReady) {
          await this.updateClientPhoneNumber(clientId);
          console.log(`✅ Client ${clientId} is already ready - session managed by WPPConnect tokenStore`);
        }
        
        return existingClientInfo;
      } else {
        // Fallback if somehow the placeholder was removed
        const clientInfo: WPPConnectClientInfo = {
          clientId,
          client,
          isReady: false,
          lastActivity: new Date(),
          status: 'initializing'
        };
        this.clients.set(clientId, clientInfo);
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        return clientInfo;
      }

    } catch (error) {
      console.error(`❌ Failed to create WPPConnect client ${clientId}:`, error);
      
      // Check if error is due to browser already running or profile locked
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isBrowserLockError = errorMessage.includes('browser is already running') || 
                                 errorMessage.includes('userDataDir') ||
                                 errorMessage.includes('profile appears to be in use') ||
                                 errorMessage.includes('locked the profile');
      
      if (isBrowserLockError) {
        // Check if we've already retried to prevent infinite loops
        const retryKey = `${clientId}_lock_retry`;
        const retryCount = (this as any)[retryKey] || 0;
        
        if (retryCount >= 2) {
          console.log(`❌ Max retry attempts (${retryCount}) reached for ${clientId}, giving up`);
          delete (this as any)[retryKey];
          
          // Delete the corrupted browser folder and MongoDB session
          const fs = require('fs');
          const path = require('path');
          const browserPath = path.join(process.cwd(), 'tokens', clientId);
          
          try {
            if (fs.existsSync(browserPath)) {
              fs.rmSync(browserPath, { recursive: true, force: true });
              console.log(`🗑️  Removed corrupted browser folder: ${browserPath}`);
            }
            
            await deleteBrowserSessionFromMongo(clientId);
            console.log(`🗑️  Removed corrupted session from MongoDB for ${clientId}`);
          } catch (e) {
            console.error(`⚠️  Cleanup error:`, e);
          }
          
          throw new Error(`Failed to recover from browser lock after ${retryCount} attempts`);
        }
        
        (this as any)[retryKey] = retryCount + 1;
        console.log(`🔄 Browser/profile lock detected for ${clientId}, cleanup attempt ${retryCount + 1}/2...`);
        
        try {
          const { execSync } = require('child_process');
          const fs = require('fs');
          const path = require('path');
          const tokensPath = path.join(process.cwd(), 'tokens');
          
          // CRITICAL: Delete the entire tokens folder to force clean slate for all clients
          // This prevents any stale files from interfering with fresh downloads
          console.log(`🗑️  Removing entire tokens folder for clean extraction: ${tokensPath}`);
          if (fs.existsSync(tokensPath)) {
            fs.rmSync(tokensPath, { recursive: true, force: true });
            console.log(`✅ Tokens folder removed successfully`);
          }
          
          // Extract PID from error message if available
          const pidMatch = errorMessage.match(/process \((\d+)\)/);
          if (pidMatch && pidMatch[1]) {
            const lockingPid = pidMatch[1];
            console.log(`🔍 Found locking process PID: ${lockingPid}`);
            
            try {
              // Try to kill if it's a local process
              execSync(`kill -0 ${lockingPid} 2>/dev/null && kill -9 ${lockingPid}`, { 
                stdio: 'ignore',
                timeout: 5000 
              });
              console.log(`💀 Killed stale Chromium process: ${lockingPid}`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (killError) {
              console.log(`ℹ️  Process ${lockingPid} not found (may be remote or already terminated)`);
            }
          }
          
          // Kill any local Chromium processes using this profile
          try {
            const grepCmd = `ps aux | grep -i "[c]hromium.*${clientId}" | awk '{print $2}'`;
            const pids = execSync(grepCmd, { encoding: 'utf8', timeout: 5000 }).trim();
            if (pids) {
              const pidList = pids.split('\n').filter(Boolean);
              for (const pid of pidList) {
                try {
                  execSync(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 5000 });
                  console.log(`💀 Killed Chromium process using ${clientId}: ${pid}`);
                } catch (e) {
                  // Process already gone
                }
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          } catch (grepError) {
            console.log(`ℹ️  No local Chromium processes found for ${clientId}`);
          }
          
          console.log(`✅ Cleanup completed, retrying with fresh download...`);
          
          // Remove the failed placeholder
          this.clients.delete(clientId);
          
          // Wait for filesystem to sync
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Retry creating the client
          const result = await this.createClient(clientId);
          
          // Success! Clear retry counter
          delete (this as any)[retryKey];
          return result;
          
        } catch (cleanupError) {
          console.error(`❌ Failed to cleanup browser locks for ${clientId}:`, cleanupError);
          throw cleanupError;
        }
      }
      
      // Remove the placeholder client if creation failed
      this.clients.delete(clientId);
      console.log(`🗑️  Removed failed client ${clientId} from map`);
      
      // Only delete from MongoDB if it's a true authentication failure, not process interruption or browser lock
      // Check if error indicates authentication failure (not timeout, not process kill, not browser lock)
      const isAuthFailure = errorMessage.includes('authentication') || 
                           errorMessage.includes('qr') ||
                           errorMessage.includes('timeout') === false; // Don't delete on timeout
      
      const isBrowserIssue = errorMessage.includes('SIGTERM') || 
                            errorMessage.includes('SIGINT') ||
                            errorMessage.includes('profile appears to be in use') ||
                            errorMessage.includes('locked the profile') ||
                            errorMessage.includes('browser is already running');
      
      if (this.tokenStore && isAuthFailure && !isBrowserIssue) {
        try {
          console.log(`⚠️  Authentication failure detected, considering session cleanup...`);
          // Only delete if there's no existing valid session in MongoDB
          // This prevents deleting good sessions on process restart failures
          await deleteBrowserSessionFromMongo(clientId);
          console.log(`🗑️  Deleted failed browser session from MongoDB GridFS: ${clientId}`);
        } catch (mongoError) {
          console.error(`⚠️  Failed to delete browser session from MongoDB for ${clientId}:`, mongoError);
        }
      } else {
        console.log(`ℹ️  Keeping existing session in MongoDB for ${clientId} (error: ${errorMessage.substring(0, 50)}...)`);
      }
      
      throw error;
    }
  }


  private async saveSessionToMongoDB(clientId: string): Promise<void> {
    try {
      console.log(`🔄 Attempting to save session for ${clientId} to MongoDB...`);
      const clientInfo = this.clients.get(clientId);
      console.log(`🔍 Client info for ${clientId}: exists=${!!clientInfo}, hasClient=${!!clientInfo?.client}, hasTokenStore=${!!this.tokenStore}`);
      
      if (clientInfo && clientInfo.client && this.tokenStore) {
        // Get session token from WPPConnect client
        const sessionToken = await clientInfo.client.getSessionTokenBrowser();
        
        if (sessionToken) {
          console.log(`🔑 Session token obtained for ${clientId}, saving to MongoDB...`);
          console.log(`🔑 Token keys: ${Object.keys(sessionToken).join(', ')}`);
          
          // Save to MongoDB via TokenStore
          const success = await this.standaloneTokenStore.setToken(clientId, sessionToken);
          
          if (success) {
            console.log(`💾 Successfully saved WPPConnect session to MongoDB: ${clientId}`);
          } else {
            console.error(`❌ Failed to save session to MongoDB for ${clientId}`);
          }
        } else {
          console.log(`⚠️ No session token available for ${clientId}`);
        }
      } else {
        console.log(`⚠️ Cannot save session for ${clientId}: clientInfo=${!!clientInfo}, client=${!!clientInfo?.client}, tokenStore=${!!this.tokenStore}`);
      }
    } catch (error) {
      console.error(`❌ Error saving session for ${clientId}:`, error);
    }
  }

  private updateClientStatus(clientId: string, status: string): void {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo) {
      switch (status) {
        case 'isLogged':
        case 'qrReadSuccess':
        case 'inChat':
          // Client is authenticated and ready
          clientInfo.status = 'ready';
          clientInfo.isReady = true;
          console.log(`✅ WPPConnect client ${clientId} status: ${status} → ready`);
          
          // WPPConnect automatically handles session saving via tokenStore
          console.log(`✅ WPPConnect automatically manages session persistence via tokenStore`);
          break;
        case 'notLogged':
          clientInfo.status = 'qr_required';
          clientInfo.isReady = false;
          // Keep existing QR code if available
          console.log(`📋 WPPConnect client ${clientId} notLogged - QR code available: ${!!clientInfo.qrCode}`);
          break;
        case 'autocloseCalled':
        case 'qrReadFail':
          // Clear authentication failures - delete from MongoDB
          console.log(`🗑️  Removing client ${clientId} - Authentication failed (${status})`);
          this.clients.delete(clientId);
          
          // Delete the browser session from MongoDB GridFS to prevent resurrection on restart
          if (this.tokenStore) {
            deleteBrowserSessionFromMongo(clientId)
              .then(() => {
                console.log(`🗑️  Deleted failed browser session from MongoDB GridFS: ${clientId}`);
              })
              .catch((error: any) => {
                console.error(`⚠️  Failed to delete browser session from MongoDB for ${clientId}:`, error);
              });
          }
          return;
        case 'qrReadError':
          // qrReadError can be a false positive if client is already authenticated
          // Only treat as failure if client is NOT ready/authenticated
          if (clientInfo.isReady || clientInfo.status === 'ready' || clientInfo.status === 'authenticated') {
            console.log(`⚠️  Ignoring qrReadError for ${clientId} - client is already authenticated`);
            break;
          }
          
          // Only delete if truly not authenticated
          console.log(`🗑️  Removing client ${clientId} - Authentication failed (qrReadError) and not authenticated`);
          this.clients.delete(clientId);
          
          if (this.tokenStore) {
            deleteBrowserSessionFromMongo(clientId)
              .then(() => {
                console.log(`🗑️  Deleted failed browser session from MongoDB GridFS: ${clientId}`);
              })
              .catch((error: any) => {
                console.error(`⚠️  Failed to delete browser session from MongoDB for ${clientId}:`, error);
              });
          }
          return;
        case 'browserClose':
          // Browser close is normal (happens during shutdown/restart)
          // Don't remove from map - let cleanup handle it properly
          console.log(`📴 Browser closed for ${clientId} - keeping client in map for graceful shutdown`);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
          break;
        case 'desconnectedMobile':
        case 'serverClose':
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          // Preserve QR code if available
          console.log(`📴 WPPConnect client ${clientId} disconnected: ${status} - QR code available: ${!!clientInfo.qrCode}`);
          break;
        default:
          // Don't override status if we don't recognize it
          console.log(`ℹ️  WPPConnect client ${clientId} unknown status: ${status}`);
      }
      clientInfo.lastActivity = new Date();
    }
  }

  private updateClientQR(clientId: string, qrCode: string): void {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo) {
      clientInfo.qrCode = qrCode;
      clientInfo.status = 'qr_required';
      clientInfo.lastActivity = new Date();
      console.log(`📱 Updated QR code for ${clientId}, qrCode length: ${qrCode.length}`);
    } else {
      console.warn(`⚠️ Client ${clientId} not found when trying to update QR code`);
    }
  }

  private async updateClientPhoneNumber(clientId: string): Promise<void> {
    const clientInfo = this.clients.get(clientId);
    if (clientInfo && clientInfo.client) {
      try {
        // Try getWid() method (more reliable for phone number)
        const wid = await clientInfo.client.getWid();
        console.log(`📞 Raw WID for ${clientId}:`, wid);
        
        let phoneNumber = null;
        if (wid) {
          if (typeof wid === 'string') {
            phoneNumber = wid;
          } else if (typeof wid === 'object') {
            const widObj: any = wid;
            phoneNumber = widObj._serialized || widObj.user || widObj.toString();
          }
        }
        
        // Fallback to getHostDevice()
        if (!phoneNumber) {
          const hostDevice = await clientInfo.client.getHostDevice();
          console.log(`📞 Raw host device for ${clientId}:`, hostDevice);
          
          if (hostDevice) {
            if (typeof hostDevice === 'string') {
              phoneNumber = hostDevice;
            } else if (typeof hostDevice === 'object') {
              const deviceObj: any = hostDevice;
              if (deviceObj.id) {
                phoneNumber = deviceObj.id._serialized || deviceObj.id.user || deviceObj.id;
              } else if (deviceObj._serialized) {
                phoneNumber = deviceObj._serialized;
              } else if (deviceObj.user) {
                phoneNumber = deviceObj.user;
              }
            }
          }
        }
        
        if (phoneNumber) {
          // Clean up the phone number (remove @c.us if present)
          const cleanNumber = phoneNumber.toString().replace('@c.us', '').replace(':0', '');
          clientInfo.phoneNumber = cleanNumber;
          console.log(`📞 WPPConnect client ${clientId} phone number: ${cleanNumber}`);
        } else {
          console.log(`⚠️ Could not extract phone number for ${clientId}`);
        }
      } catch (error) {
        console.error(`❌ Error getting phone number for ${clientId}:`, error);
      }
    }
  }

  public async sendMessage(clientId: string, number: string, message: string): Promise<boolean> {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo || !clientInfo.isReady) {
      throw new Error(`Client ${clientId} is not ready`);
    }

    try {
      const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
      const result = await clientInfo.client.sendText(formattedNumber, message);
      console.log(`✅ Message sent via WPPConnect client ${clientId}:`, result);
      return true;
    } catch (error) {
      console.error(`❌ Error sending message via WPPConnect client ${clientId}:`, error);
      throw error;
    }
  }

  public async disconnectClient(clientId: string): Promise<boolean> {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo) {
      return false;
    }

    try {
      // No need to sync before disconnect - periodic backups handle this
      // Sessions are already backed up every 30 minutes and after authentication
      
      if (clientInfo.client) {
        await clientInfo.client.close();
      }
      this.clients.delete(clientId);
      console.log(`✅ WPPConnect client ${clientId} disconnected successfully`);
      return true;
    } catch (error) {
      console.error(`❌ Error disconnecting WPPConnect client ${clientId}:`, error);
      return false;
    }
  }

  public getClient(clientId: string): WPPConnectClientInfo | undefined {
    return this.clients.get(clientId);
  }

  public getAllClients(): WPPConnectClientInfo[] {
    return Array.from(this.clients.values());
  }

  public addMessageHandler(handler: (clientId: string, message: any) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  public async restoreExistingSessions(): Promise<void> {
    if (!this.tokenStore) {
      throw new Error('TokenStore not initialized');
    }

    try {
      // First, clean up any broken sessions before attempting restoration
      await this.cleanupAllBrokenSessions();
      
      // Get list of browser sessions from MongoDB GridFS
      const sessions = await listBrowserSessionsInMongo();
      console.log(`📋 Found ${sessions.length} existing browser sessions in MongoDB GridFS`);

      for (const clientId of sessions) {
        console.log(`🔄 Restoring browser session for client: ${clientId}`);
        
        try {
          await this.createClient(clientId);
          // Add delay between client creations to prevent race conditions
          await new Promise(resolve => setTimeout(resolve, 3000));
          console.log(`✅ Successfully restored session for client: ${clientId}`);
        } catch (error) {
          console.error(`❌ Failed to restore session for client ${clientId}:`, error);
        }
      }

      console.log('✅ WPPConnect session restoration completed');
    } catch (error) {
      console.error('❌ Error restoring WPPConnect sessions:', error);
      throw error;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckIntervalMs || 300000); // 5 minutes default

    console.log(`🏥 WPPConnect health check started with ${this.config.healthCheckIntervalMs || 300000}ms interval`);
  }

  /**
   * Periodic session backup to MongoDB
   * Backs up all active authenticated sessions every 30 minutes
   */
  private startPeriodicSessionBackup(): void {
    if (this.sessionBackupInterval) {
      clearInterval(this.sessionBackupInterval);
    }

    const backupIntervalMs = 30 * 60 * 1000; // 30 minutes
    
    this.sessionBackupInterval = setInterval(async () => {
      console.log('🔄 Starting periodic session backup to MongoDB...');
      let backedUp = 0;
      
      for (const [clientId, clientInfo] of this.clients.entries()) {
        // Only backup authenticated, ready clients
        if (clientInfo.isReady && clientInfo.status === 'ready') {
          try {
            const uploaded = await uploadBrowserSessionToMongo(clientId);
            if (uploaded) {
              backedUp++;
              console.log(`✅ Periodic backup completed for ${clientId}`);
            }
          } catch (error) {
            console.error(`❌ Periodic backup failed for ${clientId}:`, error);
          }
        }
      }
      
      console.log(`🔄 Periodic session backup completed: ${backedUp} sessions backed up`);
    }, backupIntervalMs);

    console.log(`💾 Periodic session backup started (every 30 minutes)`);
  }

  private async performHealthCheck(): Promise<void> {
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.isReady) {
          // Test if client is still responsive
          const isConnected = await clientInfo.client.isConnected();
          if (!isConnected) {
            console.log(`⚠️ WPPConnect client ${clientId} is not connected, marking as disconnected`);
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
        }
      } catch (error) {
        console.error(`⚠️ Health check failed for WPPConnect client ${clientId}:`, error);
        clientInfo.status = 'error';
        clientInfo.isReady = false;
      }
    }
  }

  public isHealthy(): boolean {
    const readyClients = Array.from(this.clients.values()).filter(client => client.isReady);
    return readyClients.length > 0;
  }

  public getHealthStatus(): any {
    const clients = Array.from(this.clients.values());
    const readyClients = clients.filter(client => client.isReady);
    const errorClients = clients.filter(client => client.status === 'error');

    return {
      totalClients: clients.length,
      readyClients: readyClients.length,
      errorClients: errorClients.length,
      isHealthy: readyClients.length > 0,
      clients: clients.map(client => ({
        clientId: client.clientId,
        status: client.status,
        isReady: client.isReady,
        hasQrCode: !!client.qrCode,
        phoneNumber: client.phoneNumber,
        lastActivity: client.lastActivity
      }))
    };
  }

  /**
   * Clean up all broken sessions in MongoDB during startup
   * This scans all sessions and removes any that are corrupted or invalid
   */
  private async cleanupAllBrokenSessions(): Promise<void> {
    try {
      console.log(`🧹 Starting cleanup of all broken sessions...`);
      
      if (!this.standaloneTokenStore) {
        console.log(`⚠️  No tokenStore available for session cleanup`);
        return;
      }

      const sessions = await this.standaloneTokenStore.listTokens();
      console.log(`📋 Found ${sessions.length} sessions to check for corruption`);

      for (const clientId of sessions) {
        try {
          const sessionToken = await this.standaloneTokenStore.getToken(clientId);
          
          if (!sessionToken || Object.keys(sessionToken).length === 0) {
            console.log(`🗑️  Detected broken/empty session for ${clientId} - cleaning up`);
            await this.standaloneTokenStore.removeToken(clientId);
            console.log(`✅ Cleaned up broken session for ${clientId}`);
          } else {
            console.log(`✅ Session for ${clientId} appears valid (${Object.keys(sessionToken).length} keys)`);
          }
        } catch (error) {
          console.error(`❌ Error checking session ${clientId}, attempting cleanup:`, error);
          try {
            await this.standaloneTokenStore.removeToken(clientId);
            console.log(`🧹 Cleaned up potentially broken session for ${clientId} due to error`);
          } catch (cleanupError) {
            console.error(`❌ Failed to cleanup session ${clientId}:`, cleanupError);
          }
        }
      }
      
      console.log(`✅ Broken session cleanup completed`);
    } catch (error) {
      console.error(`❌ Error during broken session cleanup:`, error);
    }
  }

  /**
   * Detect and clean up broken sessions in MongoDB
   * This handles cases where a session exists in MongoDB but is corrupted or invalid
   */
  private async detectAndCleanupBrokenSession(clientId: string): Promise<void> {
    try {
      console.log(`🔍 Checking for broken session: ${clientId}`);
      
      if (!this.tokenStore) {
        console.log(`⚠️  No tokenStore available for session check`);
        return;
      }

      // Check if session exists in MongoDB
      const sessionToken = await this.standaloneTokenStore.getToken(clientId);
      
      if (sessionToken) {
        console.log(`📋 Found existing session in MongoDB for ${clientId}`);
        
        if (!sessionToken || Object.keys(sessionToken).length === 0) {
          console.log(`🗑️  Detected broken/empty session for ${clientId} - cleaning up`);
          await this.standaloneTokenStore.removeToken(clientId);
          console.log(`✅ Cleaned up broken session for ${clientId}`);
        } else {
          // Additional validation: check if session has required WhatsApp keys
          const requiredKeys = ['WANoiseInfo', 'WAWebEncKeySalt', 'WALid', 'WABrowserId', 'WAToken1', 'WAToken2'];
          const hasValidKeys = requiredKeys.some(key => (sessionToken as any)[key]);
          
          if (!hasValidKeys) {
            console.log(`🗑️  Detected session with invalid keys for ${clientId} - cleaning up`);
            await this.standaloneTokenStore.removeToken(clientId);
            console.log(`✅ Cleaned up session with invalid keys for ${clientId}`);
          } else {
            console.log(`✅ Session for ${clientId} appears valid (${Object.keys(sessionToken).length} keys)`);
          }
        }
      } else {
        console.log(`📋 No existing session found in MongoDB for ${clientId}`);
      }
    } catch (error) {
      console.error(`❌ Error checking/cleaning session for ${clientId}:`, error);
      // If there's an error checking the session, try to clean it up anyway
      try {
        if (this.tokenStore) {
          await this.standaloneTokenStore.removeToken(clientId);
          console.log(`🧹 Cleaned up potentially broken session for ${clientId} due to error`);
        }
      } catch (cleanupError) {
        console.error(`❌ Error during cleanup for ${clientId}:`, cleanupError);
      }
    }
  }


  /**
   * Force cleanup of a specific client session from MongoDB and local files
   * This can be used to manually clean up stuck sessions
   */
  public async forceCleanupSession(clientId: string): Promise<boolean> {
    try {
      console.log(`🧹 Force cleaning up session for ${clientId}`);
      
      if (!this.tokenStore) {
        console.log(`⚠️  No tokenStore available for force cleanup`);
        return false;
      }

      // Remove from active clients map if present
      if (this.clients.has(clientId)) {
        const clientInfo = this.clients.get(clientId);
        if (clientInfo && clientInfo.client) {
          try {
            await clientInfo.client.close();
            console.log(`✅ Closed active client ${clientId}`);
          } catch (error) {
            console.error(`⚠️  Error closing client ${clientId}:`, error);
          }
        }
        this.clients.delete(clientId);
        console.log(`🗑️  Removed ${clientId} from active clients map`);
      }

      // Remove from MongoDB GridFS
      const removed = await deleteBrowserSessionFromMongo(clientId);
      if (removed) {
        console.log(`✅ Force cleaned up browser session for ${clientId} from MongoDB GridFS`);
        return true;
      } else {
        console.log(`⚠️  Browser session ${clientId} was not found in MongoDB GridFS`);
        return true; // Still return true since we attempted cleanup
      }
    } catch (error) {
      console.error(`❌ Error force cleaning session for ${clientId}:`, error);
      return false;
    }
  }

  public async cleanup(): Promise<void> {
    console.log('🔄 Starting graceful shutdown...');
    console.log('ℹ️  Sessions preserved in MongoDB (periodic backups ensure latest state)');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    if (this.sessionBackupInterval) {
      clearInterval(this.sessionBackupInterval);
    }

    // NO sync during shutdown - sessions are already backed up via periodic backups (every 30 min)
    // and after authentication. Syncing here only delays restart without benefit.
    console.log(`✅ Skipping session sync during shutdown (already backed up periodically)`);

    // Disconnect all clients
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.client) {
          await clientInfo.client.close();
        }
        console.log(`✅ WPPConnect client ${clientId} disconnected successfully`);
      } catch (error) {
        console.error(`❌ Error disconnecting WPPConnect client ${clientId}:`, error);
      }
    }

    this.clients.clear();

    if (this.tokenStore) {
        // Standalone TokenStore doesn't need explicit disconnection
    }
  }

  /**
   * Manually sync a specific client's session to MongoDB GridFS
   * Useful for forcing a backup of a session
   */
  public async syncSessionToMongo(clientId: string): Promise<boolean> {
    try {
      const clientInfo = this.clients.get(clientId);
      if (!clientInfo) {
        console.log(`⚠️  Client ${clientId} not found`);
        return false;
      }

      if (!clientInfo.isReady || clientInfo.status !== 'ready') {
        console.log(`⚠️  Client ${clientId} is not ready for sync (status: ${clientInfo.status})`);
        return false;
      }

      console.log(`🔄 Manually syncing session to MongoDB for ${clientId}...`);
      const uploaded = await uploadBrowserSessionToMongo(clientId);
      
      if (uploaded) {
        console.log(`✅ Successfully synced session to MongoDB for ${clientId}`);
        return true;
      } else {
        console.error(`❌ Failed to sync session to MongoDB for ${clientId}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error syncing session for ${clientId}:`, error);
      return false;
    }
  }
}

export default WPPConnectClientManager;
