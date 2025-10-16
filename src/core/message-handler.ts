import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment, ChatMessage } from '../types';
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
   * Parse sendText template data from AI response
   * Detects JSON blocks containing sendText_args and sendText_data
   */
  private parseSendTextTemplate(text: string): {
    hasTemplate: boolean;
    cleanText: string;
    templateData?: any;
  } {
    try {
      // Extract JSON from code blocks in ORIGINAL AI response (before WhatsApp formatting)
      // Pattern: ```json ... ``` or ``` ... ```
      const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/;
      const match = text.match(codeBlockRegex);
      
      if (match && match[1]) {
        try {
          const jsonStr = match[1].trim();
          console.log(`🔍 Found code block, attempting to parse JSON...`);
          const parsed = JSON.parse(jsonStr);
          
          if (parsed.sendText_args === true && parsed.sendText_data) {
            console.log(`🎯 Detected sendText template in AI response`);
            console.log(`📋 Template data:`, JSON.stringify(parsed.sendText_data, null, 2));
            
            // Remove the entire code block from text
            const cleanText = text.replace(match[0], '').trim();
            
            return {
              hasTemplate: true,
              cleanText: cleanText || 'Message with interactive buttons',
              templateData: parsed.sendText_data
            };
          }
        } catch (parseError) {
          console.log(`⚠️  Could not parse sendText template JSON:`, parseError);
        }
      }
      
      return {
        hasTemplate: false,
        cleanText: text
      };
      
    } catch (error) {
      console.log(`⚠️  Error parsing sendText template:`, error);
      return {
        hasTemplate: false,
        cleanText: text
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
    }
  }

  public async handleIncomingMessage(clientId: string, message: any): Promise<void> {
    try {
      const senderNumber = message.from.replace('@c.us', '');
      const userKey = this.getUserKey(clientId, senderNumber);
      console.log(`📨 [${clientId}] Message from ${senderNumber} [${message.type}]`);
      
      // Extract and store contact information
      const contactInfo = this.extractContactInfo(message);
      this.contactInfo[userKey] = contactInfo;
      console.log(`👤 Contact: ${contactInfo.name} (${senderNumber})`);
      
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
            enhancedMessage = `Replying to this message: "${quoted.body}"\n${enhancedMessage}`;
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
      const delay = 25000; // 25 seconds
      this.startProcessing(clientId, senderNumber, delay);

    } catch (error) {
      console.error(`❌ Error handling incoming message:`, error);
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

  // New: Helper to clean up URLs from markdown formatting and bullet points
  private cleanupUrl(url: string): string {
    if (!url || typeof url !== 'string') return url;
    
    // Remove common markdown formatting and bullet points
    let cleanedUrl = url
      // Remove bullet points and list markers
      .replace(/^[\s]*[-•*+]\s*/gm, '')
      // Remove numbered list markers
      .replace(/^[\s]*\d+\.\s*/gm, '')
      // Remove leading/trailing whitespace first
      .trim()
      // Remove parentheses around URLs (both leading and trailing)
      .replace(/^\(/g, '')  // Remove leading (
      .replace(/\)$/g, '')  // Remove trailing )
      // Remove brackets around URLs (both leading and trailing)
      .replace(/^\[/g, '')  // Remove leading [
      .replace(/\]$/g, '')  // Remove trailing ]
      // Remove markdown link formatting ![alt](url) -> url
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2')
      // Remove markdown link formatting [text](url) -> url
      .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2')
      // Final trim
      .trim();
    
    // If the cleaned URL is just the original URL, return it
    if (cleanedUrl === url) return url;
    
    console.log(`🧹 Cleaned URL: "${url}" -> "${cleanedUrl}"`);
    return cleanedUrl;
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

    console.log(`🚀 [${clientId}] Starting processing for ${senderNumber}`);
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
    try {
      const messages = this.messageQueue[userKey] || [];
      if (messages.length === 0) {
        console.log(`⚠️ No messages in queue for ${senderNumber}`);
        this.cleanupProcessingState(clientId, senderNumber);
        return;
      }

      console.log(`🤖 [${clientId}] Processing ${messages.length} message(s) from ${senderNumber}`);

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

      console.log(`📝 Combined message with metadata (${messages.length} messages):\n${combinedMessages.substring(0, 500)}${combinedMessages.length > 500 ? '...' : ''}`);

      // Send to AI and respond (using the specific client)
      await this.sendMessage(clientId, senderNumber, combinedMessages, null, false, null);

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
    
    // Clean up timers
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
    
    // Keep contactInfo for future messages from same user
  }

  private convertLLMToWhatsApp(content: string, preserveStructure: boolean = true): string {
    try {
      const originalLength = content.length;
      let formattedContent = content.replace(/\r\n/g, '\n');

      // Tokenize code regions to avoid accidental formatting inside code
      const codeBlocks: string[] = [];
      const inlineCodes: string[] = [];
      formattedContent = formattedContent.replace(/```([\s\S]*?)```/g, (_m, p1) => {
        const token = `__CODEBLOCK_${codeBlocks.length}__`;
        codeBlocks.push(String(p1));
        return token;
      });
      formattedContent = formattedContent.replace(/`([^`\n]+)`/g, (_m, p1) => {
        const token = `__INLINECODE_${inlineCodes.length}__`;
        inlineCodes.push(String(p1));
        return token;
      });

      // Markdown links → plain text with URL to ensure clickability in WhatsApp
      formattedContent = formattedContent.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');

      // Unescape already-escaped formatting sequences
      formattedContent = formattedContent
        .replace(/\\\\_([^_]+)\\\\_/g, '_$1_')
        .replace(/\\\\\*([^*]+)\\\\\*/g, '*$1*')
        .replace(/\\\\~([^~]+)\\\\~/g, '~$1~')
        .replace(/\\\\`([^`]+)\\\\`/g, '```$1```');

      // Bullets: •, -, * at line-start → '* '
      // Protect bullet markers using a neutral sentinel that won't collide with formatting rules
      formattedContent = formattedContent
        .replace(/^[\t ]*[•]\s+/gm, '§BULLET§ ')
        .replace(/^[\t ]*[-*]\s+/gm, '§BULLET§ ');

      // Numbered lists: 1) → 1.
      formattedContent = formattedContent
        .replace(/^[\t ]*(\d+)\)\s+/gm, '$1. ')
        .replace(/^[\t ]*(\d+)\.\s+/gm, '$1. ');

      // Bold: **text** or __text__ → *text*
      // Protect __CODEBLOCK_N__ and __INLINECODE_N__ tokens from being converted
      formattedContent = formattedContent
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(?!CODEBLOCK_\d+__|INLINECODE_\d+__)(.+?)__/g, '*$1*')
        .replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*')
        .replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*');

      // Italic: single-asterisk or underscores → _text_
      // - Do not convert list bullets '* ' (handled via sentinel)
      // - Do not convert bold '**...**' (handled above)
      // - Avoid snake_case by requiring non-word boundaries
      formattedContent = formattedContent
        .replace(/(^|[^\w*])\*(?!\*)([^\s*][^*]*?[^\s*])\*(?!\*)/g, '$1_$2_')
        .replace(/(^|[^\w])_(?!_)([^_\n]+?)_(?=[^\w]|$)/g, '$1_$2_')
        .replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_')
        .replace(/<em>([\s\S]*?)<\/em>/gi, '_$1_');

      // Strikethrough: ~~text~~ or <s>/<strike> → ~text~
      formattedContent = formattedContent
        .replace(/~~([\s\S]*?)~~/g, '~$1~')
        .replace(/<s>([\s\S]*?)<\/s>/gi, '~$1~')
        .replace(/<strike>([\s\S]*?)<\/strike>/gi, '~$1~');

      // Headers (# ...) → *...*
      formattedContent = formattedContent.replace(/^[\t ]*#{1,6}[\t ]+(.+)$/gm, '*$1*');

      // Remove horizontal rules (---, ___, ***)
      formattedContent = formattedContent.replace(/^[\t ]*[-_*]{3,}[\t ]*$/gm, '');

      // Blockquotes (> ...) and <blockquote>
      formattedContent = formattedContent
        .replace(/^[\t ]*>[\t ]+/gm, '> ')
        .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_m, p1) => String(p1).replace(/^/gm, '> '));

      // Basic HTML → text
      formattedContent = formattedContent
        .replace(/<br\s*\/?>(\n)?/gi, '\n')
        .replace(/<\/(p|div)>\s*<\1>/gi, '\n\n')
        .replace(/<\/(h\d)>\s*/gi, '\n\n')
        .replace(/<\/?(p|div|span)>/gi, '')
        .replace(/<[^>]+>/g, '');

      // Restore bullet sentinel to WhatsApp bullet style
      formattedContent = formattedContent.replace(/^§BULLET§ /gm, '* ');

      if (!preserveStructure) {
        formattedContent = formattedContent
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ ]{2,}/g, ' ');
      }

      // Restore code placeholders
      // Inline code: use WhatsApp monospace formatting
      formattedContent = formattedContent.replace(/__INLINECODE_(\d+)__/g, (_m, i) => '`' + (inlineCodes[Number(i)] ?? '') + '`');
      
      // Code blocks: format content for WhatsApp using monospace (```)
      formattedContent = formattedContent.replace(/__CODEBLOCK_(\d+)__/g, (_m, i) => {
        const codeContent = codeBlocks[Number(i)] ?? '';
        // Remove language identifier if present (e.g., ```javascript\n...)
        const cleanCode = codeContent.replace(/^[a-z]+\n/i, '');
        
        // Use WhatsApp monospace formatting: wrap entire block in triple backticks
        // Reference: https://faq.whatsapp.com/539178204879377/?cms_platform=web
        return '\n```\n' + cleanCode.trim() + '\n```\n';
      });

      return formattedContent;
    } catch (error) {
      console.log('⚠️ Error in WhatsApp formatting, sending original content', error);
      return content;
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
    console.log(`📤 sendMessage called for ${number} with message: "${message}"`);
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

      let aiagent: any;
      console.log(`🤖 Calling AI API with message: "${message}"`);
      console.log(`🤖 AI API Parameters:`, {
        message,
        phoneNumber: number,
        userName,
        clientId
      });
      aiagent = await this.callInferenceFw(message, number, userName, clientId);
      console.log(`🤖 AI Response received:`, aiagent);
      
      // Validate that we have a valid response text
      if (!aiagent || !aiagent.text) {
        console.error('❌ Invalid AI response:', aiagent);
        return;
      }
      
      try {
        // Check for sendText template in ORIGINAL response (before WhatsApp formatting)
        console.log(`🔍 Checking for sendText template in original response...`);
        const templateCheck = this.parseSendTextTemplate(aiagent.text);
        
        // Determine which text to format for WhatsApp
        // If template detected, use cleanText (without JSON), otherwise use original
        const textToFormat = templateCheck.hasTemplate ? templateCheck.cleanText : aiagent.text;
        
        // Format the response for WhatsApp (this will NOT include the JSON template)
        const formattedResponse = this.convertLLMToWhatsApp(textToFormat);
        
        if (templateCheck.hasTemplate && templateCheck.templateData) {
          // Send the message with template buttons directly
          console.log(`🔘 Detected sendText template, sending with buttons`);
          
          const client = this.whatsappService.getClient(clientId);
          if (client && client.client) {
            try {
              // Use formatted clean text (with WhatsApp formatting applied)
              await client.client.sendText(
                formattedNumber || '',
                formattedResponse,
                templateCheck.templateData
              );
              console.log(`✅ Sent text with interactive buttons`);
              return; // Done - template sent successfully
            } catch (templateError: any) {
              console.log(`⚠️  Template send failed: ${templateError?.message || templateError}`);
              console.log(`📝 Falling back to regular formatted message...`);
              // Don't return - continue to send as regular message below
            }
          }
        }
        
        // Parse response for media URLs and text parts (regular messages)
        const outgoingParts = this.parseResponseForMedia(formattedResponse);
        
        // Get client for sending
        const client = this.whatsappService.getClient(clientId);
        if (!client || !client.client) {
          console.error('❌ Client not found or not ready');
          return;
        }
        
        // Send each part with typing indicator
        for (let i = 0; i < outgoingParts.length; i++) {
          const part = outgoingParts[i];
          if (!part) continue;
          
          try {
            // Show typing before each part
            await client.client.startTyping(formattedNumber || '');
          } catch {}

          if (part.kind === 'media') {
            try {
              const mediaUrl = String(part.value);
              console.log(`🖼️ Sending media from URL: ${mediaUrl}`);
              
              // Check if it's a location (starts with #loc: or #loc-)
              if (mediaUrl.startsWith('#loc:') || mediaUrl.startsWith('#loc-')) {
                const locationData = mediaUrl.replace(/^#loc[:-]/, '').trim();
                console.log(`📍 Detected location data: ${locationData}`);
                
                // Parse latitude and longitude (format: lat;lng or lat,lng)
                const coords = locationData.split(/[;,]/);
                if (coords.length >= 2 && coords[0] && coords[1]) {
                  const latitude = coords[0].trim();
                  const longitude = coords[1].trim();
                  const title = coords[2]?.trim() || 'Location'; // Optional title
                  
                  console.log(`📍 Sending location - Lat: ${latitude}, Lng: ${longitude}, Title: ${title}`);
                  
                  try {
                    await client.client.sendLocation(
                      formattedNumber || '',
                      latitude,
                      longitude,
                      title
                    );
                    console.log(`✅ Sent location: ${latitude}, ${longitude}`);
                  } catch (locError: any) {
                    console.error(`❌ Failed to send location:`, locError);
                  }
                } else {
                  console.error(`❌ Invalid location format: ${locationData} (expected: lat;lng or lat,lng)`);
                }
              }
              // Check if it's a sticker (starts with #sticker:)
              else if (mediaUrl.startsWith('#sticker:')) {
                const stickerUrl = mediaUrl.replace('#sticker:', '').trim();
                const urlLower = stickerUrl.toLowerCase();
                
                console.log(`🔍 Sticker URL: ${stickerUrl}`);
                console.log(`🔍 URL lowercase: ${urlLower}`);
                
                // Check if it's an animated sticker (GIF or WEBP)
                const isAnimated = urlLower.match(/\.(gif|webp)(\?.*)?$/i);
                console.log(`🔍 isAnimated match result: ${isAnimated ? 'YES - ' + isAnimated[0] : 'NO'}`);
                
                if (isAnimated) {
                  console.log(`🎭 Sending as animated sticker (GIF/WEBP): ${stickerUrl}`);
                  await client.client.sendImageAsStickerGif(
                    formattedNumber || '',
                    stickerUrl
                  );
                  console.log(`✅ Sent animated sticker from ${stickerUrl}`);
                } else {
                  console.log(`🎭 Sending as static sticker: ${stickerUrl}`);
                  await client.client.sendImageAsSticker(
                    formattedNumber || '',
                    stickerUrl
                  );
                  console.log(`✅ Sent static sticker from ${stickerUrl}`);
                }
              } else {
                // Determine media type from URL extension or content
                const urlLower = mediaUrl.toLowerCase();
                let mimeType = 'application/octet-stream'; // default
                
                if (urlLower.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/)) {
                  mimeType = 'image/';
                } else if (urlLower.match(/\.(mp4|avi|mov|wmv|flv|webm)$/)) {
                  mimeType = 'video/';
                } else if (urlLower.match(/\.(mp3|wav|ogg|m4a|aac)$/)) {
                  mimeType = 'audio/';
                }
                
                // Send using WPPConnect's direct URL support
                if (mimeType.startsWith('image/')) {
                  // Send as image using URL directly
                  if (part.caption) {
                    await client.client.sendImage(
                      formattedNumber || '',
                      mediaUrl,
                      undefined, // filename (optional)
                      part.caption
                    );
                  } else {
                    await client.client.sendImage(
                      formattedNumber || '',
                      mediaUrl
                    );
                  }
                  console.log(`✅ Sent image from URL: ${mediaUrl}`);
                } else {
                  // Send as file using URL directly
                  if (part.caption) {
                    await client.client.sendFile(
                      formattedNumber || '',
                      mediaUrl,
                      undefined, // filename (optional)
                      part.caption
                    );
                  } else {
                    await client.client.sendFile(
                      formattedNumber || '',
                      mediaUrl
                    );
                  }
                  console.log(`✅ Sent file from URL: ${mediaUrl}`);
                }
              }
              
            } catch (mediaErr: any) {
              console.log(`⚠️ Failed to send media ${String(part.value)}:`, mediaErr?.message || mediaErr);
              // Fallback: send URL as text
              await client.client.sendText(formattedNumber || '', String(part.value));
            }
          } else if (part.kind === 'link') {
            // Send link preview
            try {
              const linkUrl = String(part.value);
              const linkTitle = part.caption || '';
              
              console.log(`🔗 Sending link preview: "${linkTitle}" -> ${linkUrl}`);
              
              await client.client.sendLinkPreview(
                formattedNumber || '',
                linkUrl,
                linkTitle
              );
              console.log(`✅ Sent link preview: ${linkUrl}`);
              
            } catch (linkErr: any) {
              console.log(`⚠️ Failed to send link preview ${String(part.value)}:`, linkErr?.message || linkErr);
              // Fallback: send URL as text with title
              const fallbackText = part.caption ? `${part.caption} ${part.value}` : String(part.value);
              await client.client.sendText(formattedNumber || '', fallbackText);
            }
          } else {
            // Send text part - check for special patterns
            try {
              const textContent = String(part.value);
              const quotedMsgId = part.quotedMsgId;
              
              // Check if text contains #sticker: pattern
              if (textContent.match(/#sticker:\s*(https?:\/\/[^\s]+)/i)) {
                const stickerMatch = textContent.match(/#sticker:\s*(https?:\/\/[^\s]+)/i);
                if (stickerMatch && stickerMatch[1]) {
                  const stickerUrl = stickerMatch[1];
                  console.log(`🎭 Sending as sticker from text: ${stickerUrl}`);
                  
                  const targetNumber = formattedNumber || '';
                  await client.client.sendImageAsSticker(
                    targetNumber,
                    stickerUrl
                  );
                  console.log(`✅ Sent sticker from text: ${stickerUrl}`);
                  
                  // Remove the sticker part from the text and send the remaining text
                  const remainingText = textContent.replace(/#sticker:\s*https?:\/\/[^\s]+/gi, '').trim();
                  if (remainingText) {
                    // Send with quotedMsg if available, with fallback
                    if (quotedMsgId) {
                      console.log(`💬 Sending text with quoted message ID: ${quotedMsgId}`);
                      try {
                        await client.client.sendText(formattedNumber || '', remainingText, {
                          quotedMsg: quotedMsgId
                        });
                      } catch (quotedErr: any) {
                        console.log(`⚠️  Failed to send with quotedMsg: ${quotedErr?.message || quotedErr}`);
                        console.log(`🔄 Retrying without quotedMsg...`);
                        await client.client.sendText(formattedNumber || '', remainingText);
                      }
                    } else {
                      await client.client.sendText(formattedNumber || '', remainingText);
                    }
                    console.log(`✅ Sent remaining text: ${remainingText}`);
                  }
                }
              } else {
                // Regular text - send with quotedMsg if available, with fallback
                if (quotedMsgId) {
                  console.log(`💬 Sending text with quoted message ID: ${quotedMsgId}`);
                  try {
                    await client.client.sendText(formattedNumber || '', textContent, {
                      quotedMsg: quotedMsgId
                    });
                  } catch (quotedErr: any) {
                    console.log(`⚠️  Failed to send with quotedMsg: ${quotedErr?.message || quotedErr}`);
                    console.log(`🔄 Retrying without quotedMsg...`);
                    await client.client.sendText(formattedNumber || '', textContent);
                  }
                } else {
                  await client.client.sendText(formattedNumber || '', textContent);
                }
              }
            } catch (textErr: any) {
              console.log('⚠️ Error sending text part:', textErr?.message || textErr);
            }
          }

          // Natural delay between parts
          if (i < outgoingParts.length - 1) {
            const delayMs = 1000 + Math.floor(Math.random() * 2000);
            console.log(`⏳ Waiting ${delayMs}ms before next part`);
            
            try {
              await client.client.startTyping(formattedNumber || '');
            } catch {}
            
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
        
      } catch (error) {
        console.error('❌ Error sending message:', error);
      }
      
    } catch (error) {
      console.error('❌ Error in sendMessage:', error);
    }
  }

  private parseResponseForMedia(text: string): Array<{ kind: 'text' | 'media' | 'link', value: string, caption?: string, quotedMsgId?: string }> {
    const outgoingParts: Array<{ kind: 'text' | 'media' | 'link', value: string, caption?: string, quotedMsgId?: string }> = [];
    
    // Pre-process text to remove duplicate URLs and wrapped URLs in parentheses/brackets
    // Pattern: url (url) -> url
    text = text.replace(/(https?:\/\/[^\s]+)\s+\(\1\)/g, '$1');
    
    // Remove parentheses/brackets wrapping URLs (for media files)
    // Pattern: (https://example.com/image.png) -> https://example.com/image.png
    // Pattern: [https://example.com/file.pdf] -> https://example.com/file.pdf
    text = text.replace(/\(\s*(https?:\/\/[^\s\)]+\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a|aac|pdf|doc|docx|xls|xlsx|zip|rar)(?:[?#][^\s\)]*)?)\s*\)/gi, '$1');
    text = text.replace(/\[\s*(https?:\/\/[^\s\]]+\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a|aac|pdf|doc|docx|xls|xlsx|zip|rar)(?:[?#][^\s\]]*)?)\s*\]/gi, '$1');
    
    // Protect code blocks from being split
    const codeBlockTokens: string[] = [];
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      const token = `__PROTECTED_CODE_${codeBlockTokens.length}__`;
      codeBlockTokens.push(match);
      return token;
    });
    
    // First, extract location patterns: #loc: or #loc-
    // Format: #loc:-6.347;106.770;Title or #loc-6.347,106.770,Title
    const locationRegex = /#loc[:-]([0-9.-]+[;,][0-9.-]+(?:[;,][^#\n]+)?)/gi;
    const extractedMediaList: { url: string; caption?: string; isSticker?: boolean }[] = [];
    text = text.replace(locationRegex, (match: string) => {
      const idx = extractedMediaList.length;
      // Store the full #loc: pattern as the "url" - will be parsed later
      extractedMediaList.push({ url: match.trim() });
      return `[[MEDIA_${idx}]]`;
    });
    
    // Then, extract sticker patterns: #sticker: url or #sticker url
    const stickerRegex = /#sticker:?\s*(https?:\/\/[^\s\)]+)/gi;
    text = text.replace(stickerRegex, (_m: string, url: string) => {
      const idx = extractedMediaList.length;
      const cleanedUrl = this.cleanupUrl(String(url));
      extractedMediaList.push({ url: cleanedUrl, isSticker: true });
      return `[[MEDIA_${idx}]]`;
    });
    
    // Then, extract markdown-style images: ![alt](url)
    // Updated regex to exclude trailing ) or ] from the URL capture
    const imageMdRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g;
    const withMediaTokens = text.replace(imageMdRegex, (_m: string, alt: string, url: string) => {
      const idx = extractedMediaList.length;
      const cap = String(alt || '').trim();
      const cleanedUrl = this.cleanupUrl(String(url));
      
      // Check if this is a GIF or WEBP - treat as animated sticker
      const isAnimatedImage = /\.(gif|webp)(\?.*)?$/i.test(cleanedUrl);
      
      const mediaItem: { url: string; caption?: string; isSticker?: boolean } = { 
        url: cleanedUrl,
        isSticker: isAnimatedImage // Automatically mark GIF/WEBP as stickers
      };
      if (cap.length > 0 && !isAnimatedImage) {
        // Don't add caption to stickers (captions not supported for stickers)
        mediaItem.caption = cap;
      }
      extractedMediaList.push(mediaItem);
      return `[[MEDIA_${idx}]]`;
    });
    
    // Clean up leftover brackets/parentheses around MEDIA tokens
    // Pattern: (URL) or [URL] becomes just URL when URL is replaced with [[MEDIA_N]]
    // Result: ([[MEDIA_0]]) or [[[MEDIA_0]]] -> [[MEDIA_0]]
    let cleanedText = withMediaTokens
      .replace(/\(\s*(\[\[MEDIA_\d+\]\])\s*\)/g, '$1')  // (url) -> url
      .replace(/\[\s*(\[\[MEDIA_\d+\]\])\s*\]/g, '$1')  // [url] -> url
      .replace(/\(\s*(\[\[MEDIA_\d+\]\])\s*\)/g, '$1')  // Extra pass for nested
      .replace(/\[\s*(\[\[MEDIA_\d+\]\])\s*\]/g, '$1'); // Extra pass for nested
    
    // Extract quoted message pattern BEFORE splitting into blocks
    // Pattern: #quotedMsg:messageId or #quotedMsgID:messageId (at the start or on its own line)
    let globalQuotedMsgId: string | undefined = undefined;
    const quotedMsgMatch = cleanedText.match(/^#quoted(?:Msg|MsgID):?\s*([^\s\n]+)/i);
    if (quotedMsgMatch && quotedMsgMatch[1]) {
      globalQuotedMsgId = quotedMsgMatch[1].trim();
      // Remove the quoted message pattern from the entire text
      cleanedText = cleanedText.replace(/^#quoted(?:Msg|MsgID):?\s*[^\s\n]+\s*\n*/i, '').trim();
      console.log(`💬 Detected quoted message ID: ${globalQuotedMsgId}`);
    }
    
    // Split by double newlines to create separate chat bubbles (matching main branch)
    const rawBlocks = cleanedText.split('\n\n').map(b => b.trim()).filter(Boolean);
    
    // Build regex to match media URLs by extension
    const mediaExtPattern = '(?:png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a|aac)';
    
    // Track pending quotedMsgId that needs to be applied to the next non-empty part
    let pendingQuotedMsgId: string | undefined = globalQuotedMsgId;
    
    // Process each block separately
    for (let block of rawBlocks) {
      // Check for quoted message pattern at the start of this block (inline format)
      let quotedMsgId: string | undefined = undefined;
      const blockQuotedMatch = block.match(/^#quoted(?:Msg|MsgID):?\s*([^\s\n]+)/i);
      if (blockQuotedMatch && blockQuotedMatch[1]) {
        pendingQuotedMsgId = blockQuotedMatch[1].trim();
        // Remove the quoted message pattern from the block
        block = block.replace(/^#quoted(?:Msg|MsgID):?\s*[^\s\n]+\s*/i, '').trim();
        console.log(`💬 Detected quoted message ID (inline): ${pendingQuotedMsgId}`);
      }
      
      // Use pending quotedMsgId for the first non-empty content
      if (pendingQuotedMsgId && block.trim()) {
        quotedMsgId = pendingQuotedMsgId;
        pendingQuotedMsgId = undefined; // Clear after using
      }
      // Combined regex to match:
      // 1) [[MEDIA_n]] tokens from markdown images
      // 2) @media URLs
      // 3) bare media URLs
      // Updated to exclude trailing ) and ] from URL capture
      const mediaUrlPattern = new RegExp(
        `(\\[\\[MEDIA_(\\d+)\\]\\])|@\\s*(https?:\\/\\/[^\\s\\)\\]]+\\.(?:${mediaExtPattern})(?:[?#][^\\s\\)\\]]*)?)|(https?:\\/\\/[^\\s\\)\\]]+\\.(?:${mediaExtPattern})(?:[?#][^\\s\\)\\]]*)?)`,
        'gi'
      );
      
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let foundMedia = false;
      
      while ((match = mediaUrlPattern.exec(block)) !== null) {
        foundMedia = true;
        // Add text before the media URL
        const textBefore = block.slice(lastIndex, match.index).trim();
        if (textBefore) {
          const textPart: { kind: 'text'; value: string; quotedMsgId?: string } = { kind: 'text', value: textBefore };
          if (quotedMsgId) textPart.quotedMsgId = quotedMsgId;
          outgoingParts.push(textPart);
        }
        
        if (match[1]) {
          // Media token: [[MEDIA_n]]
          const idx = Number(match[2] ?? -1);
          const meta = extractedMediaList[idx];
          if (meta && meta.url) {
            // If it's a sticker, prefix with #sticker:
            const mediaUrl = meta.isSticker ? `#sticker:${meta.url}` : meta.url;
            const mediaPart: { kind: 'media'; value: string; caption?: string; quotedMsgId?: string } = { kind: 'media', value: mediaUrl };
            if (meta.caption) {
              mediaPart.caption = meta.caption;
            }
            if (quotedMsgId) mediaPart.quotedMsgId = quotedMsgId;
            outgoingParts.push(mediaPart);
          } else {
            // Fallback: keep the token textually if something went wrong
            const textPart: { kind: 'text'; value: string; quotedMsgId?: string } = { kind: 'text', value: match[0] };
            if (quotedMsgId) textPart.quotedMsgId = quotedMsgId;
            outgoingParts.push(textPart);
          }
        } else {
          // Either @media url (group 3) or bare media url (group 4)
          const mediaUrl = (match[3] || match[4]) ?? '';
          if (mediaUrl) {
            const cleanedUrl = this.cleanupUrl(mediaUrl);
            const mediaPart: { kind: 'media'; value: string; quotedMsgId?: string } = { kind: 'media', value: cleanedUrl };
            if (quotedMsgId) mediaPart.quotedMsgId = quotedMsgId;
            outgoingParts.push(mediaPart);
          }
        }
        
        lastIndex = match.index + match[0].length;
      }
      
      // If media was found, add remaining text after last media URL
      if (foundMedia) {
        const textAfter = block.slice(lastIndex).trim();
        if (textAfter) {
          const textPart: { kind: 'text'; value: string; quotedMsgId?: string } = { kind: 'text', value: textAfter };
          if (quotedMsgId) textPart.quotedMsgId = quotedMsgId;
          outgoingParts.push(textPart);
        }
      } else {
        // If no media found in this block, check for link previews (non-media URLs)
        const linkPreviewRegex = /^(.*?)\s*(https?:\/\/[^\s\)]+?)(\s*\)?)\s*$/i;
        const linkMatch = block.match(linkPreviewRegex);
        
        if (linkMatch && linkMatch[2]) {
          const textBeforeUrl = linkMatch[1] ? linkMatch[1].trim() : '';
          const url = this.cleanupUrl(linkMatch[2]);
          
          // Check if URL is NOT a media file (not image/video/audio)
          const isMediaUrl = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a|aac)(\?.*)?$/i.test(url);
          
          if (!isMediaUrl && textBeforeUrl) {
            // This is a link preview: text + URL
            console.log(`🔗 Detected link preview: "${textBeforeUrl}" -> ${url}`);
            const linkPart: { kind: 'link'; value: string; caption: string; quotedMsgId?: string } = { 
              kind: 'link', 
              value: url, 
              caption: textBeforeUrl 
            };
            if (quotedMsgId) linkPart.quotedMsgId = quotedMsgId;
            outgoingParts.push(linkPart);
          } else {
            // Just add as text
            if (block.trim()) {
              const textPart: { kind: 'text'; value: string; quotedMsgId?: string } = { kind: 'text', value: block };
              if (quotedMsgId) textPart.quotedMsgId = quotedMsgId;
              outgoingParts.push(textPart);
            }
          }
        } else {
          // No URL found, add as regular text
          if (block.trim()) {
            const textPart: { kind: 'text'; value: string; quotedMsgId?: string } = { kind: 'text', value: block };
            if (quotedMsgId) textPart.quotedMsgId = quotedMsgId;
            outgoingParts.push(textPart);
          }
        }
      }
    }
    
    // If no blocks found at all, return the whole text as one part
    if (outgoingParts.length === 0 && text.trim()) {
      outgoingParts.push({ kind: 'text', value: text });
    }
    
    // Restore protected code blocks
    const restoredParts = outgoingParts.map(part => {
      if (part.kind === 'text') {
        let restoredValue = part.value;
        restoredValue = restoredValue.replace(/__PROTECTED_CODE_(\d+)__/g, (_m, i) => {
          return codeBlockTokens[Number(i)] || '';
        });
        return { ...part, value: restoredValue };
      }
      return part;
    });
    
    return restoredParts;
  }

  private splitMessageIntoParts(message: string): string[] {
    const maxLength = 4000;
    if (message.length <= maxLength) {
      return [message];
    }

    const parts: string[] = [];
    let remaining = message;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        parts.push(remaining);
        break;
      }

      // Find the last complete sentence within the limit
      let cutPoint = maxLength;
      const lastSentenceEnd = remaining.lastIndexOf('. ', maxLength);
      const lastParagraphEnd = remaining.lastIndexOf('\n\n', maxLength);
      
      if (lastSentenceEnd > maxLength * 0.7) {
        cutPoint = lastSentenceEnd + 1;
      } else if (lastParagraphEnd > maxLength * 0.7) {
        cutPoint = lastParagraphEnd + 2;
      }

      parts.push(remaining.substring(0, cutPoint).trim());
      remaining = remaining.substring(cutPoint).trim();
    }

    return parts;
  }

  private async callInferenceFw(message: string, phoneNumber: string, userName: string, clientId: string): Promise<any> {
    try {
      // Get agent code for this client
      const agentCode = await this.whatsappService.getClientAgent(clientId);
      if (!agentCode) {
        console.log(`⚠️ No agent assigned to client ${clientId}`);
        return { text: "Please connect to an agent" };
      }

      console.log(`🤖 Using agent code: ${agentCode} for client ${clientId}`);

      // Get AI endpoint URL
      let url = this.env.FW_ENDPOINT || 'http://localhost:3000/api/agents/generalAssistanceAgent/generate/vnext';
      // Ensure URL has protocol
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
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
        phone: phoneNumber || 'unknown',
        role: 'authenticated',
        agent_metadata: {
          agent_code: agentCode,
          status: "active",
          agent_phone: agentPhone,
          agent_name: agentName,
          client_id: clientId
        },
        app_metadata: {
          provider: 'wa',
          providers: ['wa']
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

      console.log(`🔐 JWT Payload before signing:`, JSON.stringify(payload, null, 2));
      const authToken = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

      // threadId = agentCode:phoneNumber:whatsapp, resourceId = agentCode:phoneNumber
      const formattedPhoneNumber = phoneNumber || 'unknown';

      const requestBody = {
        messages: [message],
        threadId: `${agentCode}:${formattedPhoneNumber}:whatsapp`,
        resourceId: `${agentCode}:${formattedPhoneNumber}`
      };

      console.log(`🤖 Request URL: ${url}`);

      const response = await axios.post(url, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        timeout: parseInt(this.env.AI_REQUEST_TIMEOUT || '240000', 10) // 4 minutes default, configurable
      });

      console.log(`🤖 Response Status: ${response.status} ${response.status >= 200 && response.status < 300 ? '✅' : '❌'}`);

      const rsp = response.data;
      const jsonData = {
        text: rsp.text || rsp.message || '',
        usage: rsp.usage || {}
      };

      return jsonData;

    } catch (error) {
      console.error('❌ Error calling AI API:', error);
      throw error;
    }
  }
}

export default WPPConnectMessageHandler;
