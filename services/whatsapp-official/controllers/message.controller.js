const axios = require('axios');
const clientManager = require('../services/client-manager');

/**
 * WhatsApp Business API Message Controller
 * Handles sending messages via Meta's REST API
 * Supports multi-client with clientId in route
 */
class WhatsAppMessageController {
  constructor() {
    this.clientManager = clientManager;
    this.apiVersion = process.env.WA_API_VERSION || 'v24.0';
  }

  /**
   * Handle API request errors and clear cache on authentication failures
   * @private
   */
  handleApiError(clientId, error, requestUrl, requestPayload) {
    const statusCode = error.response?.status;
    const errorData = error.response?.data?.error || {};
    const errorCode = errorData.code;
    const errorSubcode = errorData.error_subcode;
    const errorType = errorData.type;
    
    // Extract phone number ID from URL for better error context
    const phoneNumberIdMatch = requestUrl.match(/\/v\d+\.\d+\/(\d+)\/messages/);
    const phoneNumberId = phoneNumberIdMatch ? phoneNumberIdMatch[1] : 'unknown';
    
    // Log error details
    console.error(`❌ [${clientId}] Error response from Meta API:`);
    console.error(`   Status: ${statusCode || 'N/A'} ${error.response?.statusText || ''}`);
    console.error(`   URL: ${requestUrl}`);
    console.error(`   Phone Number ID used: ${phoneNumberId}`);
    console.error(`   Error Type: ${errorType || 'N/A'}`);
    console.error(`   Error Code: ${errorCode || 'N/A'}`);
    console.error(`   Error Subcode: ${errorSubcode || 'N/A'}`);
    console.error(`   Error Message: ${errorData.message || error.message}`);
    console.error(`   Request Payload:`, JSON.stringify(requestPayload, null, 2));
    console.error(`   Full Error Response:`, JSON.stringify(error.response?.data || {}, null, 2));
    
    // Specific error handling for common issues
    if (errorCode === 100 && errorSubcode === 33) {
      // GraphMethodException: Object doesn't exist or missing permissions
      console.error(`\n🔍 TROUBLESHOOTING for client "${clientId}":`);
      console.error(`   This error typically means:`);
      console.error(`   1. Phone Number ID "${phoneNumberId}" doesn't exist or is incorrect`);
      console.error(`   2. The access token doesn't have permission to use this Phone Number ID`);
      console.error(`   3. The Phone Number ID belongs to a different WhatsApp Business Account`);
      console.error(`   4. The Phone Number ID is from a different Meta App`);
      console.error(`\n   Solutions:`);
      console.error(`   - Verify the Phone Number ID in Meta Business Suite: https://business.facebook.com/settings/whatsapp-business-accounts`);
      console.error(`   - Ensure the access token has "whatsapp_business_messaging" and "whatsapp_business_management" permissions`);
      console.error(`   - Verify both access_token and phone_number_id are from the same Meta App and WhatsApp Business Account`);
      console.error(`   - Check that the Phone Number ID matches the one in your Meta App Dashboard\n`);
    } else if (statusCode === 400 && errorCode === 190) {
      // Invalid OAuth Access Token
      console.error(`\n🔍 TROUBLESHOOTING: Invalid access token`);
      console.error(`   - The access token may have expired`);
      console.error(`   - Regenerate the access token in Meta App Dashboard\n`);
    } else if (statusCode === 401 || statusCode === 403) {
      console.warn(`⚠️ [${clientId}] Authentication error (${statusCode}), clearing client cache...`);
      this.clientManager.clearCache(clientId);
      console.log(`✅ [${clientId}] Cache cleared. Next request will fetch fresh credentials from database.`);
    }
  }

  /**
   * Send a media message programmatically (can be called from webhook or API)
   * @param {string} clientId - Client ID
   * @param {string} to - Recipient phone number
   * @param {string} type - Media type: 'image', 'video', 'audio', 'document', 'sticker'
   * @param {string} mediaUrl - URL of the media
   * @param {string} caption - Optional caption (not used for stickers)
   * @param {string} replyToMessageId - Optional message ID to reply to
   * @returns {Promise<Object>} - Response data with messageId
   */
  async sendMediaMessage(clientId, to, type, mediaUrl, caption = '', replyToMessageId = null) {
    if (!clientId || !to || !type || !mediaUrl) {
      throw new Error('Missing required parameters: clientId, to, type, mediaUrl');
    }

    // Get client credentials from decrypted configuration
    const accessToken = await this.clientManager.getAccessToken(clientId);
    const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
    
    // Validate credentials
    if (!accessToken) {
      throw new Error(`Access token not found for client ${clientId}. Please check client configuration.`);
    }
    
    if (!phoneNumberId) {
      throw new Error(`Phone Number ID not found for client ${clientId}. Please check client configuration.`);
    }
    
    const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const messagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: type
    };

