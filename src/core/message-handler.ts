import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment, ChatMessage } from '../types';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import FormData from 'form-data';
import { MEMORY_CONFIG, getMemoryUsage, suggestGC } from '../config/memory-config';

// ============================================
// WPPConnect Message Handler
// ============================================

export class WPPConnectMessageHandler {
  private messageQueue: { [senderNumber: string]: Array<{ message: any; enhancedText?: string; mediaUrls?: string[]; timestamp: number }> } = {};
  private processingUsers: { [senderNumber: string]: number } = {};
  private env: Environment;
  private tempDir: string;
  private readonly MAX_QUEUE_SIZE = MEMORY_CONFIG.MAX_QUEUE_SIZE;
  private readonly MAX_QUEUE_AGE = MEMORY_CONFIG.MAX_QUEUE_AGE;

  constructor(
    private whatsappService: WPPConnectWhatsAppService,
    env: Environment
  ) {
    this.env = env;
    this.tempDir = path.join(process.cwd(), 'temp');
    
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

  private cleanupMessageQueue(): void {
    const now = Date.now();
    let totalCleaned = 0;

    for (const [senderNumber, messages] of Object.entries(this.messageQueue)) {
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
        this.messageQueue[senderNumber] = validMessages;
        totalCleaned += cleaned;
      }

      // Remove empty queues
      if (validMessages.length === 0) {
        delete this.messageQueue[senderNumber];
      }
    }

    if (totalCleaned > 0) {
      console.log(`🧹 Cleaned up ${totalCleaned} old messages from queue`);
    }
  }

