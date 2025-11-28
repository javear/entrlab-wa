import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment, ChatMessage, WorkflowResponse, WorkflowMessageObject } from '../types';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import FormData from 'form-data';
import { MEMORY_CONFIG, getMemoryUsage, suggestGC } from '../config/memory-config';
import { UserPauseService } from '../services/user-pause.service';

// ============================================
// WPPConnect Message Handler
// ============================================

export class WPPConnectMessageHandler {
  // All maps now keyed by "clientId:senderNumber" for proper isolation
  private messageQueue: { [key: string]: Array<{ message: any; enhancedText?: string; mediaUrls?: string[]; timestamp: number }> } = {};
  private processingUsers: { [key: string]: number } = {};
  private readReceiptSent: { [key: string]: boolean } = {};
  private contactInfo: { [key: string]: any } = {}; // Store contact metadata
  private userPauseService: UserPauseService;
  private env: Environment;
  private tempDir: string;
  private readonly MAX_QUEUE_SIZE = MEMORY_CONFIG.MAX_QUEUE_SIZE;
  private readonly MAX_QUEUE_AGE = MEMORY_CONFIG.MAX_QUEUE_AGE;

  // Helper to create unique key per client+user
  private getUserKey(clientId: string, senderNumber: string): string {
    return `${clientId}:${senderNumber}`;
  }

  constructor(
    private whatsappService: WPPConnectWhatsAppService,
    env: Environment
  ) {
    this.env = env;
    this.tempDir = path.join(process.cwd(), 'temp');
    this.userPauseService = new UserPauseService();
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Start queue cleanup interval
    this.startQueueCleanup();
    
    // Start temp file cleanup interval
    this.startTempFileCleanup();
    
    // Clean up any existing temp files on startup
    this.cleanupTempFiles();
  }

  private startQueueCleanup(): void {
    // Clean up old messages based on memory config
    setInterval(() => {
      this.cleanupMessageQueue();
      
      // Log memory usage periodically
      const memUsage = getMemoryUsage();
      if (memUsage.heapUsagePercent > 70) {
        console.log(`⚠️  Memory usage: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
      }
    }, MEMORY_CONFIG.QUEUE_CLEANUP_INTERVAL);
  }

  private startTempFileCleanup(): void {
    // Clean up old temporary files based on memory config
    setInterval(() => {
      this.cleanupTempFiles();
      
      // Suggest garbage collection after cleanup
      suggestGC();
    }, MEMORY_CONFIG.TEMP_FILE_CLEANUP_INTERVAL);
  }

  private cleanupTempFiles(): void {
    try {
      if (!fs.existsSync(this.tempDir)) {
        return;
      }

      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      let cleanedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          const age = now - stats.mtime.getTime();
          
          // Delete files older than configured max age
          if (age > MEMORY_CONFIG.TEMP_FILE_MAX_AGE) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        } catch (error) {
          console.error(`⚠️ Error cleaning up temp file ${file}:`, error);
        }
      }

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} old temporary files`);
        
        // Force GC after cleaning temp files to free memory
        const { suggestGC } = require('../config/memory-config');
        suggestGC();
      }
    } catch (error) {
      console.error('❌ Error during temp file cleanup:', error);
    }
  }

  /**
   * Extract contact information from message sender
   */
  private extractContactInfo(message: any): {
    name: string;
    pushname: string;
    isBusiness: boolean;
    isEnterprise: boolean;
    verifiedName?: string;
  } {
    try {
      const sender = message.sender || {};
      
      return {
        name: sender.name || sender.pushname || 'WhatsApp User',
        pushname: sender.pushname || sender.name || 'WhatsApp User',
        isBusiness: sender.isBusiness || false,
        isEnterprise: sender.isEnterprise || false,
        verifiedName: sender.verifiedName || undefined
      };
    } catch (error) {
      return {
        name: 'WhatsApp User',
        pushname: 'WhatsApp User',
        isBusiness: false,
        isEnterprise: false
      };
    }
  }


  /**
   * Send read receipt with retry mechanism
   */
  private async sendReadReceipt(clientId: string, senderNumber: string, maxRetries: number = 3): Promise<boolean> {
    const chatId = `${senderNumber}@c.us`;
    
    console.log(`📖 Sending read receipt for sender ${senderNumber} (client: ${clientId})`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = this.whatsappService.getClient(clientId);
        
        if (!client || !client.isReady || !client.client) {
          console.log(`⚠️  Client not ready (attempt ${attempt}/${maxRetries}) - ready: ${client?.isReady}, hasClient: ${!!client?.client}`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // Exponential backoff
            continue;
          }
          return false;
        }
        
        // Ensure chat is loaded before marking as read
        try {
          await client.client.openChat(chatId);
          console.log(`📂 Opened chat for ${senderNumber}`);
        } catch (openError) {
          console.log(`⚠️  Could not open chat, proceeding anyway`);
        }
        
        // Small delay to ensure chat is loaded
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Mark all messages from this sender as read
        await client.client.sendSeen(chatId);
        console.log(`✅ sendSeen() executed for ${chatId}`);
        
        // Close chat to return to previous state
        try {
          await client.client.closeChat();
          console.log(`📂 Closed chat`);
        } catch (closeError) {
          // Silent fail
        }
        
        console.log(`✅ Read receipt sent for sender ${senderNumber}`);
        return true;
        
      } catch (error) {
        console.log(`⚠️  Read receipt attempt ${attempt}/${maxRetries} failed:`, error);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // Exponential backoff
        }
      }
    }
    
