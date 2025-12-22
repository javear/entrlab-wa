const axios = require('axios');
const jwt = require('jsonwebtoken');
const clientManager = require('./client-manager');
const WhatsAppMessageController = require('../controllers/message.controller');

/**
 * WhatsApp Official Message Handler
 * Handles incoming messages with queueing, delay, and AI workflow processing
 * Similar to WPPConnect message handler but uses Meta's official REST API
 */
class WhatsAppOfficialMessageHandler {
  constructor() {
    this.messageQueue = {}; // { "clientId:phoneNumber": [{ message, enhancedText, mediaUrls, timestamp }] }
    this.processingUsers = {}; // { "clientId:phoneNumber": timestamp }
    this.readReceiptSent = {}; // { "clientId:phoneNumber": boolean }
    this.contactInfo = {}; // { "clientId:phoneNumber": { name, phone } }
    this.messageController = new WhatsAppMessageController();
    this.clientManager = clientManager;
    this.env = {
      FW_ENDPOINT_WORKFLOW: process.env.FW_ENDPOINT_WORKFLOW,
      JWT_SECRET: process.env.JWT_SECRET,
      NODE_ENV: process.env.NODE_ENV,
      ALLOWED_NUMBERS: process.env.ALLOWED_NUMBERS,
      AI_REQUEST_TIMEOUT: process.env.AI_REQUEST_TIMEOUT || '300000'
    };
    
    // Start queue cleanup interval
    this.startQueueCleanup();
  }

  /**
   * Helper to create unique key per client+user
   */
  getUserKey(clientId, senderNumber) {
    return `${clientId}:${senderNumber}`;
  }