  public async handleIncomingMessage(clientId: string, message: any): Promise<void> {
    try {
      console.log(`📨 MESSAGE RECEIVED from WPPConnect client ${clientId}: ${message.from}`);
      console.log(`📨 MESSAGE BODY: ${message.body}`);
      console.log(`📨 MESSAGE TIMESTAMP: ${new Date().toISOString()}`);

      const senderNumber = message.from.replace('@c.us', '');
      console.log(`📨 Sender number: ${senderNumber}`);

      // Check if we're in production mode
      const isProduction = this.env.NODE_ENV === 'production';
      console.log(`📨 Production mode: ${isProduction}`);

      // Get allowed numbers from environment
      const allowedNumbers = this.env.ALLOWED_NUMBERS ? this.env.ALLOWED_NUMBERS.split(',') : [];
      console.log(`📨 Allowed numbers: ${JSON.stringify(allowedNumbers)}`);

      // In production, check if sender is allowed
      if (isProduction && allowedNumbers.length > 0 && !allowedNumbers.includes(senderNumber)) {
        console.log(`📨 Sender ${senderNumber} not in allowed list, ignoring message`);
        return;
      }

      console.log(`📨 Processing message in production mode`);

      // IMPORTANT: Check if this is a media message FIRST to avoid sending base64 to AI
      const isMediaMsg = this.isMediaMessage(message);
      let enhancedMessage = '';
      
      if (isMediaMsg) {
        // For media: ONLY use caption, NEVER use body (which contains base64)
        enhancedMessage = message.caption || '';
        console.log(`📨 Media message detected - using caption only: "${enhancedMessage}"`);
      } else {
        // For text: use body
        enhancedMessage = message.body || '';
        console.log(`📨 Text message body: "${enhancedMessage}"`);
      }

      // Handle quoted messages (WPPConnect format)
      if (message.hasQuotedMsg || message.quotedMsg) {
        try {
          const quoted = message.quotedMsg || (message.hasQuotedMsg ? await message.getQuotedMessage() : null);
          if (quoted && quoted.body) {
            enhancedMessage = `Replying to this message: "${quoted.body}"\n${enhancedMessage}`;
            console.log(`📝 Enhanced message with quoted context: "${enhancedMessage}"`);
          }
        } catch (error) {
          console.error('❌ Error getting quoted message:', error);
          // Continue with original message if quoted message retrieval fails
        }
      } else {
        console.log(`📨 Message quoted: false`);
      }

      // Handle media attachments (WPPConnect format)
      let mediaUrls: string[] = [];
      if (isMediaMsg) {
        console.log(`📨 Message has media attachment: ${message.type}`);
        try {
          mediaUrls = await this.handleMediaMessage(message);
          console.log(`📎 Media URLs generated: ${mediaUrls.length} file(s)`);
        } catch (error) {
          console.error('❌ Error handling media message:', error);
        }
      } else {
        console.log(`📨 Message is text-only (type: ${message.type})`);
      }

      // If user is already being processed (typing started), mark this message as read immediately
      if (this.processingUsers[senderNumber]) {
        console.log(`📖 User ${senderNumber} is already being processed, marking as read immediately`);
        try {
          const clients = this.whatsappService.getAllClients();
          const client = clients.find(c => c.isReady);
          
          if (client && client.client) {
            const chatId = `${senderNumber}@c.us`;
            await client.client.sendSeen(chatId);
            console.log(`✅ Marked additional message as read for ${senderNumber}`);
          }
        } catch (error) {
          console.log('⚠️ Could not mark additional message as read:', error);
        }
      }

      // Add to message queue
      this.addToQueue(senderNumber, message, enhancedMessage, mediaUrls);

      // Start processing with delay
      const delay = 10000; // 10 seconds
      console.log(`🔄 handleIncomingMessage called for ${senderNumber} with delay ${delay}ms`);
      this.startProcessing(senderNumber, delay);

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

  private async handleMediaMessage(message: any): Promise<string[]> {
    const mediaUrls: string[] = [];
    
    try {
      console.log('📎 Processing media attachment...');
      console.log('📎 Message type:', message.type);
      console.log('📎 Message ID:', message.id);
      
      // Get client to use downloadMedia method
      const clients = this.whatsappService.getAllClients();
      const client = clients.find(c => c.isReady);
      
      if (!client || !client.client) {
        console.log('⚠️ No ready client available for media download');
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

  private addToQueue(senderNumber: string, message: any, enhancedMessage: string, mediaUrls: string[]): void {
    if (!this.messageQueue[senderNumber]) {
      this.messageQueue[senderNumber] = [];
    }

    this.messageQueue[senderNumber].push({
      message,
      enhancedText: enhancedMessage,
      mediaUrls,
      timestamp: Date.now()
    });
  }

  private startProcessing(senderNumber: string, delay: number): void {
    if (this.processingUsers[senderNumber]) {
      return; // Already processing
    }

    console.log(`🚀 Starting initial processing for ${senderNumber}`);
    this.processingUsers[senderNumber] = 1;

    // Send read receipt and start typing indicator
    const preDelayMs = 1000; // 1 second before typing
    const readTypingTimer = setTimeout(async () => {
      try {
        const clients = this.whatsappService.getAllClients();
        const client = clients.find(c => c.isReady);
        
        if (client && client.client) {
          const chatId = `${senderNumber}@c.us`;
          await client.client.sendSeen(chatId);
          await client.client.startTyping(chatId);
          console.log(`✅ Sent read receipt and typing indicator for ${senderNumber}`);
        }
      } catch (error) {
        console.log('⚠️ Could not send read/typing indicators:', error);
      }
    }, preDelayMs);

    (this.processingUsers as any)[`${senderNumber}_readTypingTimer`] = readTypingTimer;

    // Set initial timer
    console.log(`⏰ Initial timer set for ${senderNumber} (${delay}ms)`);
    setTimeout(() => {
      this.processQueuedMessages(senderNumber);
    }, delay);
  }

  private async processQueuedMessages(senderNumber: string): Promise<void> {
    try {
      const messages = this.messageQueue[senderNumber] || [];
      if (messages.length === 0) {
        console.log(`⚠️ No messages in queue for ${senderNumber}`);
        this.cleanupProcessingState(senderNumber);
        return;
      }

      console.log(`🔄 FINAL PROCESSING: ${messages.length} messages from ${senderNumber} after timer expired`);

      // Combine all messages and media URLs
      const combinedMessages = messages.map(item => {
        let messageText = item.enhancedText !== undefined ? item.enhancedText : '';
        if (item.mediaUrls && item.mediaUrls.length > 0) {
          messageText += `\nMedia attached:\n- @[${item.mediaUrls.join(']\n- @[')}]`;
        }
        return messageText;
      }).join(' ');
      console.log(`📝 Combined messages: "${combinedMessages}"`);

      // Get client info
      const clients = this.whatsappService.getAllClients();
      const client = clients.find(c => c.isReady);
      
      if (!client) {
        console.log('⚠️ No ready WPPConnect client available');
        this.cleanupProcessingState(senderNumber);
        return;
      }

      // Send to AI and respond
      await this.sendMessage(client.clientId, senderNumber, combinedMessages, null, false, null);

      // Stop typing indicator
      try {
        if (client && client.client) {
          const chatId = `${senderNumber}@c.us`;
          await client.client.stopTyping(chatId);
          console.log(`✅ Stopped typing indicator for ${senderNumber}`);
        }
      } catch (error) {
        console.log('⚠️ Could not stop typing indicator:', error);
      }

      // Clean up
      this.cleanupProcessingState(senderNumber);

    } catch (error) {
      console.error(`❌ Error processing messages for ${senderNumber}:`, error);
      this.cleanupProcessingState(senderNumber);
    }
  }

  private cleanupProcessingState(senderNumber: string): void {
    delete this.messageQueue[senderNumber];
    delete this.processingUsers[senderNumber];
    delete (this.processingUsers as any)[`${senderNumber}_timer`];
    delete (this.processingUsers as any)[`${senderNumber}_readTypingTimer`];
    console.log(`🧹 Cleaned up processing state for ${senderNumber}`);
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
      
      // Code blocks: format content for WhatsApp (no triple backticks, just monospace)
      formattedContent = formattedContent.replace(/__CODEBLOCK_(\d+)__/g, (_m, i) => {
        const codeContent = codeBlocks[Number(i)] ?? '';
        // Remove language identifier if present (e.g., ```javascript\n...)
        const cleanCode = codeContent.replace(/^[a-z]+\n/i, '');
        // Format each line with monospace and preserve line breaks
        const formattedCode = cleanCode
          .split('\n')
          .map(line => line.trim() ? `\`${line}\`` : '')
          .filter(Boolean)
          .join('\n');
        return formattedCode;
      });

      console.log('✅ WhatsApp formatting completed', {
        originalLength,
        formattedLength: formattedContent.length,
        reduction: originalLength - formattedContent.length
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
        const response = await this.whatsappService.sendMessage(clientId, formattedNumber, message);
        console.log('Message sent successfully:');
        return;
      } 

      // Get user contact information
      let userName: string = 'WhatsApp User';
      try {
        const client = this.whatsappService.getClient(clientId);
        if (client) {
          // WPPConnect doesn't have direct contact access, use default
          userName = 'WhatsApp User';
        }
      } catch (error) {
        console.log('Could not get contact info, using default name');
      }

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
        // Format the response for WhatsApp
        const formattedResponse = this.convertLLMToWhatsApp(aiagent.text);
        console.log(`✅ WhatsApp formatting completed { originalLength: ${aiagent.text.length}, formattedLength: ${formattedResponse.length}, reduction: ${aiagent.text.length - formattedResponse.length} }`);
        
        // Parse response for media URLs and text parts
        const outgoingParts = this.parseResponseForMedia(formattedResponse);
        console.log(`📝 Prepared ${outgoingParts.length} outgoing part(s) for ${formattedNumber}`);
        
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
              
              // Check if it's a sticker (starts with #sticker:)
              if (mediaUrl.startsWith('#sticker:')) {
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
            // Send text part - check for sticker patterns
            try {
              const textContent = String(part.value);
              
              // Check if text contains #sticker: pattern
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
                  await client.client.sendText(formattedNumber || '', remainingText);
                  console.log(`✅ Sent remaining text: ${remainingText}`);
                }
              } else {
                // Regular text
                await client.client.sendText(formattedNumber || '', textContent);
                console.log(`✅ Sent text part`);
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
        
        console.log('Message sent successfully:', formattedResponse);
        
      } catch (error) {
        console.error('❌ Error sending message:', error);
      }
      
    } catch (error) {
      console.error('❌ Error in sendMessage:', error);
    }
  }

  private parseResponseForMedia(text: string): Array<{ kind: 'text' | 'media' | 'link', value: string, caption?: string }> {
    const outgoingParts: Array<{ kind: 'text' | 'media' | 'link', value: string, caption?: string }> = [];
    
    // Pre-process text to remove duplicate URLs in parentheses
    // Pattern: url (url) -> url
    text = text.replace(/(https?:\/\/[^\s]+)\s+\(\1\)/g, '$1');
    
    // First, extract sticker patterns: #sticker: url or #sticker url
    const stickerRegex = /#sticker:?\s*(https?:\/\/[^\s\)]+)/gi;
    const extractedMediaList: { url: string; caption?: string; isSticker?: boolean }[] = [];
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
    
    // Split by double newlines to create separate chat bubbles (matching main branch)
    const rawBlocks = withMediaTokens.split('\n\n').map(b => b.trim()).filter(Boolean);
    
    // Build regex to match media URLs by extension
    const mediaExtPattern = '(?:png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a|aac)';
    
    // Process each block separately
    for (const block of rawBlocks) {
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
          outgoingParts.push({ kind: 'text', value: textBefore });
        }
        
        if (match[1]) {
          // Media token: [[MEDIA_n]]
          const idx = Number(match[2] ?? -1);
          const meta = extractedMediaList[idx];
          if (meta && meta.url) {
            // If it's a sticker, prefix with #sticker:
            const mediaUrl = meta.isSticker ? `#sticker:${meta.url}` : meta.url;
            const mediaPart: { kind: 'media'; value: string; caption?: string } = { kind: 'media', value: mediaUrl };
            if (meta.caption) {
              mediaPart.caption = meta.caption;
            }
            outgoingParts.push(mediaPart);
          } else {
            // Fallback: keep the token textually if something went wrong
            outgoingParts.push({ kind: 'text', value: match[0] });
          }
        } else {
          // Either @media url (group 3) or bare media url (group 4)
          const mediaUrl = (match[3] || match[4]) ?? '';
          if (mediaUrl) {
            const cleanedUrl = this.cleanupUrl(mediaUrl);
            outgoingParts.push({ kind: 'media', value: cleanedUrl });
          }
        }
        
        lastIndex = match.index + match[0].length;
      }
      
      // If media was found, add remaining text after last media URL
      if (foundMedia) {
        const textAfter = block.slice(lastIndex).trim();
        if (textAfter) {
          outgoingParts.push({ kind: 'text', value: textAfter });
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
            outgoingParts.push({ 
              kind: 'link', 
              value: url, 
              caption: textBeforeUrl 
            });
          } else {
            // Just add as text
            if (block.trim()) {
              outgoingParts.push({ kind: 'text', value: block });
            }
          }
        } else {
          // No URL found, add as regular text
          if (block.trim()) {
            outgoingParts.push({ kind: 'text', value: block });
          }
        }
      }
    }
    
    // If no blocks found at all, return the whole text as one part
    if (outgoingParts.length === 0 && text.trim()) {
      outgoingParts.push({ kind: 'text', value: text });
    }
    
    console.log(`📝 Parsed ${outgoingParts.length} outgoing part(s) from text:`, outgoingParts.map(p => ({ kind: p.kind, length: p.value.length })));
    return outgoingParts;
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

      // Generate JWT token with proper payload structure (matching main branch)
      const payload = {
        iss: 'whatsapp-bot',
        sub: 'custom-user-id',
        aud: 'authenticated',
        iat: Math.floor(Date.now() / 1000),
        phone: phoneNumber || 'unknown',
        role: 'authenticated',
        agent_metadata: {
          agent_code: agentCode,
          status: "active",
        },
        app_metadata: {
          provider: 'wa',
          providers: ['wa']
        },
        user_metadata: {
          phone: phoneNumber || 'unknown',
          phone_verified: true,
          full_name: userName || 'WhatsApp User',
          sub: 'custom-user-id',
          campaign_id: '6a793f4c-609d-4507-ad4f-d6d25c1218c8',
          participant_name: userName || 'WhatsApp User',
          participant_phone: phoneNumber || 'unknown'
        }
      };

      const authToken = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

      // Format the phone number for threadId and resourceId
      const formattedPhoneNumber = phoneNumber || 'unknown';

      const requestBody = {
        messages: [message],
        threadId: formattedPhoneNumber,
        resourceId: formattedPhoneNumber
      };

      console.log(`🤖 Request URL: ${url}`);

      const response = await axios.post(url, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        timeout: 30000
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
