import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import { Environment, ChatMessage } from '../types';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import FormData from 'form-data';

// ============================================
// WPPConnect Message Handler
// ============================================

export class WPPConnectMessageHandler {
  private messageQueue: { [senderNumber: string]: Array<{ message: any; enhancedText?: string; mediaUrls?: string[]; timestamp: number }> } = {};
  private processingUsers: { [senderNumber: string]: number } = {};
  private env: Environment;
  private tempDir: string;
  private readonly MAX_QUEUE_SIZE = 50; // Reduced from 100 to 50 for memory optimization
  private readonly MAX_QUEUE_AGE = 180000; // Reduced from 5 minutes to 3 minutes for memory optimization

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
  }

  private startQueueCleanup(): void {
    // Clean up old messages every 3 minutes (increased from 2 minutes)
    setInterval(() => {
      this.cleanupMessageQueue();
    }, 180000); // 3 minutes
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

      // Handle quoted messages (WPPConnect format)
      let enhancedMessage = message.body;
      if (message.quotedMsg && message.quotedMsg.body) {
        console.log(`📨 Message quoted: true`);
        enhancedMessage = `Replying to this message: "${message.quotedMsg.body}"\n${message.body}`;
      } else {
        console.log(`📨 Message quoted: false`);
      }

      // Handle media attachments (WPPConnect format)
      let mediaUrls: string[] = [];
      if (message.type === 'image' || message.type === 'video' || message.type === 'audio' || message.type === 'document') {
        console.log(`📨 Message has media attachment: ${message.type}`);
        try {
          mediaUrls = await this.handleMediaMessage(message);
          if (mediaUrls.length > 0) {
            enhancedMessage += `\n[Media: ${mediaUrls.join(', ')}]`;
          }
        } catch (error) {
          console.error('❌ Error handling media message:', error);
        }
      } else {
        console.log(`📨 Message raw: false`);
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

  private async handleMediaMessage(message: any): Promise<string[]> {
    const mediaUrls: string[] = [];
    
    try {
      // Download media from WPPConnect
      const media = await message.downloadMedia();
      if (!media) {
        console.log('⚠️ No media data received');
        return mediaUrls;
      }

      // Generate unique filename
      const fileExtension = this.getFileExtensionFromMimeType(media.mimetype);
      const filename = `${crypto.randomUUID()}.${fileExtension}`;
      const filePath = path.join(this.tempDir, filename);

      // Save media to temporary file
      fs.writeFileSync(filePath, media.data, 'base64');

      // Upload to tmpfile.link
      const mediaUrl = await this.uploadToTmpFile(filePath, filename, media.mimetype);
      if (mediaUrl) {
        mediaUrls.push(mediaUrl);
      }

      // Clean up temporary file
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.error('❌ Error cleaning up temporary file:', cleanupError);
      }

    } catch (error) {
      console.error('❌ Error handling media message:', error);
    }

    return mediaUrls;
  }

  private getFileExtensionFromMimeType(mimetype: string): string {
    const mimeMap: { [key: string]: string } = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/avi': 'avi',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
    };

    return mimeMap[mimetype] || 'bin';
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

      if (response.data && response.data.url) {
        console.log(`✅ Media uploaded to tmpfile.link: ${response.data.url}`);
        return response.data.url;
      } else {
        console.error('❌ Invalid response from tmpfile.link:', response.data);
        return null;
      }
    } catch (error) {
      console.error('❌ Error uploading to tmpfile.link:', error);
      return null;
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

      // Combine all messages
      const combinedMessages = messages.map(item => item.enhancedText || item.message.body).join(' ');
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
    if (!content) return '';

    let formatted = content;

    if (preserveStructure) {
      // Convert markdown-style formatting to WhatsApp formatting
      formatted = formatted
        .replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold: **text** -> *text*
        .replace(/\*(.*?)\*/g, '_$1_')     // Italic: *text* -> _text_
        .replace(/~~(.*?)~~/g, '~$1~')    // Strikethrough: ~~text~~ -> ~text~
        .replace(/`(.*?)`/g, '```$1```')  // Code: `text` -> ```text```
        .replace(/```(.*?)```/gs, '```\n$1\n```'); // Code blocks
    }

    // Split long messages into parts (WhatsApp limit is 4096 characters)
    const maxLength = 4000; // Leave some buffer
    if (formatted.length <= maxLength) {
      return formatted;
    }

    // Split by paragraphs first
    const paragraphs = formatted.split('\n\n');
    const parts: string[] = [];
    let currentPart = '';

    for (const paragraph of paragraphs) {
      if (currentPart.length + paragraph.length + 2 <= maxLength) {
        currentPart += (currentPart ? '\n\n' : '') + paragraph;
      } else {
        if (currentPart) {
          parts.push(currentPart);
          currentPart = paragraph;
        } else {
          // Single paragraph is too long, split by sentences
          const sentences = paragraph.split('. ');
          let currentSentence = '';
          
          for (const sentence of sentences) {
            if (currentSentence.length + sentence.length + 2 <= maxLength) {
              currentSentence += (currentSentence ? '. ' : '') + sentence;
            } else {
              if (currentSentence) {
                parts.push(currentSentence);
                currentSentence = sentence;
              } else {
                // Single sentence is too long, force split
                parts.push(sentence.substring(0, maxLength));
                currentSentence = sentence.substring(maxLength);
              }
            }
          }
          
          if (currentSentence) {
            currentPart = currentSentence;
          }
        }
      }
    }

    if (currentPart) {
      parts.push(currentPart);
    }

    return parts.length > 1 ? (parts[0] || '') : (formatted || '');
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
        
        // Split into parts if needed
        const parts = this.splitMessageIntoParts(formattedResponse);
        console.log(`📝 Prepared ${parts.length} outgoing part(s) for ${formattedNumber}`);
        
        // Send each part with delay
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          await this.whatsappService.sendMessage(clientId, formattedNumber || '', part || '');
          console.log(`✅ Sent text part`);
          
          // Add delay between parts (except for the last one)
          if (i < parts.length - 1) {
            const delay = Math.random() * 2000 + 1000; // 1-3 seconds
            console.log(`⏳ Waiting ${Math.round(delay)}ms before next part`);
            await new Promise(resolve => setTimeout(resolve, delay));
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