  /**
   * Start queue cleanup interval (clean up old messages every 5 minutes)
   */
  startQueueCleanup() {
    setInterval(() => {
      this.cleanupMessageQueue();
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Clean up old messages from queue
   */
  cleanupMessageQueue() {
    const now = Date.now();
    const MAX_QUEUE_AGE = 5 * 60 * 1000; // 5 minutes
    let totalCleaned = 0;

    for (const [userKey, messages] of Object.entries(this.messageQueue)) {
      const validMessages = messages.filter(msg => {
        const age = now - msg.timestamp;
        return age < MAX_QUEUE_AGE;
      });

      const cleaned = messages.length - validMessages.length;
      if (cleaned > 0) {
        this.messageQueue[userKey] = validMessages;
        totalCleaned += cleaned;
      }

      if (validMessages.length === 0) {
        delete this.messageQueue[userKey];
      }
    }

    if (totalCleaned > 0) {
      console.log(`🧹 Cleaned up ${totalCleaned} old messages from queue`);
    }
  }

  /**
   * Check if user is in needAttention with block/pause status
   * @param clientId - The client ID
   * @param userIdentifier - The user identifier (message.from for WA-Official)
   * @returns true if user should be blocked/paused, false otherwise
   */
  async checkNeedAttention(clientId, userIdentifier) {
    try {
      await this.clientManager.initialize();
      const ClientAgent = this.clientManager.getClientAgentModel();
      
      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      }).lean();

      if (!client) {
        return false; // No client found, allow message
      }

      const needAttentionList = client.needAttention || [];
      
      // Find matching userIdentifier
      const needAttentionItem = needAttentionList.find(
        item => item.userIdentifier === userIdentifier && (item.option === 'block' || item.option === 'pause')
      );

      if (!needAttentionItem) {
        return false; // User not in needAttention, allow message
      }

      // Check if there's a 'to' date and if it's expired
      if (needAttentionItem.to) {
        const expiryDate = new Date(needAttentionItem.to);
        const now = new Date();
        if (now > expiryDate) {
          // Expired, allow message
          return false;
        }
      }

      // User is blocked/paused and not expired
      const option = needAttentionItem.option === 'block' ? 'blocked' : 'paused';
      const reason = needAttentionItem.reason ? ` (reason: ${needAttentionItem.reason})` : '';
      console.log(`🚫 [${clientId}] User ${userIdentifier} is ${option} - skipping message${reason}`);
      return true;
    } catch (error) {
      console.error(`❌ Error checking needAttention for ${userIdentifier}:`, error.message);
      // On error, fail open - allow message
      return false;
    }
  }

  /**
   * Handle incoming message from webhook
   * Similar to WPPConnect's handleIncomingMessage
   */
  async handleIncomingMessage(clientId, message, contact, metadata) {
    try {
      const senderPhoneNumber = message.from;
      const userKey = this.getUserKey(clientId, senderPhoneNumber);

      // Check needAttention status first (before any message actions)
      // For WA-Official, userIdentifier is message.from (sender's phone number)
      const isBlockedOrPaused = await this.checkNeedAttention(clientId, senderPhoneNumber);
      if (isBlockedOrPaused) {
        return; // Skip all message actions (no read, typing, reply, etc.)
      }

      // Extract and store contact information
      const contactInfo = {
        name: contact?.profile?.name || senderPhoneNumber,
        phone: senderPhoneNumber
      };
      this.contactInfo[userKey] = contactInfo;

      // Check if user is paused (we'll implement this later)
      // const isPaused = await this.userPauseService.isUserPaused(clientId, senderPhoneNumber);
      // if (isPaused) {
      //   console.log(`⏸️  [${clientId}] User ${senderPhoneNumber} is paused - skipping message`);
      //   return;
      // }

      // Check if we're in production mode and validate allowed numbers
      const isProduction = this.env.NODE_ENV === 'production';
      const allowedNumbers = this.env.ALLOWED_NUMBERS ? this.env.ALLOWED_NUMBERS.split(',') : [];

      if (isProduction && allowedNumbers.length > 0 && !allowedNumbers.includes(senderPhoneNumber)) {
        console.log(`🚫 [${clientId}] Message from ${senderPhoneNumber} blocked (not in ALLOWED_NUMBERS)`);
        return;
      }

      // Extract message content based on type
      let enhancedMessage = '';
      let mediaUrls = [];

      switch (message.type) {
        case 'text':
          enhancedMessage = message.text?.body || '';
          // Handle context (reply to message)
          if (message.context?.referred_product) {
            // Interactive message reply
            enhancedMessage = `Replying to interactive message: ${enhancedMessage}`;
          } else if (message.context?.id) {
            enhancedMessage = `Replying to message ${message.context.id}: ${enhancedMessage}`;
          }
          break;

        case 'image':
          const imageId = message.image?.id;
          if (imageId) {
            const imageUrl = await this.downloadMediaFromMeta(clientId, imageId);
            if (imageUrl) {
              mediaUrls.push(imageUrl);
            }
          }
          enhancedMessage = message.image?.caption || '';
          break;

        case 'video':
          const videoId = message.video?.id;
          if (videoId) {
            const videoUrl = await this.downloadMediaFromMeta(clientId, videoId);
            if (videoUrl) {
              mediaUrls.push(videoUrl);
            }
          }
          enhancedMessage = message.video?.caption || '';
          break;

        case 'audio':
          const audioId = message.audio?.id;
          if (audioId) {
            const audioUrl = await this.downloadMediaFromMeta(clientId, audioId);
            if (audioUrl) {
              mediaUrls.push(audioUrl);
            }
          }
          enhancedMessage = 'Audio message received';
          break;

        case 'document':
          const documentId = message.document?.id;
          if (documentId) {
            const documentUrl = await this.downloadMediaFromMeta(clientId, documentId);
            if (documentUrl) {
              mediaUrls.push(documentUrl);
            }
          }
          enhancedMessage = message.document?.caption || message.document?.filename || 'Document received';
          break;

        case 'location':
          const latitude = message.location?.latitude;
          const longitude = message.location?.longitude;
          const locationName = message.location?.name;
          enhancedMessage = `Location: Latitude=${latitude}, Longitude=${longitude}${locationName ? `, Name: ${locationName}` : ''}`;
          break;

        case 'interactive':
          // Handle button replies, list replies, etc.
          // Reference: https://developers.facebook.com/docs/whatsapp/webhooks/reference/messages/interactive
          if (message.interactive?.type === 'button_reply') {
            enhancedMessage = message.interactive.button_reply?.title || 'Button clicked';
            const buttonId = message.interactive.button_reply?.id;
            if (buttonId) {
              enhancedMessage += ` (ID: ${buttonId})`;
            }
          } else if (message.interactive?.type === 'list_reply') {
            enhancedMessage = message.interactive.list_reply?.title || 'List item selected';
            const listDescription = message.interactive.list_reply?.description;
            if (listDescription) {
              enhancedMessage += ` - ${listDescription}`;
            }
            const listId = message.interactive.list_reply?.id;
            if (listId) {
              enhancedMessage += ` (ID: ${listId})`;
            }
          }
          break;

        case 'button':
          // Button message (when user clicks a button)
          // Reference: https://developers.facebook.com/docs/whatsapp/webhooks/reference/messages/button
          if (message.button?.payload) {
            enhancedMessage = `Button clicked: ${message.button.payload}`;
          } else if (message.button?.text) {
            enhancedMessage = `Button: ${message.button.text}`;
          }
          break;

        case 'sticker':
          const stickerId = message.sticker?.id;
          if (stickerId) {
            const stickerUrl = await this.downloadMediaFromMeta(clientId, stickerId);
            if (stickerUrl) {
              mediaUrls.push(stickerUrl);
            }
          }
          enhancedMessage = 'Sticker received';
          break;

        case 'reaction':
          // Reaction messages - user reacted to a previous message
          // Reference: https://developers.facebook.com/docs/whatsapp/webhooks/reference/messages/reaction
          const reactionEmoji = message.reaction?.emoji || '👍';
          const reactedToMessageId = message.reaction?.message_id;
          if (reactedToMessageId) {
            enhancedMessage = `Reaction: ${reactionEmoji} to message ${reactedToMessageId}`;
          } else {
            enhancedMessage = `Reaction: ${reactionEmoji}`;
          }
          // Note: Reactions are typically not sent to AI workflow, but we'll include them for completeness
          break;

        default:
          console.log(`⚠️  Unknown message type: ${message.type}`);
          enhancedMessage = `Message type: ${message.type}`;
      }

      // Format message with metadata (similar to WPPConnect format)
      const messageId = message.id;
      const timestamp = message.timestamp;
      const formattedTimestamp = this.formatTimestamp(timestamp);
      const metadataPrefix = `[#messageid:${messageId}#message-timestamp:${formattedTimestamp}]`;

      // Add media URLs if any
      if (mediaUrls.length > 0) {
        if (enhancedMessage) {
          enhancedMessage += `\nMedia attached:\n- @[${mediaUrls.join(']\n- @[')}]`;
        } else {
          enhancedMessage = `Media attached:\n- @[${mediaUrls.join(']\n- @[')}]`;
        }
      }

      const fullMessage = enhancedMessage ? `${metadataPrefix} ${enhancedMessage}` : `${metadataPrefix}`;

      // Add to message queue
      // Note: For private agent assignment, we use senderPhoneNumber (message.from) as userIdentifier
      this.addToQueue(clientId, senderPhoneNumber, message, fullMessage, mediaUrls);

      // If user is already being processed, we'll mark the last message as read
      // (which will mark all previous messages as read in WhatsApp)
      // This is handled in the readReceiptTimer below

      // Start processing with delay (similar to WPPConnect's 16 seconds)
      const delay = 16000; // 16 seconds
      this.startProcessing(clientId, senderPhoneNumber, delay);

    } catch (error) {
      console.error(`❌ Error handling incoming message for client ${clientId}:`, error);
    }
  }

  /**
   * Download media from Meta's API
   * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
   */
  async downloadMediaFromMeta(clientId, mediaId) {
    try {
      const accessToken = await this.clientManager.getAccessToken(clientId);
      if (!accessToken) {
        console.error(`❌ No access token for client ${clientId}`);
        return null;
      }

      // Get media URL from Meta
      const mediaUrlResponse = await axios.get(
        `https://graph.facebook.com/v21.0/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      const mediaUrl = mediaUrlResponse.data?.url;
      if (!mediaUrl) {
        console.error(`❌ No URL in media response for ${mediaId}`);
        return null;
      }

      // Download media from the URL
      const mediaResponse = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        responseType: 'arraybuffer'
      });

      // Upload to tmpfile.link (similar to WPPConnect)
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('file', Buffer.from(mediaResponse.data), {
        filename: `${mediaId}.bin`,
        contentType: mediaResponse.headers['content-type'] || 'application/octet-stream'
      });

      const uploadResponse = await axios.post('https://tmpfile.link/api/upload', formData, {
        headers: formData.getHeaders(),
        timeout: 30000
      });

      if (uploadResponse.data?.downloadLink) {
        return uploadResponse.data.downloadLink;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error downloading media ${mediaId} from Meta:`, error.message);
      return null;
    }
  }

  /**
   * Format timestamp
   */
  formatTimestamp(timestamp) {
    try {
      const date = new Date(timestamp * 1000);
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Jakarta' });
      const isoDateTime = date.toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T');
      return `${dayOfWeek}, ${isoDateTime}+07:00 (GMT+7)`;
    } catch (error) {
      return String(timestamp);
    }
  }

  /**
   * Add message to queue
   */
  addToQueue(clientId, senderNumber, message, enhancedMessage, mediaUrls) {
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

  /**
   * Send read receipt (mark messages as read)
   * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read
   */
  async sendReadReceipt(clientId, messageId) {
    try {
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      
      if (!accessToken || !phoneNumberId) {
        console.warn(`⚠️  Cannot send read receipt - missing credentials for client ${clientId}`);
        return false;
      }

      const baseUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}`;
      const requestUrl = `${baseUrl}/messages`;

      const payload = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      };

      await axios.post(requestUrl, payload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Read receipt sent for message ${messageId} (client: ${clientId})`);
      return true;
    } catch (error) {
      console.error(`❌ Error sending read receipt for client ${clientId}:`, error.message);
      return false;
    }
  }

