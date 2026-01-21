const axios = require('axios');
const jwt = require('jsonwebtoken');
const clientManager = require('./client-manager');
const WhatsAppMessageController = require('../controllers/message.controller');

// Stream producer for pub/sub (optional - only if VALKEY_HOST is set)
// Lazy initialization - only initialize when first needed (after dotenv.config() has run)
let streamProducer = null;
let producerInitialized = false;

function initializeStreamProducer() {
  if (producerInitialized) {
    return streamProducer;
  }
  
  producerInitialized = true;
  console.log('[WA Official Handler] Initializing stream producer (lazy)...');
  console.log(`[WA Official Handler] VALKEY_HOST: ${process.env.VALKEY_HOST ? 'SET' : 'NOT SET'}`);
  console.log(`[WA Official Handler] REDIS_HOST: ${process.env.REDIS_HOST ? 'SET' : 'NOT SET'}`);
  
  try {
    if (process.env.VALKEY_HOST || process.env.REDIS_HOST) {
      console.log('🔄 Initializing stream producer...');
      // Use absolute path from project root (works from both local and Docker)
      const path = require('path');
      const producerPath = path.join(process.cwd(), 'services', 'pubsub', 'client', 'producer');
      console.log(`[WA Official Handler] Producer path: ${producerPath}`);
      const { getProducer } = require(producerPath);
      console.log('[WA Official Handler] Producer module loaded successfully');
      streamProducer = getProducer();
      console.log('[WA Official Handler] Producer instance created, attempting connection...');
      streamProducer.connect().then(() => {
        console.log('✅ Stream producer connected successfully');
      }).catch((err) => {
        console.warn('⚠️  Could not connect to stream producer (pub/sub disabled):', err.message);
        streamProducer = null;
      });
    } else {
      console.log('ℹ️  Stream producer disabled (VALKEY_HOST/REDIS_HOST not set)');
    }
  } catch (error) {
    console.error('❌ Stream producer initialization failed:', error.message);
    console.error('❌ Error stack:', error.stack);
    streamProducer = null;
  }
  
  return streamProducer;
}

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
   * Ensure function_call items have unique IDs (dedup/rewrites duplicates)
   * This prevents downstream "Duplicate item id" errors if the workflow returns
   * multiple function_call entries with the same id.
   */
  ensureUniqueFunctionCallIds(items = []) {
    const seen = new Set();
    return items.map(item => {
      if (item && item.type === 'function_call') {
        let id = item.id || `fc_${crypto.randomUUID()}`;
        if (seen.has(id)) {
          const newId = `fc_${crypto.randomUUID()}`;
          console.warn(`🔁 Duplicate function_call id detected (${id}), rewriting to ${newId}`);
          id = newId;
        }
        seen.add(id);
        return { ...item, id };
      }
      return item;
    });
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
        item => item.userIdentifier === userIdentifier && (item.option === 'block' || item.option === 'pause' || item.option === 'taken')
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

      // User is blocked/paused/taken and not expired
      const option = needAttentionItem.option === 'block' ? 'blocked' : 
                     needAttentionItem.option === 'pause' ? 'paused' : 
                     'taken by human agent';
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
      
      // Extract phoneNumberId from metadata (passed from webhook controller)
      const phoneNumberId = metadata?.phone_number_id || null;

      // Extract and store contact information (before checking needAttention)
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

      // Determine if this is a media message
      const mediaTypes = ['image', 'video', 'audio', 'document', 'file', 'sticker'];
      const isMediaMessage = mediaTypes.includes(message.type);

      // For media messages: content should only contain the actual caption (not metadata/URLs)
      // Metadata and media URLs are already in metadata.message.mediaUrls
      // For text messages: include metadata prefix for AI workflow context
      let contentForStream;
      if (isMediaMessage) {
        // Media messages: content is just the caption (clean, no metadata/URLs)
        // Media URLs are already in metadata.message.mediaUrls array
        contentForStream = enhancedMessage || ''; // Just the caption, if any
      } else {
        // Text messages: include metadata prefix for context
        // Add media URLs if any (for non-media messages that might have attachments)
        if (mediaUrls.length > 0) {
          if (enhancedMessage) {
            enhancedMessage += `\nMedia attached:\n- @[${mediaUrls.join(']\n- @[')}]`;
          } else {
            enhancedMessage = `Media attached:\n- @[${mediaUrls.join(']\n- @[')}]`;
          }
        }
        contentForStream = enhancedMessage ? `${metadataPrefix} ${enhancedMessage}` : `${metadataPrefix}`;
      }

      // Publish incoming message event to stream (if producer is available)
      // Lazy initialize producer (ensures dotenv.config() has run)
      if (!producerInitialized) {
        initializeStreamProducer();
      }
      
      // Ensure producer is initialized (wait for connection if needed)
      if (streamProducer && !streamProducer.isConnected) {
        try {
          await streamProducer.connect();
        } catch (error) {
          console.error('❌ [WA Official Handler] Failed to connect stream producer:', error.message);
        }
      }
      
      console.log(`🔍 [WA Official Handler] Checking streamProducer for incoming message from ${senderPhoneNumber}:`, streamProducer ? 'EXISTS' : 'NULL');
      if (streamProducer) {
        try {
          // Get agent code for this user (so scoped webhooks can receive this event)
          const agentCode = await this.getAgentForUser(clientId, senderPhoneNumber);
          
          console.log(`📤 [WA Official Handler] Publishing incoming message to stream for ${senderPhoneNumber} (clientId: ${clientId}, agentCode: ${agentCode || 'none'})`);
          await streamProducer.publishIncomingMessage({
            clientId,
            platform: 'wa-official',
            userIdentifier: senderPhoneNumber,
            agentCode: agentCode || null, // Include agentCode so scoped webhooks can receive this event
            messageId: message.id || message.timestamp || Date.now().toString(),
            messageType: message.type || 'text',
            content: contentForStream || '',
            metadata: {
              sender: {
                name: message.contacts?.[0]?.profile?.name,
                phone: senderPhoneNumber
              },
              message: {
                from: senderPhoneNumber,
                timestamp: message.timestamp,
                phoneNumberId: phoneNumberId || null,
                hasMedia: mediaUrls.length > 0,
                mediaUrls: mediaUrls || []
              }
            }
          });
          console.log(`✅ [WA Official Handler] Successfully published incoming message to stream`);
        } catch (error) {
          console.error('❌ [WA Official Handler] Failed to publish incoming message to stream:', error.message || error);
          console.error('❌ [WA Official Handler] Error stack:', error.stack);
        }
      } else {
        console.log('ℹ️  [WA Official Handler] Stream producer not available (null), skipping publish');
        console.log('ℹ️  [WA Official Handler] VALKEY_HOST check:', process.env.VALKEY_HOST ? 'SET' : 'NOT SET');
        console.log('ℹ️  [WA Official Handler] REDIS_HOST check:', process.env.REDIS_HOST ? 'SET' : 'NOT SET');
      }

      // Check needAttention status AFTER publishing to stream (for audit/logging)
      // For WA-Official, userIdentifier is message.from (sender's phone number)
      // If blocked/paused/taken, skip AI workflow but keep the stream event
      const isBlockedOrPaused = await this.checkNeedAttention(clientId, senderPhoneNumber);
      if (isBlockedOrPaused) {
        console.log(`🚫 [${clientId}] User ${senderPhoneNumber} is blocked/paused/taken - skipping AI workflow but event was published to stream`);
        return; // Skip AI workflow (no read, typing, reply, etc.) but stream event is already published
      }

      // Add to message queue (only if not blocked/paused/taken)
      // Note: For private agent assignment, we use senderPhoneNumber (message.from) as userIdentifier
      // For AI workflow: use enhancedMessage with metadata prefix for context (like WPPConnect)
      // This helps AI understand message context while keeping stored caption clean
      const messageForAI = isMediaMessage 
        ? (enhancedMessage || '') // Media: just caption for AI (metadata/URLs already in metadata)
        : contentForStream; // Text: with metadata prefix
      this.addToQueue(clientId, senderPhoneNumber, message, messageForAI, mediaUrls);

      // If user is already being processed, we'll mark the last message as read
      // (which will mark all previous messages as read in WhatsApp)
      // This is handled in the readReceiptTimer below

      // Start processing with delay (only if not blocked/paused/taken)
      // Similar to WPPConnect's 7 seconds
      const delay = 7000; // 7 seconds
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
        `https://graph.facebook.com/v24.0/${mediaId}`,
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
  /**
   * Send read receipt (optionally with typing indicator)
   * Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/mark-message-as-read
   * 
   * @param {string} clientId - Client ID
   * @param {string} messageId - WhatsApp message ID
   * @param {boolean} withTypingIndicator - If true, also send typing indicator in the same call
   * @returns {Promise<boolean>} - Returns true if successful, false otherwise
   */
  async sendReadReceipt(clientId, messageId, withTypingIndicator = false) {
    try {
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      
      if (!accessToken || !phoneNumberId) {
        console.warn(`⚠️  Cannot send read receipt - missing credentials for client ${clientId}`);
        return false;
      }

      const apiVersion = process.env.WA_API_VERSION || 'v24.0';
      const baseUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
      const requestUrl = `${baseUrl}/messages`;

      const payload = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      };

      // Add typing indicator if requested (combines read receipt + typing in one call)
      if (withTypingIndicator) {
        payload.typing_indicator = {
          type: 'text'
        };
      }

      await axios.post(requestUrl, payload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (withTypingIndicator) {
        console.log(`✅ Read receipt + typing indicator sent for message ${messageId} (client: ${clientId})`);
      } else {
        console.log(`✅ Read receipt sent for message ${messageId} (client: ${clientId})`);
      }
      return true;
    } catch (error) {
      console.error(`❌ Error sending read receipt for client ${clientId}:`, error.message);
      return false;
    }
  }

  /**
   * Send typing indicator (should be combined with read receipt using message_id)
   * Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators/
   * 
   * Note: Typing indicators should be sent together with read receipts using message_id.
   * Use sendReadReceipt(clientId, messageId, true) instead of calling this separately.
   * 
   * @param {string} clientId - Client ID
   * @param {string} messageId - WhatsApp message ID (required for typing indicator)
   * @param {boolean} start - true to start typing, false to stop typing
   * @returns {Promise<boolean>} - Returns true if successful, false otherwise
   */
  async sendTypingIndicator(clientId, messageId, start = true) {
    // If stop is requested, we can skip the API call
    // Typing indicator automatically stops after a timeout on WhatsApp
    if (!start) {
      console.log(`⌨️  Typing indicator stop (no API call needed)`);
      return true; // Return true as stopping doesn't require an API call
    }

    // Typing indicator should be sent together with read receipt
    // Call sendReadReceipt with withTypingIndicator=true
    return await this.sendReadReceipt(clientId, messageId, true);
  }

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
      
      // Reset read receipt/typing timer to mark the new last message
      const existingReadReceiptTimer = this.processingUsers[`${userKey}_readReceiptTimer`];
      if (existingReadReceiptTimer) {
        clearTimeout(existingReadReceiptTimer);
      }
      
      // Reset read receipt flag so we can mark the new last message
      // This allows us to mark the latest message when rapid messages arrive
      this.readReceiptSent[userKey] = false;
      
      // Set new read receipt + typing indicator timer to mark the last message in queue
      const preDelayMs = 300;
      const newReadReceiptTimer = setTimeout(async () => {
        try {
          const messages = this.messageQueue[userKey] || [];
          if (messages.length > 0) {
            // Get the last (most recent) message
            const lastMessage = messages[messages.length - 1];
            const messageId = lastMessage.message?.id;
            
            if (messageId) {
              // Send read receipt + typing indicator together (combined in one API call)
              await this.sendReadReceipt(clientId, messageId, true);
              this.readReceiptSent[userKey] = true;
              console.log(`✅ Read receipt + typing indicator sent for last message (${messages.length} message(s) in queue)`);
            }
          }
        } catch (error) {
          console.log('⚠️ Error in read receipt/typing sequence:', error.message);
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

    // Send read receipt + typing indicator after 300ms (same as WPPConnect timing)
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
            // Send read receipt + typing indicator together (combined in one API call)
            await this.sendReadReceipt(clientId, messageId, true);
            this.readReceiptSent[userKey] = true;
            console.log(`✅ Read receipt + typing indicator sent for last message (${messages.length} message(s) in queue)`);
          }
        }
      } catch (error) {
        console.log('⚠️ Error in read receipt/typing sequence:', error.message);
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
        await this.cleanupProcessingState(clientId, senderNumber);
        return;
      }

      // Combine all messages
      const combinedMessages = messages
        .map(item => item.enhancedText)
        .join('\n');

      // Send to AI and respond
      // Note: For private agent assignment, we use senderNumber (message.from) as userIdentifier
      await this.sendMessage(clientId, senderNumber, combinedMessages);

      // Stop typing indicator after sending response (no API call needed - stops automatically)
      console.log(`⌨️  Typing indicator stopped for ${senderNumber} (automatic after response)`);

      // Clean up
      await this.cleanupProcessingState(clientId, senderNumber);

    } catch (error) {
      console.error(`❌ Error processing messages for ${senderNumber}:`, error);
      await this.cleanupProcessingState(clientId, senderNumber);
    } finally {
      delete this.processingUsers[processingKey];
    }
  }

  /**
   * Clean up processing state
   */
  async cleanupProcessingState(clientId, senderNumber) {
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

    // Stop typing indicator if still active (no API call needed - stops automatically)
    // Typing indicators automatically stop after 25 seconds or when a message is sent

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
        messageObjects = this.ensureUniqueFunctionCallIds(workflowResponse.result.formatted.whatsapp);
        console.log(`📥 [${clientId}] Using formatted.whatsapp: ${messageObjects.length} message(s)`);
      } else if (workflowResponse?.result?.content?.object && Array.isArray(workflowResponse.result.content.object) && workflowResponse.result.content.object.length > 0) {
        // Fallback: Use content.object if formatted.whatsapp is not available
        messageObjects = this.ensureUniqueFunctionCallIds(workflowResponse.result.content.object);
        console.log(`📥 [${clientId}] Using content.object: ${messageObjects.length} message(s)`);
      }

      // Publish AI response to stream (if producer is available)
      // Lazy initialize producer (ensures dotenv.config() has run)
      if (!producerInitialized) {
        initializeStreamProducer();
      }
      
      // Ensure producer is initialized (wait for connection if needed)
      if (streamProducer && !streamProducer.isConnected) {
        try {
          await streamProducer.connect();
        } catch (error) {
          console.error('❌ [WA Official Handler] Failed to connect stream producer:', error.message);
        }
      }
      
      console.log(`🔍 [WA Official Handler] Checking streamProducer for AI response from ${number}:`, streamProducer ? 'EXISTS' : 'NULL');
      if (streamProducer) {
        try {
          console.log(`📤 [WA Official Handler] Publishing AI response to stream for ${number} (clientId: ${clientId}, agentCode: ${agentCode || 'none'})`);
          await streamProducer.publishAIResponse({
            clientId,
            platform: 'wa-official',
            userIdentifier: number, // userIdentifier is the sender's phone number (message.from)
            agentCode: agentCode || null, // Use null instead of 'unknown' to match WPPConnect behavior
            requestMessage: message,
            response: {
              messages: messageObjects.length > 0 ? messageObjects : null,
              text: workflowResponse?.result?.content?.text || null,
              raw: workflowResponse
            },
            metadata: {
              processingTime: Date.now() - (workflowResponse?.metadata?.startTime || Date.now())
            }
          });
          console.log(`✅ [WA Official Handler] Successfully published AI response to stream`);
        } catch (error) {
          console.error('❌ [WA Official Handler] Failed to publish AI response to stream:', error.message || error);
          console.error('❌ [WA Official Handler] Error stack:', error.stack);
        }
      } else {
        console.log('ℹ️  [WA Official Handler] Stream producer not available (null), skipping publish');
        console.log('ℹ️  [WA Official Handler] VALKEY_HOST check:', process.env.VALKEY_HOST ? 'SET' : 'NOT SET');
        console.log('ℹ️  [WA Official Handler] REDIS_HOST check:', process.env.REDIS_HOST ? 'SET' : 'NOT SET');
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
   * Upsert needAttention for a user (called when AI workflow returns block/pause type)
   * @param clientId - The client ID
   * @param userIdentifier - The user identifier (phone number)
   * @param option - The option ('block' or 'pause')
   * @param reason - Optional reason
   * @param from - Optional start date
   * @param to - Optional end date
   */
  async upsertNeedAttention(clientId, userIdentifier, option, reason, from, to) {
    try {
      await this.clientManager.initialize();
      const ClientAgent = this.clientManager.getClientAgentModel();
      
      // Query with lean() to get raw MongoDB data including needAttention
      const existingDoc = await ClientAgent.findOne({ clientId, platform: 'wa-official', isActive: true }).lean();
      
      if (!existingDoc) {
        console.error(`❌ Client ${clientId} not found in PlatformClientAgent collection`);
        return;
      }

      const existingNeedAttention = existingDoc.needAttention || [];
      
      // Upsert: update if exists, add if not
      const existingIndex = existingNeedAttention.findIndex(
        item => item.userIdentifier === userIdentifier
      );

      const needAttentionItem = {
        userIdentifier,
        option: option,
        updatedAt: new Date()
      };

      // Add optional fields if provided
      if (from) {
        needAttentionItem.from = new Date(from);
      }
      if (to) {
        needAttentionItem.to = new Date(to);
      }
      if (reason) {
        needAttentionItem.reason = reason;
      }

      if (existingIndex >= 0) {
        // Update existing entry
        existingNeedAttention[existingIndex] = needAttentionItem;
      } else {
        // Add new entry
        existingNeedAttention.push(needAttentionItem);
      }

      // Update the document
      await ClientAgent.findOneAndUpdate(
        { clientId, platform: 'wa-official', isActive: true },
        { 
          $set: { 
            needAttention: existingNeedAttention,
            updatedAt: new Date()
          }
        },
        { new: true, runValidators: false, strict: false }
      );

      console.log(`✅ Upserted needAttention for userIdentifier ${userIdentifier} with option ${option} (AI workflow response)`);
    } catch (error) {
      console.error(`❌ Error upserting needAttention for ${userIdentifier}:`, error.message);
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

            case 'block':
            case 'pause':
              // AI workflow wants to block/pause the user
              const blockReason = msgObj.reason || `${msgObj.type}ed by AI workflow`;
              await this.upsertNeedAttention(
                clientId,
                number, // userIdentifier is the sender's phone number (message.from)
                msgObj.type, // 'block' or 'pause'
                blockReason,
                msgObj.from || undefined,
                msgObj.to || undefined
              );
              console.log(`🚫 [${clientId}] AI workflow requested ${msgObj.type} for user ${number}: ${blockReason}`);
              // Continue processing remaining messages (don't return early)
              break;

            default:
              console.warn(`⚠️  Unknown message type: ${msgObj.type}`);
          }
        } catch (error) {
          console.error(`⚠️  Error sending ${msgObj.type}:`, error.message);
        }

        // Delay between messages (except for reactions, stop-response, block, and pause)
        if (i < messageObjects.length - 1 && msgObj.type !== 'reaction' && msgObj.type !== 'stop-response' && msgObj.type !== 'block' && msgObj.type !== 'pause') {
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

