const crypto = require('crypto');
const clientManager = require('../services/client-manager');
const WhatsAppMessageController = require('./message.controller');

/**
 * WhatsApp Business API Webhook Controller
 * Handles webhook verification and incoming message callbacks
 * Supports multi-client with clientId in route
 */
class WhatsAppWebhookController {
  constructor() {
    this.clientManager = clientManager;
    this.messageController = new WhatsAppMessageController();
  }

  /**
   * Verify webhook endpoint (GET)
   * Meta calls this to verify your webhook URL during setup
   * Route: /webhook/v1/:clientId
   */
  async verify(req, res) {
    try {
      const { clientId } = req.params;
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required'
        });
      }

      // Check if client exists
      const clientExists = await this.clientManager.clientExists(clientId);
      if (!clientExists) {
        console.error(`❌ Client ${clientId} not found`);
        return res.status(404).json({
          success: false,
          error: `Client ${clientId} not found or not active`
        });
      }

      // Get verify token from decrypted configuration
      const verifyToken = await this.clientManager.getVerifyToken(clientId);

      console.log(`🔍 Webhook verification attempt for ${clientId} - mode: ${mode}, token match: ${token === verifyToken}`);

      // Per Meta's documentation: If the values match, respond with HTTP status 200 and hub.challenge value
      // If invalid, respond with a 400-level HTTP status code
      if (mode === 'subscribe' && token === verifyToken) {
        console.log(`✅ Webhook verified for client ${clientId}`);
        // Return 200 with challenge value as plain text (not JSON)
        res.status(200).send(challenge);
      } else {
        console.error(`❌ Webhook verification failed for client ${clientId} - mode: ${mode}, token match: ${token === verifyToken}`);
        // Return 403 (Forbidden) for invalid verification
        res.sendStatus(403);
      }
    } catch (error) {
      console.error('❌ Webhook verification error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }

  /**
   * Handle incoming webhook events (POST)
   * Meta sends message updates, delivery status, read receipts, etc.
   * Route: /webhook/v1/:clientId
   */
  async handleWebhook(req, res) {
    try {
      const { clientId } = req.params;
      const body = req.body; // Parsed JSON body (for processing)
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(body)); // Raw body for signature verification

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required'
        });
      }

      // Check if client exists
      const clientExists = await this.clientManager.clientExists(clientId);
      if (!clientExists) {
        console.error(`❌ Client ${clientId} not found`);
        return res.status(404).json({
          success: false,
          error: `Client ${clientId} not found or not active`
        });
      }

      // Verify webhook signature using client-specific app_secret
      // Meta requires HMAC-SHA256 signature validation per their documentation
      const signature = req.headers['x-hub-signature-256'];
      
      // Log all relevant headers for debugging
      const relevantHeaders = {
        'x-hub-signature-256': req.headers['x-hub-signature-256'],
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'host': req.headers['host']
      };
      
      if (signature) {
        try {
          const appSecret = await this.clientManager.getAppSecret(clientId);
          if (!appSecret) {
            console.warn(`⚠️ App secret not configured for client ${clientId}, skipping signature verification`);
          } else {
            // Log request details before verification
            const rawBodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
            const bodyPreview = rawBodyString.length > 200 ? rawBodyString.substring(0, 200) + '...' : rawBodyString;
            
            console.log(`🔍 [${clientId}] Verifying webhook signature:`);
            console.log(`   Received Signature: ${signature}`);
            console.log(`   App Secret: ${appSecret ? `${appSecret.substring(0, 8)}...` : 'MISSING'}`);
            console.log(`   Request Headers:`, JSON.stringify(relevantHeaders, null, 2));
            console.log(`   Raw Body Length: ${rawBodyString.length} bytes`);
            console.log(`   Raw Body Preview: ${bodyPreview}`);
            console.log(`   Body Structure:`, {
              object: body?.object,
              entryCount: body?.entry?.length || 0,
              hasMessages: !!body?.entry?.[0]?.changes?.[0]?.value?.messages,
              hasStatuses: !!body?.entry?.[0]?.changes?.[0]?.value?.statuses
            });
            
            const isValid = this.verifySignature(rawBody, body, signature, appSecret);
            if (!isValid) {
              // Log detailed signature verification failure info
              const expectedSignature = 'sha256=' + crypto
                .createHmac('sha256', appSecret)
                .update(rawBodyString)
                .digest('hex');
              
              // Also calculate what it would be with stringified (for comparison)
              const stringifiedSignature = 'sha256=' + crypto
                .createHmac('sha256', appSecret)
                .update(JSON.stringify(body))
                .digest('hex');
              
              console.error(`❌ [${clientId}] Invalid webhook signature:`);
              console.error(`   Received: ${signature}`);
              console.error(`   Expected (raw body): ${expectedSignature}`);
              console.error(`   Expected (stringified): ${stringifiedSignature}`);
              console.error(`   Using raw body: ${signature === expectedSignature}`);
              console.error(`   Using stringified: ${signature === stringifiedSignature}`);
              console.error(`   Raw Body (first 500 chars): ${rawBodyString.substring(0, 500)}`);
              console.error(`   Parsed Body:`, JSON.stringify(body, null, 2));
              return res.sendStatus(403);
            } else {
              console.log(`✅ Webhook signature verified for client ${clientId}`);
            }
          }
        } catch (error) {
          console.error(`❌ Error verifying webhook signature for client ${clientId}:`, error.message);
          console.error(`   Error Stack:`, error.stack);
          console.error(`   Request Headers:`, JSON.stringify(relevantHeaders, null, 2));
          console.error(`   Body:`, JSON.stringify(body, null, 2));
          return res.sendStatus(403);
        }
      } else {
        console.warn(`⚠️ No X-Hub-Signature-256 header found for client ${clientId}, skipping signature verification`);
        console.warn(`   Available headers:`, JSON.stringify(relevantHeaders, null, 2));
      }

      console.log(`📨 Received webhook for client ${clientId}:`, JSON.stringify(body, null, 2));

      // Meta sends a 200 response immediately, then processes the webhook
      res.sendStatus(200);

      // Process webhook events
      if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach((entry) => {
          entry.changes?.forEach((change) => {
            // Meta can send status updates in 'messages' field with 'statuses' array
            // or in 'message_status' field. Check for statuses first.
            if (change.field === 'messages') {
              // Check if this is actually a status update (has statuses array) or incoming message (has messages array)
              if (change.value?.statuses && Array.isArray(change.value.statuses)) {
                // Status update sent via messages field
                console.log(`📊 Status update received in 'messages' field for client ${clientId}`);
                this.handleStatusChange(clientId, change.value);
              } else if (change.value?.messages && Array.isArray(change.value.messages)) {
                // Actual incoming message
                this.handleMessageChange(clientId, change.value);
              } else {
                console.log(`⚠️ Unknown webhook payload structure in 'messages' field for client ${clientId}`);
              }
            } else if (change.field === 'message_status') {
              // Status update in dedicated message_status field
              this.handleStatusChange(clientId, change.value);
            }
          });
        });
      }
    } catch (error) {
      console.error('❌ Webhook handling error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }

  /**
   * Handle incoming messages
   */
  async handleMessageChange(clientId, value) {
    if (value.messages) {
      // Process messages sequentially to avoid race conditions
      for (const message of value.messages) {
        console.log(`📩 New message received for client ${clientId}:`, {
          from: message.from,
          type: message.type,
          messageId: message.id,
          timestamp: message.timestamp
        });

        // Process different message types
        if (message.type === 'text') {
          await this.handleTextMessage(clientId, message, value.contacts?.[0]);
        } else if (message.type === 'image') {
          this.handleImageMessage(clientId, message, value.contacts?.[0]);
        } else if (message.type === 'video') {
          this.handleVideoMessage(clientId, message, value.contacts?.[0]);
        } else if (message.type === 'document') {
          this.handleDocumentMessage(clientId, message, value.contacts?.[0]);
        } else if (message.type === 'location') {
          this.handleLocationMessage(clientId, message, value.contacts?.[0]);
        }
      }
    }
  }

  /**
   * Handle delivery/read status updates
   */
  handleStatusChange(clientId, value) {
    // Meta sends statuses as an array in value.statuses
    const statuses = value.statuses || [];
    
    if (statuses.length > 0) {
      statuses.forEach((status) => {
        console.log(`📊 Status update for client ${clientId}:`, {
          messageId: status.id,
          status: status.status,
          recipientId: status.recipient_id,
          timestamp: status.timestamp,
          errors: status.errors || []
        });

        // Log error details if message failed
        if (status.status === 'failed' && status.errors && status.errors.length > 0) {
          status.errors.forEach((error) => {
            console.error(`❌ Message ${status.id} failed for client ${clientId}:`, {
              code: error.code,
              title: error.title,
              message: error.message,
              details: error.error_data?.details
            });
          });
        }
      });
    } else {
      // Fallback: log the entire value if structure is different
      console.log(`📊 Status update for client ${clientId}:`, JSON.stringify(value, null, 2));
    }
    // Handle status updates (sent, delivered, read, failed)
    // Note: Status updates are informational only - no reply needed
  }

  /**
   * Handle text messages
   * Sends an echo reply to the sender using the same clientId
   */
  async handleTextMessage(clientId, message, contact) {
    try {
      const senderPhoneNumber = message.from;
      const receivedText = message.text?.body || '';
      const contactName = contact?.profile?.name || senderPhoneNumber;

      console.log(`💬 Text message from ${contactName} (client: ${clientId}):`, receivedText);

      // Send echo reply - echo back the received message
      const echoMessage = `Echo: ${receivedText}`;
      
      console.log(`📤 Sending echo reply to ${senderPhoneNumber} via client ${clientId}...`);
      
      const result = await this.messageController.sendTextMessage(
        clientId,
        senderPhoneNumber,
        echoMessage
      );

      console.log(`✅ Echo reply sent successfully. Message ID: ${result.messageId}`);
    } catch (error) {
      console.error(`❌ Error sending echo reply for client ${clientId}:`, error.message);
      // Don't throw - webhook processing should continue even if reply fails
    }
  }

  /**
   * Handle image messages
   */
  handleImageMessage(clientId, message, contact) {
    console.log(`🖼️ Image message from ${contact?.name || message.from} (client: ${clientId}):`, message.image.caption || 'No caption');
    // TODO: Process image message
  }

  /**
   * Handle video messages
   */
  handleVideoMessage(clientId, message, contact) {
    console.log(`🎥 Video message from ${contact?.name || message.from} (client: ${clientId}):`, message.video.caption || 'No caption');
    // TODO: Process video message
  }

  /**
   * Handle document messages
   */
  handleDocumentMessage(clientId, message, contact) {
    console.log(`📄 Document from ${contact?.name || message.from} (client: ${clientId}):`, message.document.filename);
    // TODO: Process document message
  }

  /**
   * Handle location messages
   */
  handleLocationMessage(clientId, message, contact) {
    console.log(`📍 Location from ${contact?.name || message.from} (client: ${clientId}):`, {
      latitude: message.location.latitude,
      longitude: message.location.longitude
    });
    // TODO: Process location message
  }

  /**
   * Verify webhook signature (HMAC SHA256)
   * Per Meta's documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
   * 
   * Validation: Generate an HMAC-SHA256 hash using the RAW JSON payload string as the message input 
   * and your app secret as the secret key. Compare your generated hash to the hash assigned 
   * to the X-Hub-Signature-256 header (everything after sha256=).
   * 
   * IMPORTANT: Meta calculates the signature on the RAW body string, NOT on parsed/re-stringified JSON.
   * JSON.stringify() can produce different strings due to key ordering and whitespace.
   * 
   * @param {Buffer|String} rawBody - The RAW request body (Buffer or String) - MUST be raw, not parsed
   * @param {Object} parsedBody - The parsed JSON body (for logging/debugging only)
   * @param {string} signature - The X-Hub-Signature-256 header value (format: "sha256=<hash>")
   * @param {string} appSecret - The app secret from client configuration (decrypted from vault)
   * @returns {boolean} - True if signature is valid, false otherwise
   */
  verifySignature(rawBody, parsedBody, signature, appSecret) {
    if (!appSecret) {
      return false; // Cannot verify without app secret
    }

    // Convert raw body to string if it's a Buffer
    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    
    // Generate expected signature using RAW body string (exactly as Meta sends it)
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', appSecret)
      .update(bodyString)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      // If signature format is invalid, return false
      return false;
    }
  }
}

module.exports = WhatsAppWebhookController;