  // Note: Typing indicators are NOT supported by Meta's WhatsApp Business API (REST API)
  // Typing indicators are only available in WhatsApp Web API (used by WPPConnect)
  // This feature has been removed from WhatsApp Official service

  /**
   * Start processing messages with delay
   */
  startProcessing(clientId, senderNumber, delay) {
    const userKey = this.getUserKey(clientId, senderNumber);

    // If already processing, clear the existing timer and reset it
    if (this.processingUsers[userKey]) {
      const existingTimer = this.processingUsers[`${userKey}_timer`];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      
      // Reset read receipt timer to mark the new last message
      const existingReadReceiptTimer = this.processingUsers[`${userKey}_readReceiptTimer`];
      if (existingReadReceiptTimer) {
        clearTimeout(existingReadReceiptTimer);
      }
      
      // Reset read receipt flag so we can mark the new last message
      // This allows us to mark the latest message when rapid messages arrive
      this.readReceiptSent[userKey] = false;
      
      // Set new read receipt timer to mark the last message in queue
      const preDelayMs = 300;
      const newReadReceiptTimer = setTimeout(async () => {
        try {
          const messages = this.messageQueue[userKey] || [];
          if (messages.length > 0) {
            // Get the last (most recent) message
            const lastMessage = messages[messages.length - 1];
            const messageId = lastMessage.message?.id;
            
            if (messageId) {
              await this.sendReadReceipt(clientId, messageId);
              this.readReceiptSent[userKey] = true;
              console.log(`✅ Read receipt sent for last message (${messages.length} message(s) in queue)`);
            }
          }
        } catch (error) {
          console.log('⚠️ Error in read receipt sequence:', error.message);
        }
      }, preDelayMs);
      
      this.processingUsers[`${userKey}_readReceiptTimer`] = newReadReceiptTimer;
      
      const newTimer = setTimeout(() => {
        this.processQueuedMessages(clientId, senderNumber);
      }, delay);
      
      this.processingUsers[`${userKey}_timer`] = newTimer;
      return;
    }

    // Mark as processing
    this.processingUsers[userKey] = Date.now();

    // Send read receipt after 300ms (same as WPPConnect timing)
    const preDelayMs = 300;
    const readReceiptTimer = setTimeout(async () => {
      try {
        // Get the LAST message ID from queue to mark as read
        // Marking the last message as read will automatically mark all previous messages as read in WhatsApp
        const messages = this.messageQueue[userKey] || [];
        if (messages.length > 0) {
          // Get the last message (most recent) instead of first
          const lastMessage = messages[messages.length - 1];
          const messageId = lastMessage.message?.id;
          
          // Send read receipt if not already sent
          if (messageId && !this.readReceiptSent[userKey]) {
            await this.sendReadReceipt(clientId, messageId);
            this.readReceiptSent[userKey] = true;
            console.log(`✅ Read receipt sent for last message (${messages.length} message(s) in queue)`);
          }
        }
      } catch (error) {
        console.log('⚠️ Error in read receipt sequence:', error.message);
      }
    }, preDelayMs);

    this.processingUsers[`${userKey}_readReceiptTimer`] = readReceiptTimer;

    // Set timer to process after delay
    const processingTimer = setTimeout(() => {
      this.processQueuedMessages(clientId, senderNumber);
    }, delay);
    
    this.processingUsers[`${userKey}_timer`] = processingTimer;
  }