    console.error(`❌ Failed to send read receipt for ${senderNumber} after ${maxRetries} attempts`);
    return false;
  }

  /**
   * Send typing indicator with retry mechanism
   */
  private async sendTypingIndicator(clientId: string, senderNumber: string, start: boolean = true): Promise<boolean> {
    const chatId = `${senderNumber}@c.us`;
    
    console.log(`⌨️  ${start ? 'Starting' : 'Stopping'} typing indicator for ${senderNumber} (client: ${clientId})`);
    
    try {
      const client = this.whatsappService.getClient(clientId);
      
      if (!client || !client.isReady || !client.client) {
        console.log(`⚠️  Client not ready for typing indicator - ready: ${client?.isReady}, hasClient: ${!!client?.client}`);
        return false;
      }
      
      if (start) {
        await client.client.startTyping(chatId);
        console.log(`✅ Typing indicator started for ${senderNumber}`);
      } else {
        await client.client.stopTyping(chatId);
        console.log(`✅ Typing indicator stopped for ${senderNumber}`);
      }
      
      return true;
      
    } catch (error) {
      console.log(`⚠️  Typing indicator error:`, error);
      return false;
    }
  }

  private cleanupMessageQueue(): void {
    const now = Date.now();
    let totalCleaned = 0;

    for (const [userKey, messages] of Object.entries(this.messageQueue)) {
      // Remove old messages
      const validMessages = messages.filter(msg => {
        const age = now - msg.timestamp;
        return age < this.MAX_QUEUE_AGE;
      });

      // Limit queue size
      if (validMessages.length > this.MAX_QUEUE_SIZE) {
        validMessages.splice(0, validMessages.length - this.MAX_QUEUE_SIZE);
      }

      const cleaned = messages.length - validMessages.length;
      if (cleaned > 0) {
        this.messageQueue[userKey] = validMessages;
        totalCleaned += cleaned;
      }

      // Remove empty queues
      if (validMessages.length === 0) {
        delete this.messageQueue[userKey];
      }
    }

    if (totalCleaned > 0) {
      console.log(`🧹 Cleaned up ${totalCleaned} old messages from queue`);
      
      // Force GC after cleaning large queues
      if (totalCleaned > 10) {
        const { suggestGC } = require('../config/memory-config');
        suggestGC();
      }
    }
  }

  public async handleIncomingMessage(clientId: string, message: any): Promise<void> {
    // CRITICAL: Ignore messages sent by the bot itself to prevent infinite loops
    if (message.fromMe === true) {
      return;
    }
    
    // Also check if sender is the bot's own phone number
    const senderNumber = message.from?.replace('@c.us', '') || 'unknown';
    const client = this.whatsappService.getClient(clientId);
    if (client && client.phoneNumber && senderNumber === client.phoneNumber.replace('@c.us', '')) {
      return;
    }
    
    try {
      const userKey = this.getUserKey(clientId, senderNumber);
      
      // Extract and store contact information
      const contactInfo = this.extractContactInfo(message);
      this.contactInfo[userKey] = contactInfo;
      
      // Check if user is paused
      const isPaused = await this.userPauseService.isUserPaused(clientId, senderNumber);
      if (isPaused) {
        console.log(`⏸️  [${clientId}] User ${senderNumber} is paused - skipping message`);
        return; // Skip without read/reply
      }

      // Check if we're in production mode
      const isProduction = this.env.NODE_ENV === 'production';
      const allowedNumbers = this.env.ALLOWED_NUMBERS ? this.env.ALLOWED_NUMBERS.split(',') : [];

      // In production, check if sender is allowed
      if (isProduction && allowedNumbers.length > 0 && !allowedNumbers.includes(senderNumber)) {
        console.log(`🚫 [${clientId}] Message from ${senderNumber} blocked (not in ALLOWED_NUMBERS): ${allowedNumbers.join(', ')}`);
        return;
      }

      // Check if this is a media message to avoid sending base64 to AI
      const isMediaMsg = this.isMediaMessage(message);
      let enhancedMessage = '';
      
      if (isMediaMsg) {
        // For media: ONLY use caption, NEVER use body (which contains base64)
        enhancedMessage = message.caption || '';
      } else {
        // For text: use body
        enhancedMessage = message.body || '';
      }

      // Handle quoted messages (WPPConnect format)
      if (message.hasQuotedMsg || message.quotedMsg) {
        try {
          const quoted = message.quotedMsg || (message.hasQuotedMsg ? await message.getQuotedMessage() : null);
          if (quoted && quoted.body) {
            // Check if this is a reaction message (contains "reacted" in the body)
            const isReaction = enhancedMessage.includes('reacted') && enhancedMessage.includes('to this message');
            
            if (!isReaction) {
              // Only add "Replying to" prefix for actual replies, not reactions
              enhancedMessage = `Replying to this message: "${quoted.body}"\n${enhancedMessage}`;
            }
            // For reactions, the message already contains "reacted ❤️ to this message: ..."
          }
        } catch (error) {
          // Continue with original message if quoted message retrieval fails
        }
      }

      // Handle location messages
      if (message.type === 'location') {
        const latitude = message.lat;
        const longitude = message.lng;
        const locationName = message.loc; // Location name/address (if available)
        
        console.log(`📍 Location received - Lat: ${latitude}, Lng: ${longitude}, Name: ${locationName || 'N/A'}`);
        
        let locationText = `Location attached: Latitude=${latitude}, Longitude=${longitude}`;
        if (locationName) {
          locationText += `, Location name: ${locationName}`;
        }
        
        // Prepend location info to the message
        enhancedMessage = enhancedMessage ? `${locationText}\n${enhancedMessage}` : locationText;
      }

      // Handle live location messages
      if (message.type === 'livelocation') {
        const latitude = message.lat;
        const longitude = message.lng;
        const shareDuration = message.shareDuration; // Duration in seconds
        const locationName = message.loc; // Location name/address (if available)
        
        console.log(`📍🔴 Live location received - Lat: ${latitude}, Lng: ${longitude}, Duration: ${shareDuration}s, Name: ${locationName || 'N/A'}`);
        
        // Convert duration to human-readable format
        let durationText = '';
        if (shareDuration) {
          const minutes = Math.floor(shareDuration / 60);
          const hours = Math.floor(minutes / 60);
          if (hours > 0) {
            durationText = ` (sharing for ${hours} hour${hours > 1 ? 's' : ''})`;
          } else if (minutes > 0) {
            durationText = ` (sharing for ${minutes} minute${minutes > 1 ? 's' : ''})`;
          } else {
            durationText = ` (sharing for ${shareDuration} seconds)`;
          }
        }
        
        let locationText = `Live Location attached: Latitude=${latitude}, Longitude=${longitude}${durationText}`;
        if (locationName) {
          locationText += `, Location name: ${locationName}`;
        }
        
        // Prepend location info to the message
        enhancedMessage = enhancedMessage ? `${locationText}\n${enhancedMessage}` : locationText;
      }

      // Handle media attachments (WPPConnect format)
      let mediaUrls: string[] = [];
      if (isMediaMsg) {
        try {
          mediaUrls = await this.handleMediaMessage(clientId, message);
          if (mediaUrls.length > 0) {
            console.log(`📎 Media processed: ${mediaUrls.length} file(s)`);
          }
        } catch (error) {
          console.error('❌ Error handling media:', error);
        }
      }

      // If user is already being processed, mark this message as read immediately
      if (this.processingUsers[userKey]) {
        await this.sendReadReceipt(clientId, senderNumber);
      }

      // Add to message queue
      this.addToQueue(clientId, senderNumber, message, enhancedMessage, mediaUrls);

      // Start processing with delay
      const delay = 16000; // 25 seconds
      this.startProcessing(clientId, senderNumber, delay);

    } catch (error) {
      console.error(`❌ Error handling incoming message:`, error);
    }
  }

  /**
   * Public method to send a message using workflow object array format
   * This is used by the /send API endpoint to send messages with rich media support
   * Accepts either a string (will be sent as text) or an array of WorkflowMessageObject
   */
  public async sendMessageWithMedia(clientId: string, number: string, message: string | WorkflowMessageObject[]): Promise<void> {
    // Format number
    const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
    
    try {
      console.log(`📤 [${clientId}] Sending message to ${number}`);
      
      // Get client
      const client = this.whatsappService.getClient(clientId);
      if (!client || !client.client) {
        throw new Error(`Client ${clientId} not found or not ready`);
      }

      // If message is a string, convert it to a text object
      let messageObjects: WorkflowMessageObject[];
      if (typeof message === 'string') {
        messageObjects = [{ type: 'text', text: message }];
      } else {
        messageObjects = message;
      }

      // Use the workflow message sending function
      await this.sendWorkflowMessages(client, clientId, formattedNumber, messageObjects);
      
      console.log(`✅ [${clientId}] Message sent successfully to ${number}`);
    } catch (error) {
      console.error(`❌ Error sending message:`, error);
      throw error;
    } finally {
      // Always stop typing indicator after sending (success or error)
      try {
        const client = this.whatsappService.getClient(clientId);
        if (client && client.client) {
          await client.client.stopTyping(formattedNumber);
          console.log(`✅ Typing indicator stopped for ${number}`);
        }
      } catch (stopTypingError) {
        // Silent fail - typing might already be stopped or not active
        console.log(`ℹ️  Typing indicator stop attempted (may already be stopped)`);
      }
    }
  }

  private isMediaMessage(message: any): boolean {
    if (!message || !message.type) return false;
    
    const mediaTypes = [
      'image',      // MessageType: image
      'video',      // MessageType: video
      'audio',      // MessageType: audio
      'ptt',        // MessageType: ptt (push-to-talk voice)
      'document',   // MessageType: document
      'sticker'     // MessageType: sticker
    ];
    
    return mediaTypes.includes(message.type.toLowerCase());
  }


  private async downloadMediaFromUrl(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      console.log(`📥 Downloading media from URL: ${url}`);
      
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const buffer = Buffer.from(response.data);
      const contentType = response.headers['content-type'] || 'application/octet-stream';
      
      console.log(`📥 Downloaded ${buffer.length} bytes, MIME type: ${contentType}`);
      
      return { buffer, mimeType: contentType };
    } catch (error) {
      console.error(`❌ Failed to download media from ${url}:`, error);
      return null;
    }
  }

  private detectMimeTypeFromMessage(message: any, buffer: Buffer): string {
    // First try to detect from message type
    const messageType = message.type?.toLowerCase();
    
    // Check buffer header for actual file type
    const header = buffer.slice(0, 12);
    const headerHex = header.toString('hex');
    
    // Image detection
    if (headerHex.startsWith('ffd8ff')) return 'image/jpeg';
    if (headerHex.startsWith('89504e47')) return 'image/png';
    if (headerHex.startsWith('47494638')) return 'image/gif';
    if (headerHex.startsWith('52494646')) return 'image/webp';
    
    // Video detection
    if (headerHex.startsWith('000001ba') || headerHex.startsWith('000001b3')) return 'video/mpeg';
    if (headerHex.startsWith('1a45dfa3')) return 'video/webm';
    if (headerHex.startsWith('66747970')) return 'video/mp4';
    
    // Audio detection
    if (headerHex.startsWith('494433') || headerHex.startsWith('fffb')) return 'audio/mpeg';
    if (headerHex.startsWith('4f676753')) return 'audio/ogg';
    if (headerHex.startsWith('52494646')) return 'audio/wav';
    
    // Fallback to message type
    switch (messageType) {
      case 'image': return 'image/jpeg';
      case 'video': return 'video/mp4';
      case 'audio': return 'audio/mpeg';
      case 'ptt': return 'audio/ogg';
      case 'document': return 'application/octet-stream';
      case 'sticker': return 'image/webp';
      default: return 'application/octet-stream';
    }
  }

  private async handleMediaMessage(clientId: string, message: any): Promise<string[]> {
    const mediaUrls: string[] = [];
    
    try {
      console.log(`📎 [${clientId}] Processing media attachment...`);
      console.log('📎 Message type:', message.type);
      console.log('📎 Message ID:', message.id);
      
      // Get the specific client that received this message
      const client = this.whatsappService.getClient(clientId);
      
      if (!client || !client.isReady || !client.client) {
        console.log(`⚠️ Client ${clientId} not ready for media download`);
        return mediaUrls;
      }

      // WPPConnect: Use decryptFile for more reliable media download
      let mediaBuffer: Buffer | null = null;
      try {
        console.log('📎 Using decryptFile for media download...');
        mediaBuffer = await client.client.decryptFile(message);
        console.log(`📎 Media buffer size: ${mediaBuffer ? mediaBuffer.length : 0} bytes`);
      } catch (error) {
        console.error('❌ decryptFile failed:', error);
        return mediaUrls;
      }
      
      if (!mediaBuffer) {
        console.log('⚠️ No media buffer received');
        return mediaUrls;
      }

      // Determine MIME type from message type and buffer
      const mimetype = this.detectMimeTypeFromMessage(message, mediaBuffer);
      console.log(`📎 Detected MIME type: ${mimetype}`);
      
      // Generate unique filename with proper extension
      const fileExtension = this.getFileExtensionFromMimeType(mimetype);
      const filename = `${crypto.randomUUID()}${fileExtension}`;
      const filePath = path.join(this.tempDir, filename);

      // Save media to temporary file (buffer is already binary, no base64 conversion needed)
      fs.writeFileSync(filePath, mediaBuffer);
      
      // Clear the buffer from memory immediately
      mediaBuffer.fill(0);
      
      console.log(`📎 Media saved to: ${filePath} (${Math.round(fs.statSync(filePath).size / 1024)}KB)`);

      // Upload to tmpfile.link (this method handles cleanup)
      const uploadUrl = await this.uploadToTmpFile(filePath, filename, mimetype);
      if (uploadUrl) {
        mediaUrls.push(uploadUrl);
        console.log(`📎 Media uploaded: ${uploadUrl}`);
      }

    } catch (error) {
      console.error('❌ Error processing media:', error);
    }

    return mediaUrls;
  }

  private getFileExtensionFromMimeType(mimetype: string): string {
    const mimeMap: { [key: string]: string } = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg',
      'video/mp4': '.mp4',
      'video/avi': '.avi',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'video/x-matroska': '.mkv',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
    };

    return mimeMap[mimetype] || '.bin';
  }

  private async uploadToTmpFile(filePath: string, filename: string, mimetype: string): Promise<string | null> {
    try {
      const formData = new FormData();
      const fileStream = fs.createReadStream(filePath);
      
      formData.append('file', fileStream, {
        filename: filename,
        contentType: mimetype
      });

      const response = await axios.post('https://tmpfile.link/api/upload', formData, {
        headers: {
          ...formData.getHeaders()
        },
        timeout: 30000
      });

      if (response.data && response.data.downloadLink) {
        console.log(`✅ Media uploaded to tmpfile.link: ${response.data.downloadLink}`);
        return response.data.downloadLink;
      } else {
        console.error('❌ Invalid response from tmpfile.link:', response.data);
        return null;
      }
    } catch (error) {
      console.error('❌ Error uploading to tmpfile.link:', error);
      return null;
    } finally {
      // Always clean up the temporary file after upload (success or failure)
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Cleaned up temporary file: ${filePath}`);
        }
      } catch (cleanupError) {
        console.error(`⚠️ Error cleaning up temporary file ${filePath}:`, cleanupError);
      }
    }
  }

  private addToQueue(clientId: string, senderNumber: string, message: any, enhancedMessage: string, mediaUrls: string[]): void {
    const userKey = this.getUserKey(clientId, senderNumber);
    if (!this.messageQueue[userKey]) {
      this.messageQueue[userKey] = [];
    }

    this.messageQueue[userKey].push({
      message,
      enhancedText: enhancedMessage,
      mediaUrls,
      timestamp: Date.now()
    });
  }

  private startProcessing(clientId: string, senderNumber: string, delay: number): void {
    const userKey = this.getUserKey(clientId, senderNumber);

    // If already processing, clear the existing timer and reset it
    if (this.processingUsers[userKey]) {
      // Clear existing processing timer
      const existingTimer = (this.processingUsers as any)[`${userKey}_timer`];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      
      // Set new timer
      const newTimer = setTimeout(() => {
        this.processQueuedMessages(clientId, senderNumber);
      }, delay);
      
      (this.processingUsers as any)[`${userKey}_timer`] = newTimer;
      return;
    }

    // Silent - processing started
    this.processingUsers[userKey] = 1;

    // Send read receipt immediately if not already sent
    const preDelayMs = 300; // 300ms before typing
    console.log(`⏰ Setting read/typing timer for ${senderNumber} (${preDelayMs}ms)`);
    
    const readTypingTimer = setTimeout(async () => {
      try {
        console.log(`📖 Read/typing timer fired for ${senderNumber}`);
        
        // Send read receipt only once
        if (!this.readReceiptSent[userKey]) {
          console.log(`📖 Sending read receipt for ${senderNumber}...`);
          const readSent = await this.sendReadReceipt(clientId, senderNumber);
          if (readSent) {
            this.readReceiptSent[userKey] = true;
            console.log(`✅ Read receipt marked as sent for ${senderNumber}`);
          }
        } else {
          console.log(`ℹ️  Read receipt already sent for ${senderNumber}, skipping`);
        }
        
        // Start typing indicator
        console.log(`⌨️  Starting typing for ${senderNumber}...`);
        await this.sendTypingIndicator(clientId, senderNumber, true);
        
      } catch (error) {
        console.log('⚠️ Error in read/typing sequence:', error);
      }
    }, preDelayMs);

    (this.processingUsers as any)[`${userKey}_readTypingTimer`] = readTypingTimer;

    // Set initial processing timer
    const processingTimer = setTimeout(() => {
      this.processQueuedMessages(clientId, senderNumber);
    }, delay);
    
    (this.processingUsers as any)[`${userKey}_timer`] = processingTimer;
  }

  private async processQueuedMessages(clientId: string, senderNumber: string): Promise<void> {
    const userKey = this.getUserKey(clientId, senderNumber);
    
    // Guard: Check if this user is actually in processing state
    if (!this.processingUsers[userKey]) {
      console.log(`⚠️ Processing already completed for ${senderNumber}, skipping`);
      return;
    }
    
    try {
      // Read and immediately clear the queue to prevent duplicate processing
      const messages = this.messageQueue[userKey] || [];
      this.messageQueue[userKey] = []; // Clear immediately after reading
      
      // Force GC hint after processing messages to free memory
      if (messages.length > 5) {
        const { suggestGC } = require('../config/memory-config');
        suggestGC();
      }
      
      if (messages.length === 0) {
        console.log(`⚠️ No messages in queue for ${senderNumber}`);
        this.cleanupProcessingState(clientId, senderNumber);
        return;
      }

      // Silent - already processed messages are being sent

      // Combine all messages with metadata and media URLs
      const combinedMessages = messages.map(item => {
        // Extract message metadata
        const messageId = item.message?.id || 'unknown';
        const messageTimestamp = item.message?.timestamp || item.timestamp;
        
        // Format timestamp: Thursday, 2025-04-17T17:43:35+07:00 (GMT+7)
        let formattedTimestamp = 'unknown';
        if (messageTimestamp) {
          try {
            const date = new Date(messageTimestamp * 1000); // Convert Unix timestamp to milliseconds
            const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Jakarta' });
            const isoDateTime = date.toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T');
            formattedTimestamp = `${dayOfWeek}, ${isoDateTime}+07:00 (GMT+7)`;
          } catch (error) {
            console.log(`⚠️ Error formatting timestamp: ${error}`);
            formattedTimestamp = String(messageTimestamp);
          }
        }
        
        // Format: [#messageid:xxx#message-timestamp:xxx] message text
        const metadataPrefix = `[#messageid:${messageId}#message-timestamp:${formattedTimestamp}]`;
        
        let messageText = item.enhancedText !== undefined ? item.enhancedText : '';
        if (item.mediaUrls && item.mediaUrls.length > 0) {
          messageText += `\nMedia attached:\n- @[${item.mediaUrls.join(']\n- @[')}]`;
        }
        
        return `${metadataPrefix} ${messageText}`;
      }).join('\n');

      // Send to AI and respond (using the specific client)
      const sendStartTime = Date.now();
      
      await this.sendMessage(clientId, senderNumber, combinedMessages, null, false, null);
      
      const sendDuration = ((Date.now() - sendStartTime) / 1000).toFixed(2);
      console.log(`✅ [${clientId}] Response sent to ${senderNumber} (${sendDuration}s)`);

      // Stop typing indicator
      await this.sendTypingIndicator(clientId, senderNumber, false);

      // Clean up
      this.cleanupProcessingState(clientId, senderNumber);

    } catch (error) {
      console.error(`❌ Error processing messages for ${senderNumber}:`, error);
      this.cleanupProcessingState(clientId, senderNumber);
    }
  }

  private cleanupProcessingState(clientId: string, senderNumber: string): void {
    const userKey = this.getUserKey(clientId, senderNumber);
    
    // Check if new messages arrived during processing
    const hasNewMessages = this.messageQueue[userKey] && this.messageQueue[userKey].length > 0;
    
    if (hasNewMessages) {
      // Don't cleanup! Let the existing timer handle the new messages
      console.log(`📬 [${clientId}] New messages arrived for ${senderNumber} during processing - keeping state active`);
      return;
    }
    
    // Clean up all timers first to prevent any pending executions
    const processingTimer = (this.processingUsers as any)[`${userKey}_timer`];
    if (processingTimer) {
      clearTimeout(processingTimer);
    }
    
    const readTypingTimer = (this.processingUsers as any)[`${userKey}_readTypingTimer`];
    if (readTypingTimer) {
      clearTimeout(readTypingTimer);
    }
    
    // Clean up all state
    delete this.messageQueue[userKey];
    delete this.processingUsers[userKey];
    delete (this.processingUsers as any)[`${userKey}_timer`];
    delete (this.processingUsers as any)[`${userKey}_readTypingTimer`];
    delete this.readReceiptSent[userKey];
    
    console.log(`🧹 [${clientId}] Cleaned up processing state for ${senderNumber}`);
    
    // Keep contactInfo for future messages from same user
  }

  /**
   * Send messages from workflow response object array
   * Each object represents a WhatsApp message bubble with a specific type
   */
  private async sendWorkflowMessages(
    client: any,
    clientId: string,
    formattedNumber: string,
    messageObjects: WorkflowMessageObject[]
  ): Promise<void> {
    try {
      // Check memory before processing
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
      const memPercent = Math.round((heapUsedMB / heapTotalMB) * 100);

      if (memPercent > 95) {
        console.warn(`⚠️  High memory usage (${memPercent}%) - may affect media processing`);
      }

      let anySent = false;

      for (let i = 0; i < messageObjects.length; i++) {
        const msgObj = messageObjects[i];
        if (!msgObj || !msgObj.type) continue;

        try {
          // Show typing before each message
          await client.client.startTyping(formattedNumber);
        } catch {}

        try {
          switch (msgObj.type) {
            case 'text':
              if (msgObj.text) {
                await client.client.sendText(formattedNumber, msgObj.text);
                console.log(`✅ Sent text: ${msgObj.text.substring(0, 50)}...`);
                anySent = true;
              }
              break;

            case 'image':
              if (msgObj.url) {
                if (msgObj.caption) {
                  await client.client.sendImage(formattedNumber, msgObj.url, undefined, msgObj.caption);
                } else {
                  await client.client.sendImage(formattedNumber, msgObj.url);
                }
                console.log(`✅ Sent image: ${msgObj.url}`);
                anySent = true;
              }
              break;

            case 'video':
              if (msgObj.url) {
                if (msgObj.caption) {
                  await client.client.sendFile(formattedNumber, msgObj.url, undefined, msgObj.caption);
                } else {
                  await client.client.sendFile(formattedNumber, msgObj.url);
                }
                console.log(`✅ Sent video: ${msgObj.url}`);
                anySent = true;
              }
              break;

            case 'audio':
              if (msgObj.url) {
                await client.client.sendFile(formattedNumber, msgObj.url);
                console.log(`✅ Sent audio: ${msgObj.url}`);
                anySent = true;
              }
              break;

            case 'file':
              if (msgObj.url) {
                if (msgObj.caption) {
                  await client.client.sendFile(formattedNumber, msgObj.url, undefined, msgObj.caption);
                } else {
                  await client.client.sendFile(formattedNumber, msgObj.url);
                }
                console.log(`✅ Sent file: ${msgObj.url}`);
                anySent = true;
              }
              break;

            case 'sticker':
              if (msgObj.url) {
                const stickerTimeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Sticker timeout')), 30000)
                );

                const urlLower = msgObj.url.toLowerCase();
                const isAnimated = urlLower.match(/\.(gif|webp)(?=\?|#|$)/i);

                if (isAnimated) {
                  await Promise.race([
                    client.client.sendImageAsStickerGif(formattedNumber, msgObj.url),
                    stickerTimeout
                  ]);
                  console.log(`✅ Sent animated sticker: ${msgObj.url}`);
                } else {
                  await Promise.race([
                    client.client.sendImageAsSticker(formattedNumber, msgObj.url),
                    stickerTimeout
                  ]);
                  console.log(`✅ Sent static sticker: ${msgObj.url}`);
                }
                anySent = true;
              }
              break;

            case 'animated-sticker':
              if (msgObj.url) {
                const stickerTimeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Animated sticker timeout')), 30000)
                );

                await Promise.race([
                  client.client.sendImageAsStickerGif(formattedNumber, msgObj.url),
                  stickerTimeout
                ]);
                console.log(`✅ Sent animated sticker: ${msgObj.url}`);
                anySent = true;
              }
              break;

            case 'reaction':
              if (msgObj.messageid && msgObj.emoji) {
                // Note: WPPConnect may not have direct reaction support
                // This is a placeholder - you may need to implement via WhatsApp Web API
                console.log(`⚠️  Reaction not yet implemented: ${msgObj.emoji} to message ${msgObj.messageid}`);
                // TODO: Implement reaction sending if WPPConnect supports it
              }
              break;

            case 'location':
              if (msgObj.latitude !== undefined && msgObj.longitude !== undefined) {
                const title = msgObj.caption || 'Location';
                await client.client.sendLocation(
                  formattedNumber,
                  String(msgObj.latitude),
                  String(msgObj.longitude),
                  title
                );
                console.log(`✅ Sent location: ${msgObj.latitude}, ${msgObj.longitude}`);
                anySent = true;
              }
              break;

            case 'reply':
              if (msgObj.text && msgObj.messageid) {
                let messageId = msgObj.messageid.trim();
                
                // Detect if messageid is only the suffix (e.g., "3B9B7419026B9E944FD1")
                // WhatsApp message IDs format: "false_<formattedNumber>_<suffix>"
                // If it doesn't contain underscores or doesn't start with "false_", it's likely incomplete
                if (!messageId.includes('_') || !messageId.startsWith('false_')) {
                  // Construct full message ID: false_<formattedNumber>_<suffix>
                  messageId = `false_${formattedNumber}_${messageId}`;
                  console.log(`🔧 Constructed full message ID: ${messageId}`);
                }
                
                try {
                  // Try to get the message first to validate it exists
                  const targetMessage = await client.client.getMessageById(messageId);
                  
                  if (!targetMessage) {
                    console.log(`⚠️  Message with ID ${messageId} not found, sending as regular text`);
                    await client.client.sendText(formattedNumber, msgObj.text);
                    anySent = true;
                  } else {
                    // Extract the proper message ID format from the message object
                    let validMessageId: string;
                    
                    if (targetMessage.id) {
                      if (typeof targetMessage.id === 'object' && targetMessage.id._serialized) {
                        validMessageId = targetMessage.id._serialized;
                      } else if (typeof targetMessage.id === 'string') {
                        validMessageId = targetMessage.id;
                      } else {
                        validMessageId = messageId; // Fallback to constructed ID
                      }
                    } else {
                      validMessageId = messageId; // Fallback to constructed ID
                    }
                    
                    await client.client.reply(
                      formattedNumber,
                      msgObj.text,
                      validMessageId
                    );
                    console.log(`✅ Sent reply to message ${validMessageId}: ${msgObj.text.substring(0, 50)}...`);
                    anySent = true;
                  }
                } catch (replyErr: any) {
                  const errorMsg = replyErr?.message || replyErr;
                  console.log(`⚠️  Failed to send reply (ID: ${messageId}): ${errorMsg}`);
                  console.log(`🔄 Falling back to regular text...`);
                  await client.client.sendText(formattedNumber, msgObj.text);
                  anySent = true;
                }
              } else if (msgObj.text) {
                // No messageid provided - send as regular text
                console.log(`ℹ️  Reply type without messageid, sending as regular text`);
                await client.client.sendText(formattedNumber, msgObj.text);
                console.log(`✅ Sent as regular text: ${msgObj.text.substring(0, 50)}...`);
                anySent = true;
              }
              break;

            case 'stop-response':
              // AI decided not to respond - log reason and stop processing
              const reason = msgObj.reason || 'No reason provided';
              console.log(`🛑 Stop-response received: ${reason}`);
              console.log(`ℹ️  Skipping all message sending to user ${formattedNumber}`);
              
              // Stop typing indicator if it was started
              try {
                await client.client.stopTyping(formattedNumber);
              } catch {}
              
              // Return early - don't send any messages
              return;

            default:
              console.warn(`⚠️  Unknown message type: ${msgObj.type}`);
          }
        } catch (error: any) {
          const errorMsg = error?.message || error;
          const isInvalidNumber = String(errorMsg).includes('invalid wid') ||
                                  String(errorMsg).includes('InvalidWidError') ||
                                  String(errorMsg).includes('wid error');

          if (isInvalidNumber) {
            console.warn(`⚠️  Invalid WhatsApp number detected - stopping message send`);
            return;
          }

          console.error(`⚠️  Error sending ${msgObj.type}:`, errorMsg);
        }

        // Natural delay between messages (except for reactions which are instant)
        if (i < messageObjects.length - 1 && msgObj.type !== 'reaction') {
          const delayMs = 1000 + Math.floor(Math.random() * 2000);
          console.log(`⏳ Waiting ${delayMs}ms before next workflow bubble`);
          
          // Show typing indicator during the delay
          try {
            await client.client.startTyping(formattedNumber);
          } catch {}
          
          // Wait with typing indicator showing
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      if (!anySent) {
        console.warn(`⚠️  No messages were sent successfully from workflow response`);
      }

      // Stop typing indicator after all messages are sent
      try {
        await client.client.stopTyping(formattedNumber);
      } catch {}

    } catch (error) {
      console.error('❌ Error in sendWorkflowMessages:', error);
      // Ensure typing indicator is stopped even on error
      try {
        await client.client.stopTyping(formattedNumber);
      } catch {}
      throw error;
    }
  }

  private async sendMessage(
    clientId: string,
    number: string, 
    message: string, 
    contexts: ChatMessage[] | null, 
    initial: boolean, 
    campaign: string | null
  ): Promise<void> {
      // Log truncated message
      const msgPreview = message.length > 100 ? message.substring(0, 100) + '...' : message;
      console.log(`📤 [${clientId}] Sending to ${number}: ${msgPreview}`);
    console.log(`📤 Initial: ${initial}, Campaign: ${campaign}`);
    
    try {
      const formattedNumber = `${number || ''}@c.us`;
      
      if (initial) {
        await this.whatsappService.sendMessage(clientId, formattedNumber, message);
        return;
      } 

      // Get user contact information from stored metadata
      const phoneNumber = number.replace('@c.us', '');
      const userKey = this.getUserKey(clientId, phoneNumber);
      const storedContact = this.contactInfo[userKey] || {
        name: 'WhatsApp User',
        pushname: 'WhatsApp User',
        formattedName: 'WhatsApp User',
        isBusiness: false,
        isEnterprise: false
      };
      
      const userName = storedContact.name || 'WhatsApp User';

      // Truncate message for logging
      const messagePreview = message.length > 100 ? message.substring(0, 100) + '...' : message;
      console.log(`🤖 [${clientId}] Calling AI API for ${number} (${messagePreview})`);
      
      let aiagent: any;
      aiagent = await this.callInferenceFw(message, number, userName, clientId);
      
      // Get client for sending
      const client = this.whatsappService.getClient(clientId);
      if (!client || !client.client) {
        console.error('❌ Client not found or not ready');
        return;
      }

      // Workflow format - use object array
      if (aiagent && aiagent.result && aiagent.result.content && aiagent.result.content.object) {
        const messageObjects = aiagent.result.content.object;
        console.log(`🤖 [${clientId}] Received workflow response with ${messageObjects.length} message objects`);
        
        try {
          await this.sendWorkflowMessages(client, clientId, formattedNumber, messageObjects);
          return;
        } catch (error) {
          console.error('❌ Error sending workflow messages:', error);
          return;
        }
      }
      
      // Fallback: If workflow response has text but no object array, use text
      if (aiagent && aiagent.result && aiagent.result.content && aiagent.result.content.text) {
        const text = aiagent.result.content.text;
        console.log(`🤖 [${clientId}] Received workflow response with text only (no object array)`);
        
        try {
          await client.client.sendText(formattedNumber, text);
          console.log(`✅ Sent text-only workflow response`);
          return;
        } catch (error) {
          console.error('❌ Error sending text-only workflow response:', error);
          return;
        }
      }
      
      // Invalid response format
      console.error('❌ Invalid workflow response format:', aiagent);
      try {
        await client.client.sendText(formattedNumber, 'Sorry, I received an invalid response from the AI service.');
      } catch (error) {
        console.error('❌ Error sending error message:', error);
      }
      
    } catch (error) {
      console.error('❌ Error in sendMessage:', error);
    }
  }

  private async callInferenceFw(message: string, phoneNumber: string, userName: string, clientId: string): Promise<WorkflowResponse> {
    try {
      // Get agent code for this client
      const agentCode = await this.whatsappService.getClientAgent(clientId);
      if (!agentCode) {
        throw new Error(`No agent assigned to client ${clientId}`);
      }

      console.log(`🤖 Using agent code: ${agentCode} for client ${clientId}`);

      // Use workflow endpoint - required
      const url = this.env.FW_ENDPOINT_WORKFLOW;
      if (!url) {
        throw new Error('FW_ENDPOINT_WORKFLOW environment variable is required');
      }

      const jwtSecret = this.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error('JWT_SECRET environment variable is not set');
      }

      // Get stored contact information for this user
      const userKey = this.getUserKey(clientId, phoneNumber);
      const userContact = this.contactInfo[userKey] || {
        name: userName,
        pushname: userName,
        isBusiness: false,
        isEnterprise: false
      };

      // Get bot/agent WhatsApp information
      let agentPhone = 'unknown';
      let agentName = 'WhatsApp Bot';
      try {
        const client = this.whatsappService.getClient(clientId);
        if (client && client.phoneNumber) {
          agentPhone = client.phoneNumber;
        }
        // Try to get bot's own profile name
        if (client && client.client) {
          try {
            const hostDevice = await client.client.getHostDevice();
            if (hostDevice && hostDevice.phone) {
              agentPhone = hostDevice.phone.device_manufacturer || agentPhone;
            }
          } catch (error) {
            // Silent fail - use default
          }
        }
      } catch (error) {
        // Silent fail - use defaults
      }

      // Generate JWT token with proper payload structure including contact metadata
      const payload = {
        iss: 'whatsapp-bot',
        sub: `wa_${phoneNumber}`, // Unique identifier per user
        aud: 'authenticated',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiration
        identifier: phoneNumber || 'unknown',
        role: 'authenticated',
        agent_metadata: {
          agent_code: agentCode,
          status: "active",
          agent_phone: agentPhone,
          agent_name: agentName
        },
        client_metadata: {
          client_id: clientId,
          client_name: 'WhatsApp Bot',
          app_metadata: {
            provider: 'wa'
          },
        },
        user_metadata: {
          // Phone information
          phone: phoneNumber || 'unknown',
          phone_verified: true,
          
          // User profile information from WhatsApp
          full_name: userContact.name || userName || 'WhatsApp User',
          pushname: userContact.pushname || userName || 'WhatsApp User',
          
          // Business account information
          is_business: userContact.isBusiness || false,
          is_enterprise: userContact.isEnterprise || false,
          verified_name: userContact.verifiedName || null,
          
          // Legacy fields for compatibility
          sub: `wa_${phoneNumber}`,
          campaign_id: '6a793f4c-609d-4507-ad4f-d6d25c1218c8',
          participant_name: userContact.name || userName || 'WhatsApp User',
          participant_phone: phoneNumber || 'unknown',
          
          // Additional context
          message_timestamp: Math.floor(Date.now() / 1000),
          client_id: clientId
        }
      };

      // JWT payload creation - silent
      const authToken = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

      const formattedPhoneNumber = phoneNumber || 'unknown';

      // Workflow format request body
      const requestBody = {
        inputData: {
          agent_code: "generalAssistanceAgent", // HARDCODED
          format: "whatsapp", // HARDCODED
          messages: [
            {
              role: "user", // HARDCODED
              content: message // the [message]
            }
          ],
          client_platform: "whatsapp",
          memory: {
            resourceId: `${agentCode}:${formattedPhoneNumber}`,
            threadId: `${agentCode}:${formattedPhoneNumber}:whatsapp`
          }
        }
      };

      const response = await axios.post(url, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        timeout: parseInt(this.env.AI_REQUEST_TIMEOUT || '240000', 10) // 4 minutes default, configurable
      });

      // Response status - only log errors
      if (response.status < 200 || response.status >= 300) {
        console.error(`❌ [${clientId}] AI API error: Status ${response.status}`);
      }

      // Parse workflow response
      const workflowResponse: WorkflowResponse = response.data;
      
      if (workflowResponse && workflowResponse.result && workflowResponse.result.content) {
        return workflowResponse;
      } else {
        console.error('❌ Invalid workflow response structure:', workflowResponse);
        throw new Error('Invalid response from AI service');
      }

    } catch (error) {
      console.error('❌ Error calling AI API:', error);
      throw error;
    }
  }
}

export default WPPConnectMessageHandler;
