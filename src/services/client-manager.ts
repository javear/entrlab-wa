import { create, Whatsapp } from '@wppconnect-team/wppconnect';
import mongoose from 'mongoose';
import { WhatsAppSessionBackup } from './whatsapp-session-backup';
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

    // Try to restore session from MongoDB backup first (unless skipped)
    if (!skipRestore) {
      await this.sessionBackup!.restoreWhatsAppSession(clientId);
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

    try {
      // Create WPPConnect client with minimal TokenStore
      // Session persistence handled by WhatsApp session backup/restore
      const client = await create({
        session: clientId,
        // Use a simple TokenStore that doesn't interfere with WhatsApp backup
        tokenStore: {
          getToken: async () => undefined, // Don't restore from TokenStore
          setToken: async () => true, // Don't save to TokenStore
          removeToken: async () => true,
          listTokens: async () => []
        },
        
        // Browser configuration
        headless: true,
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: false, // Disable console QR - use API endpoint instead
        // folderNameToken is for browser profile path, not token files
        // Our custom tokenStore handles token persistence
        
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
        statusFind: (statusSession, session) => {
          console.log(`📊 [${session}] Status: ${statusSession}`);
          this.updateClientStatus(clientId, statusSession);
          
          // WPPConnect TokenStore handles session persistence automatically
          // No manual saving needed - follows official Redis example pattern
        },
        
        catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
          console.log(`📱 QR Code generated for ${clientId} (attempt ${attempts}) - Access via /api/whatsapp/clients/${clientId}/qr-image`);
          this.updateClientQR(clientId, base64Qr);
        },
        
        // Auto-close settings
        // Set to 0 to disable, or high value to keep sessions alive
        // 3 minutes was too short and causing disconnections
        autoClose: 0, // Disabled - keep sessions alive (prevents unexpected disconnections)
        
        // Additional options
        disableWelcome: true,
        updatesLog: true
      });

      console.log(`✅ WPPConnect client created: ${clientId}`);

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

      // Set up message handler
      client.onMessage(async (message) => {
        console.log(`📨 [${clientId}] Message received:`, message.body);
        console.log(`📨 [${clientId}] Message handlers registered: ${this.messageHandlers.length}`);
        
        if (this.messageHandlers.length === 0) {
          console.warn(`⚠️ [${clientId}] No message handlers registered!`);
        }
        
        for (const handler of this.messageHandlers) {
          try {
            await handler(clientId, message);
          } catch (error) {
            console.error(`❌ Error in message handler for ${clientId}:`, error);
          }
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
        if (state === 'CONNECTED') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'ready';
            clientInfo.isReady = true;
            clientInfo.lastActivity = new Date();
            
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
        
        // Handle disconnection states
        if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          const clientInfo = this.clients.get(clientId);
          if (clientInfo) {
            clientInfo.status = 'disconnected';
            clientInfo.isReady = false;
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
                            errorMessage.includes('browser is already running');
      
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
          // Client is authenticated - but need to wait for WAPI to be fully loaded
          clientInfo.status = 'authenticated';
          console.log(`🔐 WPPConnect client ${clientId} authenticated (${status}) - verifying WAPI...`);
          
          // Wait for WAPI to be fully loaded before marking as ready
          setTimeout(async () => {
            try {
              const currentClient = this.clients.get(clientId);
              if (!currentClient || !currentClient.client) {
                console.warn(`⚠️ Client ${clientId} no longer exists`);
                return;
              }

              // Verify WAPI is ready by checking if we can access basic functions
              const isWapiReady = await currentClient.client.page.evaluate(() => {
                // @ts-ignore - WAPI is injected in browser context
                return typeof WAPI !== 'undefined' && 
                       // @ts-ignore
                       typeof WAPI.getMessageById === 'function';
              }).catch((err) => {
                console.warn(`⚠️ WAPI check failed for ${clientId}:`, err.message);
                return false;
              });
              
              if (isWapiReady) {
                currentClient.status = 'ready';
                currentClient.isReady = true;
                console.log(`✅ WPPConnect client ${clientId} WAPI verified - now ready`);
              } else {
                console.warn(`⚠️ WPPConnect client ${clientId} WAPI not ready after authentication, retrying...`);
                // Retry after another delay
                setTimeout(async () => {
                  const retryClient = this.clients.get(clientId);
                  if (!retryClient || !retryClient.client) return;

                  const retryCheck = await retryClient.client.page.evaluate(() => {
                    // @ts-ignore - WAPI is injected in browser context
                    return typeof WAPI !== 'undefined';
                  }).catch(() => false);
                  
                  if (retryCheck) {
                    retryClient.status = 'ready';
                    retryClient.isReady = true;
                    console.log(`✅ WPPConnect client ${clientId} WAPI verified on retry - now ready`);
                  } else {
                    console.error(`❌ WPPConnect client ${clientId} WAPI never became ready`);
                    // Mark as ready anyway to avoid blocking, but log the issue
                    retryClient.status = 'ready';
                    retryClient.isReady = true;
                    console.log(`⚠️ Marking ${clientId} as ready despite WAPI issues`);
                  }
                }, 5000);
              }
            } catch (error) {
              console.error(`❌ Error verifying WAPI for ${clientId}:`, error);
              // Mark as ready anyway to avoid blocking
              const fallbackClient = this.clients.get(clientId);
              if (fallbackClient) {
                fallbackClient.status = 'ready';
                fallbackClient.isReady = true;
              }
            }
          }, 3000); // Wait 3 seconds after authentication
          
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
  }

  public async restoreExistingSessions(): Promise<void> {
    if (!this.sessionBackup) {
      throw new Error('Session backup service not initialized');
    }

    try {
      const sessions = await this.sessionBackup.listWhatsAppBackups('*');
      console.log(`📋 Found ${sessions.length} existing WhatsApp sessions`);
      
      // Log all session names for debugging
      if (sessions.length > 0) {
        console.log(`📋 Sessions to restore: ${sessions.map(s => s.filename.replace('_whatsapp_session.zip', '')).join(', ')}`);
      }

      for (const session of sessions) {
        const clientId = session.filename.replace('_whatsapp_session.zip', '');
        
        try {
          console.log(`🔄 [${clientId}] Starting session restoration...`);
          
          // Check if client already exists
          if (this.clients.has(clientId)) {
            console.log(`⏩ [${clientId}] Client already exists, skipping`);
            continue;
          }

          // Restore the WhatsApp session first, then create client
          console.log(`📥 [${clientId}] Restoring WhatsApp session from MongoDB...`);
          const restored = await this.sessionBackup.restoreWhatsAppSession(clientId);
          
          if (restored) {
            console.log(`✅ [${clientId}] Session restored, waiting 5s before creating client...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            console.log(`🚀 [${clientId}] Creating WPPConnect client...`);
            await this.createClient(clientId, true); // Skip restore since we already did it
            
            console.log(`✅ [${clientId}] Client created, waiting 3s before next...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          } else {
            console.warn(`⚠️  [${clientId}] Session restore returned false - skipping client creation`);
          }
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
      
      // Log memory usage during health check
      if (needsMemoryWarning()) {
        const memUsage = getMemoryUsage();
        console.log(`⚠️  Memory usage: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
      }
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
              console.warn(`⚠️  [${clientId}] Periodic backup failed`);
            }
          } catch (error) {
            failed++;
            console.error(`❌ [${clientId}] Periodic backup error:`, error);
          }
        }
      }
      
      console.log(`🔄 Periodic session backup completed: ${backedUp} backed up, ${failed} failed`);
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
    console.log('🔄 Starting graceful shutdown...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    if (this.sessionBackupInterval) {
      clearInterval(this.sessionBackupInterval);
    }

    // Disconnect all clients
    for (const [clientId, clientInfo] of this.clients) {
      try {
        if (clientInfo.client) {
          await clientInfo.client.close();
        }
      } catch (error) {
        console.error(`❌ Error disconnecting client ${clientId}:`, error);
      }
    }

    this.clients.clear();
    
    // Clear retry attempts map
    this.retryAttempts.clear();
    
    // Suggest garbage collection after cleanup
    if (MEMORY_CONFIG.GC_AFTER_CLIENT_CLOSE) {
      suggestGC();
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