  /**
   * Process queued messages
   */
  async processQueuedMessages(clientId, senderNumber) {
    const userKey = this.getUserKey(clientId, senderNumber);
    
    if (!this.processingUsers[userKey]) {
      console.log(`⚠️ Processing already completed for ${senderNumber}, skipping`);
      return;
    }

    // Prevent concurrent execution
    const processingKey = `${userKey}_processing`;
    if (this.processingUsers[processingKey]) {
      console.log(`⚠️ [${clientId}] processQueuedMessages already in progress for ${senderNumber}, skipping duplicate call`);
      return;
    }
    this.processingUsers[processingKey] = true;

    try {
      // Read and clear the queue
      const messages = this.messageQueue[userKey] || [];
      this.messageQueue[userKey] = [];

      if (messages.length === 0) {
        console.log(`⚠️ No messages in queue for ${senderNumber}`);
        this.cleanupProcessingState(clientId, senderNumber);
        return;
      }

      // Combine all messages
      const combinedMessages = messages
        .map(item => item.enhancedText)
        .join('\n');

      // Send to AI and respond
      // Note: For private agent assignment, we use senderNumber (message.from) as userIdentifier
      await this.sendMessage(clientId, senderNumber, combinedMessages);

      // Clean up
      this.cleanupProcessingState(clientId, senderNumber);

    } catch (error) {
      console.error(`❌ Error processing messages for ${senderNumber}:`, error);
      this.cleanupProcessingState(clientId, senderNumber);
    } finally {
      delete this.processingUsers[processingKey];
    }
  }

