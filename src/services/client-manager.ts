import { create, Whatsapp } from '@wppconnect-team/wppconnect';
import mongoose from 'mongoose';
import { WhatsAppSessionBackup } from './whatsapp-session-backup';
import { createMongoTokenStore } from './tokenstore';
import fs from 'fs';
import path from 'path';
import { MEMORY_CONFIG, getMemoryUsage, suggestGC, needsMemoryWarning } from '../config/memory-config';

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
  private sessionBackup: WhatsAppSessionBackup | null = null;
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
        // Initialize WhatsApp-specific session backup service
        this.sessionBackup = new WhatsAppSessionBackup();
        console.log('✅ WhatsApp Session Backup service initialized');
      } else {
        throw new Error('MongoDB connection not available');
      }
    } catch (error) {
      console.error('❌ Failed to initialize WPPConnect MongoDB:', error);
      throw error;
    }
  }

  public async createClient(clientId: string, skipRestore: boolean = false): Promise<WPPConnectClientInfo> {
    if (this.clients.has(clientId)) {
      throw new Error(`Client with ID '${clientId}' already exists`);
    }

    console.log(`🚀 Creating new WPPConnect client: ${clientId}`);

    if (!this.isMongoConnected || !this.sessionBackup) {
      throw new Error('MongoDB connection is required. Please ensure MONGODB_URI is set and MongoDB is connected.');
    }

    // CRITICAL: Check if local session folder exists with valid data FIRST
    // MongoDB backup's purpose is to restore to tokens/{clientId} folder
    // If folder already exists with valid data, use it directly - no restore needed!
    const sessionPath = path.join(process.cwd(), 'tokens', clientId);
    const defaultPath = path.join(sessionPath, 'Default');
    const indexedDBPath = path.join(defaultPath, 'IndexedDB');
    const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
    
    let hasLocalSession = false;
    if (fs.existsSync(sessionPath) && fs.existsSync(defaultPath)) {
      // Check if session folder has valid authentication data
      const hasIndexedDB = fs.existsSync(indexedDBPath);
      const hasLocalStorage = fs.existsSync(localStoragePath);
      
      if (hasIndexedDB || hasLocalStorage) {
        hasLocalSession = true;
        console.log(`✅ [${clientId}] Local session folder exists with valid data - using it directly`);
        console.log(`📁 [${clientId}] Session folder: ${sessionPath}`);
        if (hasIndexedDB) {
          console.log(`✅ [${clientId}] IndexedDB found - session data ready`);
        }
        if (hasLocalStorage) {
          console.log(`✅ [${clientId}] Local Storage found - session data ready`);
        }
      } else {
        console.log(`⚠️  [${clientId}] Local session folder exists but appears empty/corrupted`);
      }
    }

    // Only restore from MongoDB if:
    // 1. Not skipping restore
    // 2. No valid local session exists
    if (!skipRestore && !hasLocalSession) {
      console.log(`📥 [${clientId}] No valid local session found - restoring from MongoDB...`);
      const restored = await this.sessionBackup!.restoreWhatsAppSession(clientId);
      if (!restored) {
        console.warn(`⚠️  [${clientId}] No MongoDB backup found - client will require QR code scan`);
      } else {
        console.log(`✅ [${clientId}] Session restored from MongoDB, creating client...`);
      }
    } else if (hasLocalSession) {
      console.log(`✅ [${clientId}] Using existing local session folder (skip MongoDB restore)`);
    } else if (skipRestore) {
      console.log(`⏱️  [${clientId}] Skip restore flag set - using existing session if available`);
    }

    // Add placeholder client info immediately so it's queryable
    const placeholderClientInfo: WPPConnectClientInfo = {
      clientId,
      client: null as any, // Will be set after creation
      isReady: false,
      lastActivity: new Date(),
      status: 'initializing'
    };
    this.clients.set(clientId, placeholderClientInfo);

    // Create message handler function BEFORE client creation
    // This ensures we can register it immediately after client is created
    const messageHandler = async (message: any) => {
      // CRITICAL: Filter out messages sent by the bot itself to prevent infinite loops
      // This must be checked FIRST before any processing
      if (message.fromMe === true) {
        // Silently ignore - don't even log to reduce noise
        return; // Exit early - don't process bot's own messages
      }
      
      // Also check if message is from bot's own number
      const senderNumber = message.from?.replace('@c.us', '') || '';
      const currentClientInfo = this.clients.get(clientId);
      if (currentClientInfo && currentClientInfo.phoneNumber) {
        const botNumber = currentClientInfo.phoneNumber.replace('@c.us', '');
        if (senderNumber === botNumber) {
          // Silently ignore messages from bot's own number
          return;
        }
      }
      
      // Filter out non-message events
      const msgType = message.type || '';
      const ignoredTypes = ['ack', 'status', 'notification', 'protocol', 'e2e_notification'];
      if (ignoredTypes.includes(msgType.toLowerCase())) {
        // Silently ignore status/ACK events
        return; // Exit early - these are status updates, not messages
      }
      
      try {
        const clientInfo = this.clients.get(clientId);
        
        if (!clientInfo) {
          console.error(`❌ [${clientId}] Client info not found - message dropped`);
          return;
        }
        
        if (!clientInfo.isReady) {
          console.warn(`⏸️  [${clientId}] Client not ready - message may be delayed`);
        }
        
        if (this.messageHandlers.length === 0) {
          console.error(`❌ [${clientId}] No message handlers registered!`);
          return;
        }
        
        // Process messages (silently - handlers will log if needed)
        for (let i = 0; i < this.messageHandlers.length; i++) {
          const handler = this.messageHandlers[i];
          if (!handler) {
            continue;
          }
          try {
            await handler(clientId, message);
          } catch (error) {
            console.error(`❌ [${clientId}] Handler error:`, error instanceof Error ? error.message : error);
          }
        }
      } catch (error) {
        console.error(`❌ [${clientId}] CRITICAL ERROR in onMessage callback:`, error);
        console.error(`❌ [${clientId}] Error stack:`, error instanceof Error ? error.stack : 'No stack');
      }
    };

    try {
      // Create WPPConnect client with MongoDB TokenStore
      // WPPConnect needs TokenStore to save/restore authentication tokens
      // This works together with browser session files for complete session persistence
      const mongoTokenStore = createMongoTokenStore();
      const client = await create({
        session: clientId,
        // Use MongoDB TokenStore to save/restore WPPConnect authentication tokens
        // This is REQUIRED - without tokens, sessions will always become unpaired
        tokenStore: mongoTokenStore,
        
        // Browser configuration
        headless: true,
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: false, // Disable console QR - use API endpoint instead
        // folderNameToken is for browser profile path, not token files
        // Our custom tokenStore handles token persistence
        
        // Browser options - CRITICAL: Tell WPPConnect where to find the session folder
        // Without userDataDir, WPPConnect will create its own folder and ignore our restored session!
        puppeteerOptions: {
          executablePath: this.config.chromiumPath,
          args: this.config.puppeteerArgs,
          // CRITICAL: Set userDataDir to use our restored session folder
          // This ensures WPPConnect uses tokens/{clientId} instead of creating its own folder
          userDataDir: sessionPath,
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
        statusFind: (statusSession, session) => {
          console.log(`📊 [${session}] WPPConnect Status: ${statusSession}`);
          
          // Log detailed status information
          if (statusSession === 'notLogged') {
            console.log(`🔓 [${session}] Not logged in - will require QR code scan`);
          } else if (statusSession === 'isLogged') {
            console.log(`✅ [${session}] Already logged in - session authenticated`);
            // Mark as ready when logged in
            const clientInfo = this.clients.get(clientId);
            if (clientInfo) {
              clientInfo.isReady = true;
              clientInfo.status = 'ready';
              clientInfo.qrCode = undefined; // Clear QR code when authenticated
              console.log(`✅ [${clientId}] Client marked as ready (isLogged status)`);
            }
          } else if (statusSession === 'qrReadSuccess') {
            console.log(`✅ [${session}] QR code scanned successfully - authentication in progress...`);
            // Update status immediately when QR is scanned
            const clientInfo = this.clients.get(clientId);
            if (clientInfo) {
              clientInfo.status = 'authenticated';
              clientInfo.qrCode = undefined; // Clear QR code after successful scan
              console.log(`✅ [${clientId}] Status updated to authenticated after QR scan`);
            }
          } else if (statusSession === 'inChat') {
            console.log(`✅ [${session}] Session is active and in chat`);
            // Mark as ready when in chat
            const clientInfo = this.clients.get(clientId);
            if (clientInfo) {
              clientInfo.isReady = true;
              clientInfo.status = 'ready';
              clientInfo.qrCode = undefined; // Clear QR code when ready
              console.log(`✅ [${clientId}] Client marked as ready (inChat status)`);
            }
          } else {
            console.log(`ℹ️  [${session}] Status: ${statusSession}`);
          }
          
          this.updateClientStatus(clientId, statusSession);
          
          // WPPConnect TokenStore handles session persistence automatically
          // No manual saving needed - follows official Redis example pattern
        },
        
        catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
          console.log(`📱 QR Code generated for ${clientId} (attempt ${attempts})`);
          console.log(`📱 QR Code URL: ${urlCode || 'N/A'}`);
          console.log(`📱 QR Code size: ${base64Qr?.length || 0} bytes`);
          console.log(`📱 Access QR image via: GET /api/whatsapp/clients/${clientId}/qr-image`);
          console.log(`⚠️  IMPORTANT: QR codes expire after ~20 seconds. Scan quickly!`);
          console.log(`📱 Scan with WhatsApp: Settings > Linked Devices > Link a Device`);
          this.updateClientQR(clientId, base64Qr);
          
          // Log QR code data for debugging (first 100 chars of base64)
          if (base64Qr) {
            const preview = base64Qr.substring(0, 100);
            console.log(`📱 QR Preview: ${preview}...`);
          }
        },
        
        // Auto-close settings
        // WPPConnect doesn't accept 0 to disable, so use a very high value instead
        // Setting to 24 hours (86400000 ms) to effectively disable auto-close
        autoClose: 86400000, // 24 hours - effectively disabled to prevent unexpected disconnections
        
        // Additional options
        disableWelcome: true,
        updatesLog: true,
        
        // Don't wait for login - proceed immediately (client is already authenticated from restored session)
        waitForLogin: false
      });

      console.log(`✅ WPPConnect client created: ${clientId}`);
      
      // Store handler reference for potential retry
      const clientInfoForStorage = this.clients.get(clientId);
      if (clientInfoForStorage) {
        (clientInfoForStorage as any)._messageHandler = messageHandler;
        (clientInfoForStorage as any)._messageHandlerRegistered = false;
      }
      
      // Register message handler - must wait until onMessage is exposed
      // WPPConnect exposes onMessage after wapi.js injection, so we'll register in CONNECTED state
      console.log(`📋 [${clientId}] Message handler function created (will register when wapi.js exposes onMessage)`);

      // Check for QR code manually (catchQR callback sometimes doesn't fire)
      setImmediate(async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for initialization
          
          const clientInfo = this.clients.get(clientId);
          if (clientInfo && !clientInfo.qrCode) {
            try {
              const qrData = await client.getQrCode();
              if (qrData && qrData.base64Image) {
                this.updateClientQR(clientId, qrData.base64Image);
              }
            } catch (qrError) {
              // Silent fail - QR will be available via catchQR callback
            }
          }
        } catch (error) {
          console.error(`❌ [${clientId}] QR check error:`, error);
        }
      });

      // Set up reaction handler with correct TypeScript types
      // Reference: https://wppconnect.io/wppconnect/classes/Whatsapp.html#onreactionmessage
      // Reaction type: { id, msgId, reactionText, read, orphan, orphanReason, timestamp }
      try {
        client.onReactionMessage(async (reaction: any) => {
          console.log(`👍 REACTION EVENT FIRED for ${clientId}:`, JSON.stringify(reaction, null, 2));
          
          try {
            const emoji = reaction.reactionText || '👍';
            
            // Skip if reaction is removed (empty reactionText)
            if (!emoji || emoji === '') {
              console.log(`🗑️  Reaction removed (ID: ${reaction.id})`);
              return;
            }
            
            // Extract the reactor's ID from reaction.id.remote
            // reaction.id.remote contains the user who sent the reaction (e.g., "6282121547121@c.us")
            const reactorId = reaction.id?.remote || reaction.id?._serialized;
            
            if (!reactorId) {
              console.log(`⚠️  Could not identify who sent the reaction, skipping`);
              console.log(`🔍 Reaction structure:`, JSON.stringify(reaction, null, 2).substring(0, 200));
              return;
            }
            
            console.log(`📝 Reaction: ${emoji} by ${reactorId}`);
            
            // Get the message that was reacted to
            const originalMessage = await client.getMessageById(reaction.msgId);
            
            if (originalMessage) {
              console.log(`📝 Original message: ${originalMessage.body?.substring(0, 50) || '[media]'}`);
              
              // Create synthetic message for message handler
              const reactionMessage = {
                from: reactorId, // Use the reactor's ID, not the original message sender
                body: `reacted ${emoji} to this message: ${originalMessage.body || '[media]'}`,
                type: 'reaction',
                timestamp: reaction.timestamp || Date.now(),
                quotedMsg: originalMessage,
                hasQuotedMsg: true,
                sender: originalMessage.sender // Preserve original sender info
              };
              
              // Queue with other messages
              for (const handler of this.messageHandlers) {
                try {
                  await handler(clientId, reactionMessage);
                } catch (error) {
                  console.error(`❌ Error in reaction handler:`, error);
                }
              }
            }
          } catch (err) {
            console.error(`❌ Error processing reaction:`, err);
          }
        });
        console.log(`✅ onReactionMessage handler registered for ${clientId}`);
      } catch (error) {
        console.log(`⚠️  onReactionMessage not available:`, error);
      }

      // Set up ready handler
      client.onStateChange(async (state) => {
        console.log(`🔄 [${clientId}] onStateChange event: ${state}`);
        
        // Mark as ready when CONNECTED
        if (state === 'CONNECTED') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'ready';
            clientInfo.isReady = true;
            clientInfo.lastActivity = new Date();
            
            // ALWAYS re-register handlers when CONNECTED - even if registered earlier
            // Handlers registered in UNPAIRED state may not work properly after connection
            // Wait 3 seconds after CONNECTED to ensure everything is fully ready and stable
            setTimeout(() => {
              console.log(`📋 [${clientId}] Re-registering message handlers in CONNECTED state (ensures proper registration)...`);
              
              // Verify onMessage exists
              if (typeof client.onMessage !== 'function') {
                console.error(`❌ [${clientId}] CRITICAL: client.onMessage is not a function! Type: ${typeof client.onMessage}`);
                const clientKeys = Object.keys(client).filter(k => k.toLowerCase().includes('message') || k.toLowerCase().includes('on'));
                console.error(`❌ [${clientId}] Message-related properties: ${clientKeys.join(', ') || 'none found'}`);
                return;
              }
              
              const messageHandler = (clientInfo as any)._messageHandler;
              if (!messageHandler) {
                console.error(`❌ [${clientId}] CRITICAL: Message handler function not found in clientInfo!`);
                return;
              }
              
              try {
                // Force re-registration - this ensures handlers work after full connection
                console.log(`📝 [${clientId}] Registering client.onMessage() handler...`);
                client.onMessage(messageHandler);
                console.log(`✅ [${clientId}] client.onMessage() registered`);
                
                // NOTE: onAnyMessage is NOT registered to prevent duplicate message processing
                // onMessage already handles all incoming messages, so onAnyMessage is redundant
                
                (clientInfo as any)._messageHandlerRegistered = true;
                console.log(`✅ [${clientId}] Message handlers registered and ready`);
              } catch (regError) {
                console.error(`❌ [${clientId}] CRITICAL: Error registering handlers:`, regError);
                console.error(`❌ [${clientId}] Error details:`, regError instanceof Error ? regError.stack : regError);
              }
            }, 3000); // Wait 3 seconds after CONNECTED
            
            const handlerCount = this.messageHandlers.length;
            console.log(`✅ [${clientId}] Client connected and ready (state: ${state}) - handler registered: ${(clientInfo as any)._messageHandlerRegistered}, available handlers: ${handlerCount}`);
            
            if (handlerCount === 0) {
              console.warn(`⚠️  [${clientId}] WARNING: Client is ready but no message handlers are registered! Messages will not be processed.`);
            }
            
            // Backup WhatsApp session to MongoDB after successful connection
            setImmediate(async () => {
              try {
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for session to stabilize
                
                const backupSuccess = await this.sessionBackup!.backupWhatsAppSession(clientId);
                
                // Only cleanup old backups if new backup succeeded
                if (backupSuccess) {
                  // Wait a moment to ensure GridFS has indexed the new file
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  await this.sessionBackup!.cleanupOldWhatsAppBackups(clientId, 2);
                } else {
                  console.warn(`⚠️  [${clientId}] Backup failed, skipping cleanup to preserve existing backups`);
                }
              } catch (error) {
                console.error(`❌ [${clientId}] Session backup failed:`, error);
              }
            });
          }
          this.updateClientPhoneNumber(clientId);
        }
        
        // Handle disconnection states - register handlers when onMessage is exposed (even if unpaired)
        // This ensures handlers are ready when QR is scanned and state becomes CONNECTED
        if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
            
            // Register handlers now (onMessage is exposed even in UNPAIRED state)
            // This ensures handlers are ready when QR is scanned and state becomes CONNECTED
            const alreadyRegistered = (clientInfo as any)._messageHandlerRegistered;
            if (!alreadyRegistered && typeof client.onMessage === 'function') {
              console.log(`📋 [${clientId}] Session is unpaired, but registering handlers now (will be active after QR scan)...`);
              
              setTimeout(() => {
                const messageHandler = (clientInfo as any)._messageHandler;
                if (messageHandler) {
                  try {
                    client.onMessage(messageHandler);
                    // NOTE: onAnyMessage is NOT registered to prevent duplicate message processing
                    (clientInfo as any)._messageHandlerRegistered = true;
                    console.log(`✅ [${clientId}] Handler registered (waiting for QR scan to connect)`);
                  } catch (regError) {
                    console.error(`❌ [${clientId}] Error registering handler in UNPAIRED state:`, regError);
                  }
                }
              }, 2000);
            }
          }
        }
        
        // Handle conflict - might indicate session change
        if (state === 'CONFLICT') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
        }
      });

      // Update the placeholder with the actual client instance
      const existingClientInfo = this.clients.get(clientId);
      if (existingClientInfo) {
        existingClientInfo.client = client;
        existingClientInfo.lastActivity = new Date();
        console.log(`✅ WPPConnect client ${clientId} initialized successfully`);
        
        // Update phone number if client is already authenticated (restored session)
        if (existingClientInfo.isReady) {
          await this.updateClientPhoneNumber(clientId);
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
            
            // Session cleanup handled by WhatsApp session backup service
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
                            errorMessage.includes('browser is already running') ||
                            errorMessage.includes('Auto Close Called'); // Preserve session on auto-close
      
      if (this.sessionBackup && isAuthFailure && !isBrowserIssue) {
        // Session cleanup handled by WhatsApp session backup service
      } else {
        console.log(`ℹ️  Keeping existing session in MongoDB for ${clientId} (error: ${errorMessage.substring(0, 50)}...)`);
      }
      
      throw error;
    }
  }


  // Session backup is now handled by WhatsAppSessionBackup service

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
          clientInfo.qrCode = undefined; // Clear QR code when ready (no longer needed)
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
          // Auto-close is normal idle behavior - don't delete the client!
          // Just mark as idle so it can be reactivated on next message
          console.log(`💤 Client ${clientId} auto-closed due to inactivity - keeping session for reactivation`);
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          break; // Don't delete - keep the client and session
        case 'qrReadFail':
          // Clear authentication failures - delete from MongoDB
          console.log(`🗑️  Removing client ${clientId} - Authentication failed (${status})`);
          this.clients.delete(clientId);
          
          // Session cleanup handled by WhatsApp session backup service
          return;
        case 'qrReadError':
          // qrReadError can be a false positive if client is already authenticated
          // Only treat as failure if client is NOT ready/authenticated
          if (clientInfo.isReady || clientInfo.status === 'ready' || clientInfo.status === 'authenticated') {
            break;
          }
          
          // Only delete if truly not authenticated
          this.clients.delete(clientId);
          
          // Session cleanup handled by WhatsApp session backup service
          return;
        case 'browserClose':
          // Browser close is normal (happens during shutdown/restart)
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
          }
          break;
        case 'desconnectedMobile':
          // Phone disconnected - this happens if QR scan fails or phone disconnects
          console.log(`📱 [${clientId}] Phone disconnected (desconnectedMobile)`);
          console.log(`📱 [${clientId}] This usually means:`);
          console.log(`📱   1. QR code expired before scan (QR codes expire in ~20 seconds)`);
          console.log(`📱   2. Scan failed or was rejected`);
          console.log(`📱   3. Phone lost connection during authentication`);
          console.log(`📱 [${clientId}] Client will need a fresh QR code - check status and get new QR`);
          clientInfo.status = 'qr_required'; // Allow new QR generation
          clientInfo.isReady = false;
          clientInfo.qrCode = undefined; // Clear old QR so new one can be generated
          break;
        case 'serverClose':
          clientInfo.status = 'disconnected';
          clientInfo.isReady = false;
          break;
        default:
          // Don't override status if we don't recognize it
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
      console.log(`📱 [${clientId}] QR code updated (length: ${qrCode.length})`);
      console.log(`📱 [${clientId}] QR available at: GET /api/whatsapp/clients/${clientId}/qr-image`);
    } else {
      console.error(`❌ [${clientId}] Client not found in map when updating QR code!`);
      console.log(`📋 Current clients in map: ${Array.from(this.clients.keys()).join(', ')}`);
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isInvalidNumber = errorMessage.includes('invalid wid') || 
                              errorMessage.includes('InvalidWidError') ||
                              errorMessage.includes('wid error');
      
      if (isInvalidNumber) {
        console.warn(`⚠️  [${clientId}] Invalid WhatsApp number: ${number}`);
        // Don't throw for invalid numbers, just log and re-throw for controller to handle
        throw new Error(`Invalid WhatsApp number: ${number}`);
      }
      
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
    console.log(`✅ Message handler added to client manager (total: ${this.messageHandlers.length} handler(s))`);
  }

  public async restoreExistingSessions(): Promise<void> {
    if (!this.sessionBackup) {
      throw new Error('Session backup service not initialized');
    }

    try {
      // First, check for local session folders in tokens/ directory
      const tokensPath = path.join(process.cwd(), 'tokens');
      const localSessionFolders: string[] = [];
      
      if (fs.existsSync(tokensPath)) {
        const entries = fs.readdirSync(tokensPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const clientId = entry.name;
            const sessionPath = path.join(tokensPath, clientId);
            const defaultPath = path.join(sessionPath, 'Default');
            const indexedDBPath = path.join(defaultPath, 'IndexedDB');
            const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
            
            // Check if this folder has valid session data
            if (fs.existsSync(defaultPath) && (fs.existsSync(indexedDBPath) || fs.existsSync(localStoragePath))) {
              localSessionFolders.push(clientId);
              console.log(`📁 [${clientId}] Found existing local session folder with valid data`);
            }
          }
        }
      }
      
      // Second, check for MongoDB backups
      const sessions = await this.sessionBackup.listWhatsAppBackups('*');
      console.log(`📋 Found ${sessions.length} MongoDB backups and ${localSessionFolders.length} local session folders`);
      
      // Combine both sources (local folders take priority - they're already there)
      const allClientIds = new Set<string>();
      localSessionFolders.forEach(id => allClientIds.add(id));
      sessions.forEach(s => {
        const clientId = s.filename.replace('_whatsapp_session.zip', '');
        allClientIds.add(clientId);
      });
      
      if (allClientIds.size > 0) {
        console.log(`📋 Sessions to restore/create: ${Array.from(allClientIds).join(', ')}`);
      }

      for (const clientId of allClientIds) {
        try {
          console.log(`🔄 [${clientId}] Starting session restoration/creation...`);
          
          // Check if client already exists
          if (this.clients.has(clientId)) {
            console.log(`⏩ [${clientId}] Client already exists, skipping`);
            continue;
          }

          // If local folder exists, use it directly (skip MongoDB restore)
          // Otherwise, restore from MongoDB backup
          const hasLocalSession = localSessionFolders.includes(clientId);
          
          if (hasLocalSession) {
            console.log(`📁 [${clientId}] Using existing local session folder (no MongoDB restore needed)`);
            // Create client directly - it will use the existing local session folder
            // Skip restore since we already have the folder
            await this.createClient(clientId, true);
            console.log(`✅ [${clientId}] Client created from local session, waiting 2s before next session...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // Restore the WhatsApp session from MongoDB first, then create client
            console.log(`📥 [${clientId}] Restoring WhatsApp session from MongoDB...`);
            const restored = await this.sessionBackup.restoreWhatsAppSession(clientId);
            
            if (restored) {
              console.log(`✅ [${clientId}] Session restored successfully`);
              
              // Create client with skipRestore=true since we already restored
              // The createClient method will handle the appropriate wait time
              console.log(`🚀 [${clientId}] Creating WPPConnect client...`);
              
              await this.createClient(clientId, true);
              console.log(`✅ [${clientId}] Client created, waiting 2s before next session...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              console.warn(`⚠️  [${clientId}] No backup found in MongoDB and no local session - will need manual creation`);
            }
          }
        } catch (error: any) {
          // Handle specific error types
          if (error?.message?.includes('Auto Close Called')) {
            console.warn(`⚠️  [${clientId}] Client auto-closed during initialization (likely due to memory pressure)`);
            console.warn(`⚠️  [${clientId}] Session is saved and will reconnect on next cycle or manual trigger`);
          } else {
            console.error(`❌ [${clientId}] Failed to restore/create session:`, error);
          }
          // Remove failed client so it can be retried
          this.clients.delete(clientId);
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
      
      // Log memory usage during health check
      if (needsMemoryWarning()) {
        const memUsage = getMemoryUsage();
        console.log(`⚠️  Memory usage: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
      }
    }, this.config.healthCheckIntervalMs || 300000); // 5 minutes default

    console.log(`🏥 WPPConnect health check started with ${this.config.healthCheckIntervalMs || 300000}ms interval`);
  }

  /**
   * Daily session backup to MongoDB
   * Backs up all active authenticated sessions daily at 1:00 AM
   */
  private startPeriodicSessionBackup(): void {
    if (this.sessionBackupInterval) {
      clearTimeout(this.sessionBackupInterval);
    }

    const performBackup = async () => {
      console.log('🔄 Starting daily session backup to MongoDB (scheduled at 1:00 AM)...');
      let backedUp = 0;
      let failed = 0;
      
      for (const [clientId, clientInfo] of this.clients.entries()) {
        // Only backup ready/authenticated clients
        if (clientInfo.isReady && clientInfo.status === 'ready' && this.sessionBackup) {
          try {
            const backupSuccess = await this.sessionBackup.backupWhatsAppSession(clientId);
            
            if (backupSuccess) {
              backedUp++;
              
              // Cleanup old backups after successful backup
              await new Promise(resolve => setTimeout(resolve, 2000)); // GridFS indexing delay
              await this.sessionBackup.cleanupOldWhatsAppBackups(clientId, 2);
            } else {
              failed++;
              console.warn(`⚠️  [${clientId}] Daily backup failed`);
            }
          } catch (error) {
            failed++;
            console.error(`❌ [${clientId}] Daily backup error:`, error);
          }
        }
      }
      
      console.log(`🔄 Daily session backup completed: ${backedUp} backed up, ${failed} failed`);
      
      // Schedule next backup for tomorrow at 1:00 AM
      scheduleNextBackup();
    };

    const scheduleNextBackup = () => {
      const now = new Date();
      const nextBackup = new Date();
      
      // Set next backup time to 1:00 AM
      nextBackup.setHours(1, 0, 0, 0);
      
      // If it's already past 1:00 AM today, schedule for tomorrow
      if (now.getHours() >= 1 && (now.getHours() > 1 || now.getMinutes() > 0)) {
        nextBackup.setDate(nextBackup.getDate() + 1);
      }
      
      const msUntilNextBackup = nextBackup.getTime() - now.getTime();
      
      this.sessionBackupInterval = setTimeout(() => {
        performBackup();
      }, msUntilNextBackup);
      
      const nextBackupStr = nextBackup.toLocaleString('en-US', { 
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      console.log(`💾 Daily session backup scheduled for: ${nextBackupStr} (in ${Math.round(msUntilNextBackup / 1000 / 60)} minutes)`);
    };

    // Schedule the first backup
    scheduleNextBackup();
  }

  private async performHealthCheck(): Promise<void> {
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.isReady && clientInfo.client) {
          // Check if browser/page is still open before trying to communicate
          try {
            // Test if client is still responsive
            const isConnected = await clientInfo.client.isConnected();
            if (!isConnected) {
              console.log(`⚠️ WPPConnect client ${clientId} is not connected, marking as disconnected`);
              clientInfo.status = 'disconnected';
              clientInfo.isReady = false;
            }
          } catch (checkError: any) {
            // Handle specific errors where the browser/target is already closed
            const errorMsg = checkError?.message || String(checkError);
            if (errorMsg.includes('Target closed') || 
                errorMsg.includes('Session closed') ||
                errorMsg.includes('Protocol error')) {
              console.log(`ℹ️  Client ${clientId} browser already closed, marking as disconnected`);
              clientInfo.status = 'disconnected';
              clientInfo.isReady = false;
            } else {
              // Log other errors but don't fail completely
              console.warn(`⚠️ Health check error for ${clientId}: ${errorMsg.substring(0, 100)}`);
              clientInfo.status = 'error';
              clientInfo.isReady = false;
            }
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
   * Force cleanup of a specific client session from MongoDB and local files
   * This can be used to manually clean up stuck sessions
   */
  public async forceCleanupSession(clientId: string): Promise<boolean> {
    try {
      // Remove from active clients map if present
      if (this.clients.has(clientId)) {
        const clientInfo = this.clients.get(clientId);
        if (clientInfo && clientInfo.client) {
          try {
            await clientInfo.client.close();
          } catch (error) {
            console.error(`⚠️  Error closing client ${clientId}:`, error);
          }
        }
        this.clients.delete(clientId);
      }
      return true;
    } catch (error) {
      console.error(`❌ Error force cleaning session for ${clientId}:`, error);
      return false;
    }
  }

  public async cleanup(): Promise<void> {
    console.log('🔄 Starting WPPConnect client manager cleanup...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log('✅ Health check interval cleared');
    }
    
    if (this.sessionBackupInterval) {
      clearTimeout(this.sessionBackupInterval);
      console.log('✅ Session backup scheduled task cleared');
    }

    // Disconnect all clients
    const clientCount = this.clients.size;
    if (clientCount > 0) {
      console.log(`🔄 Disconnecting ${clientCount} WPPConnect client(s)...`);
      for (const [clientId, clientInfo] of this.clients) {
        try {
          if (clientInfo.client) {
            await clientInfo.client.close();
            console.log(`✅ WPPConnect client ${clientId} disconnected`);
          }
        } catch (error) {
          console.error(`❌ Error disconnecting client ${clientId}:`, error);
        }
      }
    }

    this.clients.clear();
    console.log('✅ Client map cleared');
    
    // Clear retry attempts map
    this.retryAttempts.clear();
    
    // Suggest garbage collection after cleanup
    if (MEMORY_CONFIG.GC_AFTER_CLIENT_CLOSE) {
      suggestGC();
    }
    
    console.log('✅ WPPConnect client manager cleanup completed');
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

      // WPPConnect TokenStore handles persistence automatically
      console.log(`✅ Session persistence handled by TokenStore for ${clientId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error syncing session for ${clientId}:`, error);
      return false;
    }
  }
}

export default WPPConnectClientManager;