    // Add media-specific fields
    if (type === 'image') {
      messagePayload.image = {
        link: mediaUrl,
        caption: caption || ''
      };
    } else if (type === 'video') {
      messagePayload.video = {
        link: mediaUrl,
        caption: caption || ''
      };
    } else if (type === 'document') {
      messagePayload.document = {
        link: mediaUrl,
        caption: caption || '',
        filename: caption || 'document'
      };
    } else if (type === 'audio') {
      messagePayload.audio = {
        link: mediaUrl
      };
    } else if (type === 'sticker') {
      // Sticker messages - supports both static and animated stickers
      // Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages
      // 
      // Requirements for stickers:
      // - Static stickers: 512×512 pixels, max 100 KB, .webp format, transparent background
      // - Animated stickers: 512×512 pixels, max 500 KB, .webp format, transparent background
      // - URL must be publicly accessible with proper Content-Type headers (image/webp)
      messagePayload.sticker = {
        link: mediaUrl
      };
      // Note: Stickers don't support captions, so we ignore the caption parameter
      console.log(`📎 [Message Controller] Sending sticker from URL: ${mediaUrl}`);
    } else {
      throw new Error(`Invalid media type: ${type}. Supported: image, video, document, audio, sticker`);
    }

    // Add context for reply if messageId provided
    if (replyToMessageId) {
      messagePayload.context = {
        message_id: replyToMessageId
      };
    }