  /**
   * Clean up processing state
   */
  cleanupProcessingState(clientId, senderNumber) {
    const userKey = this.getUserKey(clientId, senderNumber);
    
    // Check if new messages arrived
    const hasNewMessages = this.messageQueue[userKey] && this.messageQueue[userKey].length > 0;
    
    if (hasNewMessages) {
      console.log(`📬 [${clientId}] New messages arrived for ${senderNumber} during processing - keeping state active`);
      return;
    }
    
    // Clean up timers
    const processingTimer = this.processingUsers[`${userKey}_timer`];
    if (processingTimer) {
      clearTimeout(processingTimer);
    }

    const readTypingTimer = this.processingUsers[`${userKey}_readTypingTimer`];
    if (readTypingTimer) {
      clearTimeout(readTypingTimer);
    }

    // Clean up state
    delete this.messageQueue[userKey];
    delete this.processingUsers[userKey];
    delete this.processingUsers[`${userKey}_timer`];
    delete this.processingUsers[`${userKey}_readReceiptTimer`];
    delete this.readReceiptSent[userKey];
    
    console.log(`🧹 [${clientId}] Cleaned up processing state for ${senderNumber}`);
  }

  /**
   * Send message to AI workflow and send response
   * @param clientId - The client ID
   * @param number - The sender phone number (message.from) - this is used as userIdentifier for private agent assignment
   * @param message - The message content
   */
  async sendMessage(clientId, number, message) {
    try {
      console.log(`📤 [${clientId}] Sending to ${number}: ${message.substring(0, 100)}...`);

      // Get agent code for this specific user (checks privateAgentAssignment first)
      // For WA-Official, userIdentifier is the sender phone number (message.from)
      const userIdentifier = number; // Use sender's phone number as userIdentifier
      const agentCode = await this.getAgentForUser(clientId, userIdentifier);
      if (!agentCode) {
        console.error(`❌ No agent assigned to client ${clientId} for user ${userIdentifier}`);
        return;
      }

      console.log(`🤖 Using agent code: ${agentCode} for client ${clientId}, user ${userIdentifier}`);

      // Call AI workflow
      const workflowResponse = await this.callInferenceFw(message, number, clientId, agentCode);

      // Check for error responses first
      if (workflowResponse?.result?.success === false || workflowResponse?.result?.error) {
        const errorMessage = workflowResponse.result.error || 'Unknown error occurred';
        console.error(`❌ [${clientId}] Workflow error: ${errorMessage}`);
        
        // Send error message to user
        const userFriendlyMessage = `Sorry, I encountered an error: ${errorMessage}. Please try again later.`;
        await this.messageController.sendTextMessage(clientId, number, userFriendlyMessage);
        return;
      }

      // Validate response structure (similar to WPPConnect)
      if (!workflowResponse || !workflowResponse.result || !workflowResponse.result.content) {
        console.error(`❌ [${clientId}] Invalid workflow response structure`);
        console.error(`❌ [${clientId}] Response keys:`, workflowResponse ? Object.keys(workflowResponse) : 'null');
        console.error(`❌ [${clientId}] Full response:`, JSON.stringify(workflowResponse, null, 2).substring(0, 1000));
        
        // Send error message to user
        await this.messageController.sendTextMessage(clientId, number, 'Sorry, I received an invalid response from the AI service. Please try again.');
        return;
      }

      // Use formatted.whatsapp as primary source, fallback to content.object if not available (same as WPPConnect)
      let messageObjects = [];
      
      if (workflowResponse?.result?.formatted?.whatsapp && Array.isArray(workflowResponse.result.formatted.whatsapp) && workflowResponse.result.formatted.whatsapp.length > 0) {
        // Primary: Use formatted.whatsapp
        messageObjects = workflowResponse.result.formatted.whatsapp;
        console.log(`📥 [${clientId}] Using formatted.whatsapp: ${messageObjects.length} message(s)`);
      } else if (workflowResponse?.result?.content?.object && Array.isArray(workflowResponse.result.content.object) && workflowResponse.result.content.object.length > 0) {
        // Fallback: Use content.object if formatted.whatsapp is not available
        messageObjects = workflowResponse.result.content.object;
        console.log(`📥 [${clientId}] Using content.object: ${messageObjects.length} message(s)`);
      }

      // Send response using message controller
      if (messageObjects.length > 0) {
        await this.sendWorkflowMessages(clientId, number, messageObjects);
      } else if (workflowResponse?.result?.content?.text) {
        const text = workflowResponse.result.content.text;
        console.log(`🤖 [${clientId}] Received workflow response with text only`);
        
        await this.messageController.sendTextMessage(clientId, number, text);
      } else {
        console.error(`❌ [${clientId}] Invalid workflow response format - no message objects or text found`);
        console.error(`❌ [${clientId}] Response structure:`, JSON.stringify(workflowResponse, null, 2).substring(0, 1000));
        
        // Send error message to user
        await this.messageController.sendTextMessage(clientId, number, 'Sorry, I received an invalid response format from the AI service. Please try again.');
      }

    } catch (error) {
      console.error(`❌ Error in sendMessage for ${number}:`, error.message);
    }
  }