    const requestHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    try {
      const response = await axios.post(
        requestUrl,
        messagePayload,
        {
          headers: requestHeaders
        }
      );

      console.log(`✅ Media message sent to ${to} via client ${clientId}:`, response.data.messages?.[0]?.id);

      return {
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      };
    } catch (error) {
      // Enhanced error handling for sticker errors
      if (type === 'sticker' && error.response?.data?.error?.code === 131053) {
        console.error(`⚠️  [Message Controller] Sticker media upload error (131053) for ${to}`);
        console.error(`   Sticker URL: ${mediaUrl}`);
        console.error(`   Common causes:`);
        console.error(`   1. URL not publicly accessible (Meta servers can't download it)`);
        console.error(`   2. File doesn't meet requirements: 512×512px, max 100KB (static) or 500KB (animated), .webp format`);
        console.error(`   3. Missing or incorrect Content-Type: image/webp header`);
        console.error(`   4. File doesn't have transparent background`);
        console.error(`   Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/sticker-messages`);
      }
      this.handleApiError(clientId, error, requestUrl, messagePayload);
      throw error;
    }
  }

  /**
   * Send a location message
   * @param {string} clientId - Client ID
   * @param {string} to - Recipient phone number
   * @param {number} latitude - Latitude coordinate
   * @param {number} longitude - Longitude coordinate
   * @param {string} name - Optional location name
   * @param {string} address - Optional location address
   * @returns {Promise<Object>} - Response data with messageId
   */
  async sendLocationMessage(clientId, to, latitude, longitude, name = '', address = '') {
    if (!clientId || !to || latitude === undefined || longitude === undefined) {
      throw new Error('Missing required parameters: clientId, to, latitude, longitude');
    }

    const accessToken = await this.clientManager.getAccessToken(clientId);
    const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
    
    if (!accessToken || !phoneNumberId) {
      throw new Error(`Missing credentials for client ${clientId}`);
    }

    const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const requestPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'location',
      location: {
        latitude: latitude,
        longitude: longitude
      }
    };

    // Add optional name and address if provided
    if (name) {
      requestPayload.location.name = name;
    }
    if (address) {
      requestPayload.location.address = address;
    }

    try {
      const response = await axios.post(requestUrl, requestPayload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Location message sent to ${to} via client ${clientId}:`, response.data.messages?.[0]?.id);
      return {
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      };
    } catch (error) {
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      throw error;
    }
  }

  /**
   * Send a reaction message
   * @param {string} clientId - Client ID
   * @param {string} to - Recipient phone number
   * @param {string} messageId - Message ID to react to
   * @param {string} emoji - Emoji reaction (e.g., "👍", "❤️", "😄") or empty string to remove reaction
   * @returns {Promise<Object>} - Response data with messageId
   */
  async sendReactionMessage(clientId, to, messageId, emoji = '👍') {
    if (!clientId || !to || !messageId) {
      throw new Error('Missing required parameters: clientId, to, messageId');
    }

    const accessToken = await this.clientManager.getAccessToken(clientId);
    const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
    
    if (!accessToken || !phoneNumberId) {
      throw new Error(`Missing credentials for client ${clientId}`);
    }

    const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const requestPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'reaction',
      reaction: {
        message_id: messageId,
        emoji: emoji || '' // Empty string removes reaction, emoji adds/replaces reaction
      }
    };

    try {
      const response = await axios.post(requestUrl, requestPayload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Reaction message sent to ${to} via client ${clientId}:`, response.data.messages?.[0]?.id);
      return {
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      };
    } catch (error) {
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      throw error;
    }
  }

  /**
   * Send a text message programmatically (can be called from webhook or API)
   * @param {string} clientId - Client ID
   * @param {string} to - Recipient phone number
   * @param {string} message - Message text
   * @param {string} replyToMessageId - Optional message ID to reply to
   * @returns {Promise<Object>} - Response data with messageId
   */
  async sendTextMessage(clientId, to, message, replyToMessageId = null) {
    if (!clientId || !to || !message) {
      throw new Error('Missing required parameters: clientId, to, message');
    }

    // Get client credentials from decrypted configuration
    const accessToken = await this.clientManager.getAccessToken(clientId);
    const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
    
    // Validate credentials
    if (!accessToken) {
      throw new Error(`Access token not found for client ${clientId}. Please check client configuration.`);
    }
    
    if (!phoneNumberId) {
      throw new Error(`Phone Number ID not found for client ${clientId}. Please check client configuration.`);
    }
    
    // Warn if phone number ID looks invalid (not a numeric string)
    if (phoneNumberId && !/^\d+$/.test(phoneNumberId.toString())) {
      console.warn(`⚠️ [${clientId}] Warning: Phone Number ID "${phoneNumberId}" may be invalid. It should be a numeric string (e.g., "123456789012345").`);
    }
    
    const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;
    const requestUrl = `${baseUrl}/messages`;

    const requestPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    };

    // Add context for reply if messageId provided
    if (replyToMessageId) {
      requestPayload.context = {
        message_id: replyToMessageId
      };
    }

    const requestHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    // Log request details
    console.log(`📤 [${clientId}] Request to Meta API:`);
    console.log(`   URL: ${requestUrl}`);
    console.log(`   Method: POST`);
    console.log(`   Phone Number ID: ${phoneNumberId}`);
    console.log(`   Access Token: ${accessToken ? `${accessToken.substring(0, 20)}...` : 'MISSING'}`);
    console.log(`   To: ${to}`);
    console.log(`   Message: ${message}`);
    console.log(`   Payload:`, JSON.stringify(requestPayload, null, 2));

    try {
      const response = await axios.post(
        requestUrl,
        requestPayload,
        {
          headers: requestHeaders
        }
      );

      // Log successful response
      console.log(`✅ [${clientId}] Response from Meta API:`);
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Message ID: ${response.data.messages?.[0]?.id || 'N/A'}`);
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));

      return {
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      };
    } catch (error) {
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      throw error;
    }
  }

  /**
   * Send a text message (API endpoint handler)
   * POST /api/v1/messages/:clientId/text
   */
  async sendText(req, res) {
    try {
      const { clientId } = req.params;
      const { to, message } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, message'
        });
      }

      const result = await this.sendTextMessage(clientId, to, message);
      res.json(result);
    } catch (error) {
      console.error(`❌ Error sending text message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Send a media message (image, video, document, audio)
   * POST /api/v1/messages/:clientId/media
   */
  async sendMedia(req, res) {
    try {
      const { clientId } = req.params;
      const { to, type, mediaUrl, caption } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !type || !mediaUrl) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, type, mediaUrl'
        });
      }

      // Get client credentials from decrypted configuration
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      
      // Validate credentials
      if (!accessToken) {
        return res.status(400).json({
          success: false,
          error: `Access token not found for client ${clientId}. Please check client configuration.`
        });
      }
      
      if (!phoneNumberId) {
        return res.status(400).json({
          success: false,
          error: `Phone Number ID not found for client ${clientId}. Please check client configuration.`
        });
      }
      
      // Warn if phone number ID looks invalid
      if (phoneNumberId && !/^\d+$/.test(phoneNumberId.toString())) {
        console.warn(`⚠️ [${clientId}] Warning: Phone Number ID "${phoneNumberId}" may be invalid.`);
      }
      
      const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;

      const messagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: type
      };

      // Add media-specific fields
      if (type === 'image') {
        messagePayload.image = {
          link: mediaUrl,
          caption: caption || ''
        };
      } else if (type === 'video') {
        messagePayload.video = {
          link: mediaUrl,
          caption: caption || ''
        };
      } else if (type === 'document') {
        messagePayload.document = {
          link: mediaUrl,
          caption: caption || '',
          filename: req.body.filename || 'document'
        };
      } else if (type === 'audio') {
        messagePayload.audio = {
          link: mediaUrl
        };
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid media type. Supported: image, video, document, audio'
        });
      }

      const requestUrl = `${baseUrl}/messages`;
      const response = await axios.post(
        requestUrl,
        messagePayload,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Media message sent to ${to} via client ${clientId}:`, response.data);

      res.json({
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      });
    } catch (error) {
      const requestUrl = `${baseUrl}/messages`;
      const payload = typeof messagePayload !== 'undefined' ? messagePayload : { to, type, mediaUrl };
      this.handleApiError(clientId, error, requestUrl, payload);
      console.error(`❌ Error sending media message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Send a template message
   * POST /api/v1/messages/:clientId/template
   */
  async sendTemplate(req, res) {
    try {
      const { clientId } = req.params;
      const { to, templateName, languageCode, components } = req.body;

      if (!clientId) {
        return res.status(400).json({
          success: false,
          error: 'clientId is required in route parameter'
        });
      }

      if (!to || !templateName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, templateName'
        });
      }

      // Get client credentials from decrypted configuration
      const accessToken = await this.clientManager.getAccessToken(clientId);
      const phoneNumberId = await this.clientManager.getPhoneNumberId(clientId);
      
      // Validate credentials
      if (!accessToken) {
        return res.status(400).json({
          success: false,
          error: `Access token not found for client ${clientId}. Please check client configuration.`
        });
      }
      
      if (!phoneNumberId) {
        return res.status(400).json({
          success: false,
          error: `Phone Number ID not found for client ${clientId}. Please check client configuration.`
        });
      }
      
      // Warn if phone number ID looks invalid
      if (phoneNumberId && !/^\d+$/.test(phoneNumberId.toString())) {
        console.warn(`⚠️ [${clientId}] Warning: Phone Number ID "${phoneNumberId}" may be invalid.`);
      }
      
      const baseUrl = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}`;

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode || 'en_US'
          }
        }
      };

      if (components) {
        payload.template.components = components;
      }

      const requestUrl = `${baseUrl}/messages`;
      const response = await axios.post(
        requestUrl,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Template message sent to ${to} via client ${clientId}:`, response.data);

      res.json({
        success: true,
        messageId: response.data.messages[0].id,
        clientId: clientId,
        data: response.data
      });
    } catch (error) {
      const requestUrl = `${baseUrl}/messages`;
      const requestPayload = typeof payload !== 'undefined' ? payload : { to, templateName, languageCode };
      this.handleApiError(clientId, error, requestUrl, requestPayload);
      console.error(`❌ Error sending template message for client ${req.params.clientId}:`, error.response?.data || error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message
      });
    }
  }

  /**
   * Get message status
   * GET /api/v1/messages/:clientId/status/:messageId
   */
  async getMessageStatus(req, res) {
    try {
      const { messageId } = req.params;

      // Note: Meta doesn't provide a direct endpoint to check message status
      // Status updates are received via webhooks
      res.json({
        success: true,
        message: 'Message status is received via webhooks. Check webhook events for status updates.',
        messageId: messageId
      });
    } catch (error) {
      console.error('❌ Error getting message status:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = WhatsAppMessageController;