  /**
   * Get agent code from PlatformClientAgent (main agent code)
   */
  async getClientAgent(clientId) {
    try {
      await this.clientManager.initialize();
      const ClientAgent = this.clientManager.getClientAgentModel();
      
      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      }).lean(); // Use lean() to get raw MongoDB data including privateAgentAssignment

      return client?.ai_agent_code || null;
    } catch (error) {
      console.error(`❌ Error getting agent code for client ${clientId}:`, error.message);
      return null;
    }
  }

  /**
   * Get agent code for a specific user, checking privateAgentAssignment first
   * @param clientId - The client ID
   * @param userIdentifier - The user identifier (display_phone_number for WA-Official)
   * @returns The agent code for this user, or null if not found
   */
  async getAgentForUser(clientId, userIdentifier) {
    try {
      await this.clientManager.initialize();
      const ClientAgent = this.clientManager.getClientAgentModel();
      
      // Query with lean() to get raw MongoDB data including privateAgentAssignment
      const client = await ClientAgent.findOne({
        clientId,
        platform: 'wa-official',
        isActive: true
      }).lean();

      if (client) {
        // Check privateAgentAssignment first
        const privateAssignments = client.privateAgentAssignment || [];
        if (privateAssignments.length > 0) {
          const privateAssignment = privateAssignments.find(
            assignment => assignment.userIdentifier === userIdentifier
          );
          
          if (privateAssignment && privateAssignment.agentCode) {
            console.log(`✅ Found private agent assignment for user ${userIdentifier} (client: ${clientId}): ${privateAssignment.agentCode}`);
            return privateAssignment.agentCode;
          }
        }

        // Fallback to main agent code
        if (client.ai_agent_code) {
          return client.ai_agent_code;
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ Error getting agent for user ${userIdentifier} (client ${clientId}):`, error.message);
      return null;
    }
  }

  /**
   * Call AI workflow endpoint
   */
  async callInferenceFw(message, phoneNumber, clientId, agentCode) {
    try {
      const url = this.env.FW_ENDPOINT_WORKFLOW;
      if (!url) {
        throw new Error('FW_ENDPOINT_WORKFLOW environment variable is required');
      }

      const jwtSecret = this.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error('JWT_SECRET environment variable is not set');
      }

      // Get contact info
      const userKey = this.getUserKey(clientId, phoneNumber);
      const userContact = this.contactInfo[userKey] || {
        name: phoneNumber,
        phone: phoneNumber
      };

      // Generate JWT token
      const payload = {
        iss: 'whatsapp-bot',
        sub: `wa_${phoneNumber}`,
        aud: 'authenticated',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        identifier: phoneNumber,
        role: 'authenticated',
        agent_metadata: {
          agent_code: agentCode,
          status: 'active'
        },
        client_metadata: {
          client_id: clientId,
          client_name: 'WhatsApp Official Bot',
          app_metadata: {
            provider: 'wa-official'
          }
        },
        user_metadata: {
          phone: phoneNumber,
          phone_verified: true,
          full_name: userContact.name || phoneNumber,
          participant_name: userContact.name || phoneNumber,
          participant_phone: phoneNumber,
          message_timestamp: Math.floor(Date.now() / 1000),
          client_id: clientId
        }
      };

      const authToken = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

      // Workflow format request body
      // Note: agent_code is hardcoded as "generalAssistanceAgent" (same as WPPConnect)
      // The actual agent code is passed in JWT agent_metadata for the workflow to use
      const requestBody = {
        inputData: {
          agent_code: "generalAssistanceAgent", // HARDCODED (same as WPPConnect)
          format: "whatsapp", // HARDCODED
          messages: [
            {
              role: "user", // HARDCODED
              content: message // the [message]
            }
          ],
          client_platform: "whatsapp",
          memory: {
            resourceId: `${agentCode}:${phoneNumber}`, // Use actual agentCode for memory
            threadId: `${agentCode}:${phoneNumber}:whatsapp` // Use actual agentCode for memory
          }
        }
      };

      const timeoutMs = parseInt(this.env.AI_REQUEST_TIMEOUT || '300000', 10);
      
      console.log(`📤 [${clientId}] Request to workflow: agent=${agentCode}, user=${phoneNumber}`);

      const response = await axios.post(url, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        timeout: timeoutMs
      });

      console.log(`✅ [${clientId}] Workflow endpoint responded`);

      return response.data;
    } catch (error) {
      console.error(`❌ [${clientId}] Error calling AI API:`, error.message);
      throw error;
    }
  }

  /**
   * Send workflow messages (similar to WPPConnect)
   */
  async sendWorkflowMessages(clientId, number, messageObjects) {
    try {
      for (let i = 0; i < messageObjects.length; i++) {
        const msgObj = messageObjects[i];
        if (!msgObj || !msgObj.type) continue;

        try {
          switch (msgObj.type) {
            case 'text':
              if (msgObj.text) {
                await this.messageController.sendTextMessage(clientId, number, msgObj.text);
                console.log(`✅ Sent text: ${msgObj.text.substring(0, 50)}...`);
              }
              break;

            case 'image':
              if (msgObj.url) {
                await this.messageController.sendMediaMessage(clientId, number, 'image', msgObj.url, msgObj.caption || '');
                console.log(`✅ Sent image: ${msgObj.url}`);
              }
              break;

            case 'video':
              if (msgObj.url) {
                await this.messageController.sendMediaMessage(clientId, number, 'video', msgObj.url, msgObj.caption || '');
                console.log(`✅ Sent video: ${msgObj.url}`);
              }
              break;

            case 'audio':
              if (msgObj.url) {
                await this.messageController.sendMediaMessage(clientId, number, 'audio', msgObj.url);
                console.log(`✅ Sent audio: ${msgObj.url}`);
              }
              break;

            case 'file':
            case 'document':
              if (msgObj.url) {
                await this.messageController.sendMediaMessage(clientId, number, 'document', msgObj.url, msgObj.caption || '');
                console.log(`✅ Sent document: ${msgObj.url}`);
              }
              break;

            case 'sticker':
            case 'animated-sticker':
              if (msgObj.url) {
                // Meta's WhatsApp Business API supports sending stickers
                // Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages
                await this.messageController.sendMediaMessage(clientId, number, 'sticker', msgObj.url);
                console.log(`✅ Sent sticker: ${msgObj.url}`);
              }
              break;

            case 'location':
              if (msgObj.latitude !== undefined && msgObj.longitude !== undefined) {
                await this.messageController.sendLocationMessage(
                  clientId, 
                  number, 
                  msgObj.latitude, 
                  msgObj.longitude,
                  msgObj.caption || '', // Use caption as location name
                  '' // address can be empty
                );
                console.log(`✅ Sent location: ${msgObj.latitude}, ${msgObj.longitude}`);
              }
              break;

            case 'reply':
              // Reply to a message - use context.message_id
              if (msgObj.messageid && msgObj.text) {
                await this.messageController.sendTextMessage(clientId, number, msgObj.text, msgObj.messageid);
                console.log(`✅ Sent reply to message ${msgObj.messageid}: ${msgObj.text.substring(0, 50)}...`);
              } else if (msgObj.messageid && msgObj.url) {
                // Reply with media
                const mediaType = msgObj.type === 'image' ? 'image' : 
                                 msgObj.type === 'video' ? 'video' : 
                                 msgObj.type === 'audio' ? 'audio' : 'document';
                await this.messageController.sendMediaMessage(
                  clientId, 
                  number, 
                  mediaType, 
                  msgObj.url, 
                  msgObj.caption || '', 
                  msgObj.messageid
                );
                console.log(`✅ Sent media reply to message ${msgObj.messageid}`);
              }
              break;

            case 'reaction':
              // Meta's WhatsApp Business API supports sending reaction messages
              // Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages
              if (msgObj.messageid) {
                const emoji = msgObj.emoji || '👍';
                await this.messageController.sendReactionMessage(clientId, number, msgObj.messageid, emoji);
                console.log(`✅ Sent reaction ${emoji} to message ${msgObj.messageid}`);
              } else {
                console.warn(`⚠️  Reaction message missing messageid, skipping`);
              }
              break;

            case 'stop-response':
              // Control signal to stop sending remaining messages
              console.log(`🛑 Stop response signal received. Skipping remaining ${messageObjects.length - i - 1} message(s)`);
              return; // Exit the loop, stop sending remaining messages

            default:
              console.warn(`⚠️  Unknown message type: ${msgObj.type}`);
          }
        } catch (error) {
          console.error(`⚠️  Error sending ${msgObj.type}:`, error.message);
        }

        // Delay between messages (except for reactions and stop-response)
        if (i < messageObjects.length - 1 && msgObj.type !== 'reaction' && msgObj.type !== 'stop-response') {
          const delayMs = 1000 + Math.floor(Math.random() * 2000);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    } catch (error) {
      console.error('❌ Error in sendWorkflowMessages:', error);
      throw error;
    }
  }
}

module.exports = WhatsAppOfficialMessageHandler;

