import { Request, Response } from 'express';
import { WeaviateService } from '../services/weaviate.service';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import mongoose from 'mongoose';

// Stream Producer for publishing events
const { StreamProducer } = require('../../services/pubsub/client/producer');

// Import PlatformClientAgent model (reuse from platform.controller)
interface INeedAttentionHistory {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  previousOption?: string;
  from?: Date;
  to?: Date;
  reason?: string;
  changedAt: Date;
  changedBy?: {
    id: string;
    name: string;
    role: string;
    avatarUrl?: string;
  };
  taken?: {
    by: {
      id: string;
      name: string;
      role: string;
      avatarUrl?: string;
    };
  };
}

interface IPlatformClientAgent extends mongoose.Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  privateAgentAssignment?: Array<{
    userIdentifier: string;
    agentCode: string;
  }>;
  needAttention?: INeedAttention[];
  needAttentionHistory?: INeedAttentionHistory[];
}

let PlatformClientAgent: mongoose.Model<IPlatformClientAgent>;
try {
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
} catch (error) {
  // Model will be created by platform.controller
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
}

// NeedAttention interface (same as platform.controller)
interface INeedAttention {
  userIdentifier: string;
  option: 'pause' | 'release' | 'block' | 'taken';
  from?: Date;
  to?: Date;
  reason?: string;
  updatedAt?: Date;
  taken?: {
    by: {
      id: string;
      name: string;
      role: string;
      avatarUrl?: string;
    }
  };
}

/**
 * Chat Controller
 * Handles chat API endpoints for conversations and messages
 */
export class ChatController {
  constructor(
    private weaviateService: WeaviateService,
    private whatsappService: WPPConnectWhatsAppService
  ) {}

  /**
   * Get conversation room list for a user or all conversations for an agent
   * GET /api/v1/platform/chat/conversations
   * Query params: userIdentifier (optional), limit, offset
   * 
   * - If userIdentifier is provided: returns conversations for that user
   * - If userIdentifier is NOT provided: returns ALL conversations for the agentCode (tenant)
   * 
   * Tenant (agent_code) is REQUIRED and extracted from JWT token.
   * Only returns conversations for the agent specified in the JWT.
   */
  async getUserConversations(req: Request, res: Response): Promise<void> {
    try {
      const { userIdentifier } = req.query;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      // Validate limit and offset
      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      // If userIdentifier is provided, get conversations for that user
      // Otherwise, get all conversations for the agentCode (tenant)
      let result;
      if (userIdentifier && typeof userIdentifier === 'string') {
        result = await this.weaviateService.getUserConversations(
          userIdentifier as string,
          limit,
          offset,
          agentCode // Pass agentCode as tenant (required)
        );
      } else {
        result = await this.weaviateService.getAllConversations(
          limit,
          offset,
          agentCode // Pass agentCode as tenant (required)
        );
      }

      res.json({
        success: true,
        conversations: result.conversations.map(conv => ({
          conversationId: conv.hashed_id || conv._additional?.id || conv.conversation_id, // Use hashed_id as conversationId (universal ID)
          clientId: conv.client_id,
          platform: conv.platform,
          participantIds: conv.participant_ids || [],
          createdAt: conv.created_at,
          lastEventAt: conv.last_event_at,
          lastReadAt: conv.last_read_at || null,
          lastBroadcastId: conv.last_broadcast_id || null,
          lastBroadcastAt: conv.last_broadcast_at || null,
          isBroadcasted: conv.is_broadcasted === true,
          lastBroadcastContent: (() => {
            try {
              return conv.last_broadcast_content ? JSON.parse(conv.last_broadcast_content) : null;
            } catch {
              return null;
            }
          })(),
          lastEventType: conv.last_event_type,
          lastEventContent: conv.last_event_content ? JSON.parse(conv.last_event_content) : null,
          lastSenderType: conv.last_sender_type,
          lastSenderId: conv.last_sender_id,
          lastSenderDisplayName: conv.last_sender_display_name,
          status: conv.status,
          lastAttention: conv.last_attention ? JSON.parse(conv.last_attention) : null
        })),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: result.hasMore
        }
      });
    } catch (error) {
      console.error('❌ Error getting user conversations:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get user conversations',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get chats in a conversation
   * GET /api/v1/platform/chat/conversations/:conversationId/chats
   * Query params: limit, offset
   * 
   * conversationId can be:
   * - hashed_id (universal ID, preferred): e.g., "mhSSVwWhku7HDR+5ukDJumRDin5Tx9BbZpsbkrDNapA="
   * - Weaviate _id (fallback): e.g., "32ca98f6-e414-5aaa-908f-763500c1a4ce"
   * 
   * Tenant (agent_code) is REQUIRED and extracted from JWT token.
   * Only returns chats for the agent specified in the JWT.
   */
  async getConversationChats(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: 'conversationId is required'
        });
        return;
      }

      // Validate limit and offset
      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      const result = await this.weaviateService.getConversationChats(
        conversationId,
        limit,
        offset,
        agentCode // Pass agentCode as tenant (required)
      );

      res.json({
        success: true,
        conversationId,
        chats: result.chats.map((chat: any) => ({
          eventId: chat.event_id,
          eventType: chat.event_type,
          senderType: chat.sender_type,
          senderId: chat.sender_id,
          senderDisplayName: chat.sender_display_name,
          senderAvatarUrl: chat.sender_avatar_url,
          content: chat.content ? JSON.parse(chat.content) : null,
          sequence: chat.sequence,
          createdAt: chat.created_at,
          visibility: chat.visibility
        })),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: result.hasMore
        }
      });
    } catch (error) {
      console.error('❌ Error getting conversation chats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get conversation chats',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Post a chat message to a conversation
   * POST /api/v1/platform/chat/conversations/:conversationId/messages
   * Body: { content: string, messageType?: string, mediaUrl?: string, caption?: string }
   * 
   * This will publish a message event to the stream, which will be forwarded
   * to WPP or WA Official to reply to the user
   * 
   * For media messages (image, video, file, document, sticker), mediaUrl is required.
   * Caption is optional for media messages (falls back to content if provided).
   */
  async postChatMessage(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const { content, messageType = 'text', mediaUrl, caption, broadcastId } = req.body;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: 'conversationId is required'
        });
        return;
      }

      // Media types that require mediaUrl
      const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
      const isMediaType = mediaTypes.includes(messageType);
      
      // For text messages, content is required. For media messages, mediaUrl is required.
      if (!isMediaType && (!content || typeof content !== 'string')) {
        res.status(400).json({
          success: false,
          error: 'content is required and must be a string for text messages'
        });
        return;
      }
      
      if (isMediaType && (!mediaUrl || typeof mediaUrl !== 'string' || mediaUrl.trim() === '')) {
        res.status(400).json({
          success: false,
          error: `mediaUrl is required for media message type '${messageType}'`
        });
        return;
      }

      if (broadcastId !== undefined && broadcastId !== null && broadcastId !== '') {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof broadcastId !== 'string' || !uuidRegex.test(broadcastId)) {
          res.status(400).json({
            success: false,
            error: 'broadcastId must be a valid UUID when provided'
          });
          return;
        }
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token. Please ensure your JWT token contains an agentCode field.'
        });
        return;
      }

      // Get conversation by hashed_id (universal ID) with fallback to Weaviate _id
      // This will try hashed_id first, then fallback to _id if not found
      const conversation = await this.weaviateService.getConversationById(conversationId, agentCode);
      
      if (!conversation) {
        res.status(404).json({
          success: false,
          error: `Conversation ${conversationId} not found`
        });
        return;
      }

      // Extract clientId and userIdentifier from conversation
      const clientId = conversation.client_id;
      const userIdentifier = conversation.participant_ids?.find((id: string) => 
        id !== clientId && id !== agentCode && !id.includes(':')
      ) || conversation.participant_ids?.[0] || null;

      if (!clientId || !userIdentifier) {
        res.status(400).json({
          success: false,
          error: 'Could not extract clientId and userIdentifier from conversation'
        });
        return;
      }

      // Check if client exists (either WPP or WA-Official)
      const clientInfo = this.whatsappService.getClient(clientId);
      const platformClient = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      });

      if (!clientInfo && !platformClient) {
        res.status(404).json({
          success: false,
          error: `Client ${clientId} not found`
        });
        return;
      }

      // Determine platform
      const platform = clientInfo ? 'wpp' : (platformClient?.platform || 'wpp');

      // Get agent code (check for private assignment first)
      // Use agentCode from JWT as base, but check for private assignment override
      let finalAgentCode = agentCode; // Start with JWT agentCode
      
      // Check for private agent assignment
      if (platformClient) {
        try {
          if (platformClient.privateAgentAssignment) {
            const privateAssignment = platformClient.privateAgentAssignment.find(
              (a: any) => a.userIdentifier === userIdentifier
            );
            if (privateAssignment) {
              finalAgentCode = privateAssignment.agentCode;
            }
          }
        } catch (error) {
          console.warn('⚠️ Could not check private agent assignment:', error);
        }
      }

      if (!finalAgentCode) {
        res.status(400).json({
          success: false,
          error: `No agent assigned to client ${clientId} for user ${userIdentifier}`
        });
        return;
      }

      // Generate a unique message ID
      const messageId = `api-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Extract sender information from JWT (if provided)
      const jwtUser = (req as any).user || {};
      const senderInfo = jwtUser.sender ? {
        senderId: jwtUser.sender.senderId || jwtUser.sender.id || jwtUser.agentCode || 'system',
        senderDisplayName: jwtUser.sender.senderDisplayName || jwtUser.sender.displayName || jwtUser.sender.name || null,
        senderRoleLabel: jwtUser.sender.senderRoleLabel || jwtUser.sender.roleLabel || 'agent',
        senderAvatarUrl: jwtUser.sender.senderAvatarUrl || jwtUser.sender.avatarUrl || null
      } : {
        senderId: jwtUser.agentCode || 'system',
        senderDisplayName: null,
        senderRoleLabel: 'agent',
        senderAvatarUrl: null
      };

      // Publish to stream first - consumers (WPP/WA-Official) will handle sending
      try {
        const { StreamProducer } = require('../../services/pubsub/client/producer');
        const producer = new StreamProducer();
        
        await producer.connect();
        
        // Publish as outgoing message event - consumers will send it
        // Platform is determined from client type (wpp or wa-official)
        // Note: hashed_id (conversationId) is included in metadata for reference,
        // but consumers use clientId and userIdentifier to send messages
        const messageData: any = {
          clientId,
          platform: platform, // 'wpp' or 'wa-official'
          userIdentifier,
          agentCode: finalAgentCode, // Use finalAgentCode (may be overridden by private assignment)
          messageId,
          messageType: messageType || 'text',
          content: content || '', // Allow empty for media messages
          metadata: {
            source: 'api',
            postedBy: jwtUser.agentCode || 'system',
            sender: senderInfo, // Include sender information from JWT
            conversationId: conversationId, // hashed_id (universal ID) for reference/tracking
            timestamp: new Date().toISOString(),
            ...(broadcastId && { broadcastId })
          }
        };
        
        // Add mediaUrl and caption if provided (for media messages)
        if (mediaUrl) {
          messageData.mediaUrl = mediaUrl;
        }
        if (caption) {
          messageData.caption = caption;
        }
        
        const entryId = await producer.publishOutgoingMessage(messageData);

        console.log(`✅ Published outgoing message to stream: ${entryId} (conversationId: ${conversationId})`);

        if (broadcastId && conversation?.conversation_id) {
          const broadcastContent = isMediaType
            ? [{ type: messageType, url: mediaUrl, text: caption || content || '' }]
            : [{ type: 'text', text: content || '' }];
          await this.weaviateService.updateConversationLastBroadcast(
            finalAgentCode,
            conversationId,
            broadcastId,
            broadcastContent
          );
        }

        // Return success response immediately
        // The message will be sent by the consumer (WPP/WA-Official)
        res.status(201).json({
          success: true,
          message: 'Chat message published to stream - will be sent by consumer',
          data: {
            conversationId,
            messageId,
            content: content || '',
            messageType,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            entryId,
            publishedAt: new Date().toISOString()
          }
        });
      } catch (streamError: any) {
        console.error('❌ Error publishing outgoing message to stream:', streamError);
        res.status(500).json({
          success: false,
          error: 'Failed to publish message to stream',
          details: streamError instanceof Error ? streamError.message : 'Unknown error'
        });
      }
    } catch (error) {
      console.error('❌ Error posting chat message:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to post chat message',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Post one or multiple messages directly using clientId and userIdentifier
   * POST /api/v1/platform/:platform/chat/messages
   * Body: { 
   *   userIdentifier: string, 
   *   messages: [
   *     {
   *       messageType: string,
   *       content?: string,
   *       mediaUrl?: string,
   *       caption?: string
   *     }
   *   ]
   * }
   * 
   * Note: clientId is extracted from JWT token (clientId or client_metadata.client_id)
   * 
   * This endpoint skips Weaviate lookup and sends directly.
   * Supports batch sending of multiple messages.
   */
  async postDirectBatchMessage(req: Request, res: Response): Promise<void> {
    try {
      const { platform } = req.params;
      const { userIdentifier, messages, broadcastId } = req.body;

      // Validate platform
      if (!platform || !['wpp', 'wa-official'].includes(platform)) {
        res.status(400).json({
          success: false,
          error: 'platform must be either "wpp" or "wa-official"'
        });
        return;
      }

      // Extract agentCode and clientId from JWT token
      const jwtUser = (req as any).user || {};
      const agentCode = jwtUser.agentCode;
      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      // Extract clientId from JWT (try multiple possible locations)
      const clientId = jwtUser.clientId || 
                      jwtUser.client_metadata?.client_id || 
                      jwtUser.client_metadata?.clientId;
      
      if (!clientId || typeof clientId !== 'string') {
        res.status(400).json({
          success: false,
          error: 'clientId is required in JWT token (clientId or client_metadata.client_id)'
        });
        return;
      }

      if (!userIdentifier || typeof userIdentifier !== 'string') {
        res.status(400).json({
          success: false,
          error: 'userIdentifier is required and must be a string'
        });
        return;
      }

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          success: false,
          error: 'messages is required and must be a non-empty array'
        });
        return;
      }

      // Validate each message in the array
      const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        
        if (!msg.messageType || typeof msg.messageType !== 'string') {
          res.status(400).json({
            success: false,
            error: `messages[${i}].messageType is required and must be a string`
          });
          return;
        }

        const isMediaType = mediaTypes.includes(msg.messageType);
        
        if (!isMediaType && (!msg.content || typeof msg.content !== 'string')) {
          res.status(400).json({
            success: false,
            error: `messages[${i}].content is required and must be a string for text messages`
          });
          return;
        }
        
        if (isMediaType && (!msg.mediaUrl || typeof msg.mediaUrl !== 'string' || msg.mediaUrl.trim() === '')) {
          res.status(400).json({
            success: false,
            error: `messages[${i}].mediaUrl is required for media message type '${msg.messageType}'`
          });
          return;
        }
      }

      if (broadcastId !== undefined && broadcastId !== null && broadcastId !== '') {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof broadcastId !== 'string' || !uuidRegex.test(broadcastId)) {
          res.status(400).json({
            success: false,
            error: 'broadcastId must be a valid UUID when provided'
          });
          return;
        }
      }

      // Check if client exists (either WPP or WA-Official)
      const clientInfo = this.whatsappService.getClient(clientId);
      const platformClient = await PlatformClientAgent.findOne({
        clientId,
        isActive: true
      });

      // Validate client exists for the specified platform
      if (platform === 'wpp' && !clientInfo) {
        res.status(404).json({
          success: false,
          error: `WPP client ${clientId} not found`
        });
        return;
      }

      if (platform === 'wa-official' && !platformClient) {
        res.status(404).json({
          success: false,
          error: `WA-Official client ${clientId} not found`
        });
        return;
      }

      // Get agent code (check for private assignment first)
      let finalAgentCode = agentCode;
      
      if (platformClient) {
        try {
          if (platformClient.privateAgentAssignment) {
            const privateAssignment = platformClient.privateAgentAssignment.find(
              (a: any) => a.userIdentifier === userIdentifier
            );
            if (privateAssignment) {
              finalAgentCode = privateAssignment.agentCode;
            }
          }
        } catch (error) {
          console.warn('⚠️ Could not check private agent assignment:', error);
        }
      }

      if (!finalAgentCode) {
        res.status(400).json({
          success: false,
          error: `No agent assigned to client ${clientId} for user ${userIdentifier}`
        });
        return;
      }

      // Extract sender information from JWT (already extracted above)
      const senderInfo = jwtUser.sender ? {
        senderId: jwtUser.sender.senderId || jwtUser.sender.id || jwtUser.agentCode || 'system',
        senderDisplayName: jwtUser.sender.senderDisplayName || jwtUser.sender.displayName || jwtUser.sender.name || null,
        senderRoleLabel: jwtUser.sender.senderRoleLabel || jwtUser.sender.roleLabel || 'agent',
        senderAvatarUrl: jwtUser.sender.senderAvatarUrl || jwtUser.sender.avatarUrl || null
      } : {
        senderId: jwtUser.agentCode || 'system',
        senderDisplayName: null,
        senderRoleLabel: 'agent',
        senderAvatarUrl: null
      };

      // Initialize producer and calculate hashedId for reference
      const producer = new StreamProducer();
      await producer.connect();
      
      let hashedId = null;
      try {
        hashedId = producer.hashRoomId(finalAgentCode, clientId, userIdentifier);
      } catch (error) {
        console.warn('⚠️ Could not calculate hashedId:', error);
      }

      const publishedMessages = [];
      const errors = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        
        try {
          // Generate unique message ID for each message
          const messageId = `api-${Date.now()}-${Math.random().toString(36).substring(7)}-${i}`;

          const messageData: any = {
            clientId,
            platform,
            userIdentifier,
            agentCode: finalAgentCode,
            messageId,
            messageType: msg.messageType || 'text',
            content: msg.content || '',
            metadata: {
              source: 'api',
              postedBy: jwtUser.agentCode || 'system',
              sender: senderInfo,
              conversationId: hashedId,
              timestamp: new Date().toISOString(),
              batchIndex: i, // Track position in batch
              batchTotal: messages.length, // Total messages in batch
              ...(broadcastId && { broadcastId })
            }
          };
          
          if (msg.mediaUrl) {
            messageData.mediaUrl = msg.mediaUrl;
          }
          if (msg.caption) {
            messageData.caption = msg.caption;
          }
          
          const entryId = await producer.publishOutgoingMessage(messageData);

          publishedMessages.push({
            messageId,
            messageType: msg.messageType,
            content: msg.content || '',
            mediaUrl: msg.mediaUrl || undefined,
            caption: msg.caption || undefined,
            entryId,
            index: i
          });

          console.log(`✅ Published message ${i + 1}/${messages.length} to stream: ${entryId} (clientId: ${clientId}, userIdentifier: ${userIdentifier})`);
        } catch (error: any) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push({
            index: i,
            messageType: msg.messageType,
            error: errorMsg
          });
          console.error(`❌ Error publishing message ${i + 1}/${messages.length}:`, errorMsg);
        }
      }

      // Return response with all published messages
      if (publishedMessages.length === 0) {
        res.status(500).json({
          success: false,
          error: 'Failed to publish all messages',
          errors
        });
        return;
      }

      if (broadcastId && hashedId) {
        const broadcastContent = messages.map((msg: any) => {
          const mediaTypes = ['image', 'video', 'audio', 'file', 'document', 'sticker'];
          const isMedia = mediaTypes.includes(msg.messageType);
          return isMedia
            ? { type: msg.messageType, url: msg.mediaUrl, text: msg.caption || msg.content || '' }
            : { type: 'text', text: msg.content || '' };
        });
        await this.weaviateService.updateConversationLastBroadcast(
          finalAgentCode,
          hashedId,
          broadcastId,
          broadcastContent
        );
      }

      res.status(201).json({
        success: true,
        message: `Published ${publishedMessages.length} of ${messages.length} message(s) to stream`,
        data: {
          clientId,
          userIdentifier,
          platform,
          conversationId: hashedId,
          totalMessages: messages.length,
          publishedMessages,
          errors: errors.length > 0 ? errors : undefined,
          publishedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('❌ Error posting direct batch message:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to post messages',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get contacts (UserIdentity) from Weaviate
   * GET /api/v1/platform/chat/contacts?limit=20&offset=0&q=searchquery
   * 
   * Query params:
   * - limit: Number of results (default: 20, max: 100)
   * - offset: Pagination offset (default: 0)
   * - q: Optional search query (searches in identifier and data fields)
   * 
   * If search query (q) is not provided or blank, returns all contacts.
   * Tenant (agent_code) is REQUIRED and extracted from JWT token.
   */
  async getContacts(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;
      const searchQuery = (req.query.q as string) || null;

      // Validate limit and offset
      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const jwtUser = (req as any).user || {};
      const agentCode = jwtUser.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      // Get contacts from Weaviate
      const result = await this.weaviateService.getUserContacts(
        limit,
        offset,
        searchQuery,
        agentCode
      );

      res.json({
        success: true,
        data: {
          contacts: result.contacts,
          pagination: {
            limit,
            offset,
            total: result.total,
            hasMore: result.hasMore
          }
        }
      });
    } catch (error) {
      console.error('❌ Error getting contacts:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get contacts',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get broadcast data from MongoDB
   * GET /api/v1/platform/chat/broadcasts?limit=20&offset=0
   *
   * Filtered by agentCode from JWT.
   * Returns: id, counter, target_activities
   */
  async getBroadcasts(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      if (limit < 1 || limit > 100) {
        res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100'
        });
        return;
      }

      if (offset < 0) {
        res.status(400).json({
          success: false,
          error: 'offset must be >= 0'
        });
        return;
      }

      const agentCode = (req as any).user?.agentCode;
      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      const PlatformClientBroadcast = mongoose.model('PlatformClientBroadcast');
      const [broadcasts, total] = await Promise.all([
        PlatformClientBroadcast.find({ agentCode })
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean(),
        PlatformClientBroadcast.countDocuments({ agentCode })
      ]);

      res.json({
        success: true,
        broadcasts: broadcasts.map((b: any) => ({
          id: b.broadcast_uuid,
          counter: b.counter || {
            recipients_total: 0,
            delivered: 0,
            read: 0,
            reply: 0
          },
          target_activities: b.target_activities || []
        })),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + broadcasts.length < total
        }
      });
    } catch (error) {
      console.error('❌ Error getting broadcasts:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get broadcasts',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Set need attention status for a conversation by hashedId
   * PUT /api/v1/platform/chat/conversations/:hashedId/:action
   * Actions: block, pause, release, taken
   */
  async setConversationNeedAttention(req: Request, res: Response): Promise<void> {
    try {
      const { hashedId, action } = req.params;
      const { from, to, reason } = req.body;

      if (!hashedId) {
        res.status(400).json({
          success: false,
          message: 'hashedId is required'
        });
        return;
      }

      if (!action) {
        res.status(400).json({
          success: false,
          message: 'action is required (block, pause, release, or taken)'
        });
        return;
      }

      if (!['pause', 'release', 'block', 'taken'].includes(action)) {
        res.status(400).json({
          success: false,
          message: 'action must be one of: block, pause, release, taken'
        });
        return;
      }

      // Get agentCode from JWT
      const jwtUser = (req as any).user || {};
      const agentCode = jwtUser.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          message: 'agentCode is required in JWT token'
        });
        return;
      }

      // Get conversation by hashedId
      const conversation = await this.weaviateService.getConversationById(hashedId, agentCode);
      
      if (!conversation) {
        res.status(404).json({
          success: false,
          message: `Conversation with hashedId ${hashedId} not found`
        });
        return;
      }

      // Extract clientId and userIdentifier from conversation_id format: "clientId:userIdentifier"
      const conversationIdParts = conversation.conversation_id.split(':');
      if (conversationIdParts.length !== 2 || !conversationIdParts[0] || !conversationIdParts[1]) {
        res.status(400).json({
          success: false,
          message: 'Could not extract clientId and userIdentifier from conversation'
        });
        return;
      }

      const clientId = conversationIdParts[0];
      const userIdentifier = conversationIdParts[1];

      // Query MongoDB for needAttention
      const existingDoc = await PlatformClientAgent.findOne({ clientId, isActive: true }).lean() as IPlatformClientAgent | null;
      
      if (!existingDoc) {
        res.status(404).json({
          success: false,
          message: `Client ${clientId} not found in PlatformClientAgent collection.`
        });
        return;
      }

      const existingNeedAttention = (existingDoc.needAttention as INeedAttention[]) || [];
      const existingHistory = (existingDoc.needAttentionHistory as any[]) || [];
      let updatedNeedAttention: INeedAttention[];
      let previousOption: string | undefined;

      if (action === 'release') {
        // Find the previous option before release
        const existingItem = existingNeedAttention.find(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );
        previousOption = existingItem?.option;

        // Remove the user from needAttention array
        updatedNeedAttention = existingNeedAttention.filter(
          (item: INeedAttention) => item.userIdentifier !== userIdentifier
        );
        console.log(`✅ Released user ${userIdentifier} from needAttention for client ${clientId}`);
      } else {
        // Upsert: update if exists, add if not
        const existingIndex = existingNeedAttention.findIndex(
          (item: INeedAttention) => item.userIdentifier === userIdentifier
        );

        // Get previous option if updating existing entry
        if (existingIndex >= 0 && existingNeedAttention[existingIndex]) {
          previousOption = existingNeedAttention[existingIndex].option;
        }

        const needAttentionItem: INeedAttention = {
          userIdentifier,
          option: action as 'pause' | 'block' | 'taken',
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

        // Extract sender information from JWT for 'taken' action
        if (action === 'taken') {
          const sender = jwtUser.sender || {};
          
          if (!sender.senderId && !sender.id) {
            res.status(400).json({
              success: false,
              message: 'sender information is required in JWT for "taken" action'
            });
            return;
          }
          
          needAttentionItem.taken = {
            by: {
              id: sender.senderId || sender.id || '',
              name: sender.senderDisplayName || sender.displayName || '',
              role: sender.senderRoleLabel || sender.roleLabel || 'agent',
              avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
            }
          };
        }

        if (existingIndex >= 0) {
          // Update existing entry
          existingNeedAttention[existingIndex] = needAttentionItem;
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Updated needAttention for userIdentifier ${userIdentifier} to action ${action}`);
        } else {
          // Add new entry
          existingNeedAttention.push(needAttentionItem);
          updatedNeedAttention = existingNeedAttention;
          console.log(`✅ Added needAttention for userIdentifier ${userIdentifier} with action ${action}`);
        }
      }

      // Create history entry
      const historyEntry: any = {
        userIdentifier,
        option: action as 'pause' | 'release' | 'block' | 'taken',
        changedAt: new Date()
      };

      if (previousOption) {
        historyEntry.previousOption = previousOption;
      }

      // Add optional fields to history
      if (from) {
        historyEntry.from = new Date(from);
      }
      if (to) {
        historyEntry.to = new Date(to);
      }
      if (reason) {
        historyEntry.reason = reason;
      }

      // Add changedBy if sender info is available
      const sender = jwtUser.sender || {};
      if (sender.senderId || sender.id) {
        historyEntry.changedBy = {
          id: sender.senderId || sender.id || '',
          name: sender.senderDisplayName || sender.displayName || '',
          role: sender.senderRoleLabel || sender.roleLabel || 'agent',
          avatarUrl: sender.senderAvatarUrl || sender.avatarUrl || null
        };
      }

      // Add taken info to history if present
      const updatedItem = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier);
      if (updatedItem?.taken) {
        historyEntry.taken = updatedItem.taken;
      }

      // Add history entry to array
      const updatedHistory = [...existingHistory, historyEntry];

      // Update the document
      const updatedClient = await PlatformClientAgent.findOneAndUpdate(
        { clientId, isActive: true },
        { 
          $set: { 
            needAttention: updatedNeedAttention,
            needAttentionHistory: updatedHistory,
            updatedAt: new Date()
          }
        },
        { new: true, runValidators: false, strict: false }
      );

      if (!updatedClient) {
        res.status(404).json({
          success: false,
          message: `Failed to update client ${clientId}`
        });
        return;
      }

      // Publish needattention:changed event to stream
      try {
        const producer = new StreamProducer();
        await producer.connect();

        // Get the needAttention item that was updated (for taken object if action === 'taken')
        const updatedItem = action === 'release' 
          ? null 
          : updatedNeedAttention.find((item: INeedAttention) => item.userIdentifier === userIdentifier);

        const attentionData: any = {
          clientId,
          platform: existingDoc.platform || 'wpp',
          userIdentifier,
          agentCode,
          option: action === 'release' ? null : action, // null means released
          reason: updatedItem?.reason || reason || null,
          from: updatedItem?.from ? updatedItem.from.toISOString() : (from || null),
          to: updatedItem?.to ? updatedItem.to.toISOString() : (to || null),
          taken: updatedItem?.taken || null,
          hashedId // Include hashedId in event
        };

        await producer.publishNeedAttentionChanged(attentionData);
        console.log(`✅ Published needattention:changed event to stream for ${userIdentifier}`);
      } catch (streamError) {
        // Log error but don't fail API response (MongoDB update succeeded)
        console.error('❌ Error publishing needattention:changed event to stream:', streamError);
      }

      const responseMessage = action === 'release' 
        ? `User ${userIdentifier} released from needAttention successfully`
        : `Need attention status for user ${userIdentifier} updated successfully (action: ${action})`;

      const responseData: any = {
        success: true,
        message: responseMessage,
        conversationId: hashedId
      };

      // Only include needAttention in response if it's not release (since release removes it)
      if (action !== 'release') {
        responseData.needAttention = updatedNeedAttention.find(item => item.userIdentifier === userIdentifier) || null;
      }

      res.json(responseData);
    } catch (error) {
      console.error('❌ Error setting conversation need attention:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to set need attention status',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create contacts (bulk insert)
   * POST /api/v1/platform/chat/contacts
   * Body: { contacts: [{ identifier, data?, source?, memoryFacts? }], upsert?: boolean }
   * 
   * - If upsert: false (default), skips contacts that already exist (by identifier)
   * - If upsert: true, updates existing contacts instead of skipping
   * - For MemoryFact records, if upsert: true and similar fact exists (distance < 0.15), replaces it
   * - Returns success count, skipped count, failed count, updated count (if upsert), and memoryFacts stats
   */
  async createContacts(req: Request, res: Response): Promise<void> {
    try {
      const { contacts, upsert = false } = req.body;

      if (!Array.isArray(contacts) || contacts.length === 0) {
        res.status(400).json({
          success: false,
          error: 'contacts array is required and must not be empty'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      // Validate each contact
      for (const contact of contacts) {
        if (!contact.identifier || typeof contact.identifier !== 'string') {
          res.status(400).json({
            success: false,
            error: 'Each contact must have a valid identifier (string)'
          });
          return;
        }

        // Validate memoryFacts if provided
        if (contact.memoryFacts !== undefined) {
          if (!Array.isArray(contact.memoryFacts)) {
            res.status(400).json({
              success: false,
              error: 'memoryFacts must be an array'
            });
            return;
          }

          for (const fact of contact.memoryFacts) {
            if (!fact.fact || typeof fact.fact !== 'string') {
              res.status(400).json({
                success: false,
                error: 'Each memoryFact must have a valid fact (string)'
              });
              return;
            }

            if (fact.confidence !== undefined && (typeof fact.confidence !== 'number' || fact.confidence < 0 || fact.confidence > 1)) {
              res.status(400).json({
                success: false,
                error: 'memoryFact confidence must be a number between 0 and 1'
              });
              return;
            }
          }
        }
      }

      const result = await this.weaviateService.createUserContacts(contacts, agentCode, upsert);

      res.json({
        success: true,
        data: {
          inserted: result.success,
          skipped: result.skipped,
          failed: result.failed,
          updated: result.updated,
          memoryFactsCreated: result.memoryFactsCreated,
          memoryFactsFailed: result.memoryFactsFailed,
          memoryFactsReplaced: result.memoryFactsReplaced,
          ...(result.errors && result.errors.length > 0 && { errors: result.errors }),
          ...(result.memoryFactErrors && result.memoryFactErrors.length > 0 && { memoryFactErrors: result.memoryFactErrors })
        }
      });
    } catch (error: any) {
      console.error('❌ Error creating contacts:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create contacts'
      });
    }
  }

  /**
   * Update contact (single update by identifier)
   * PUT /api/v1/platform/chat/contacts
   * Body: { identifier, data?, source? }
   * 
   * - Updates only one contact per request
   * - Returns updated contact or null if not found
   */
  async updateContact(req: Request, res: Response): Promise<void> {
    try {
      const { identifier, data, source } = req.body;

      if (!identifier || typeof identifier !== 'string') {
        res.status(400).json({
          success: false,
          error: 'identifier is required and must be a string'
        });
        return;
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      const updates: any = {};
      if (data !== undefined) {
        updates.data = data;
      }
      if (source !== undefined) {
        updates.source = source;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          success: false,
          error: 'At least one field (data or source) must be provided for update'
        });
        return;
      }

      const updatedContact = await this.weaviateService.updateUserContact(identifier, updates, agentCode);

      if (!updatedContact) {
        res.status(404).json({
          success: false,
          error: 'Contact not found'
        });
        return;
      }

      res.json({
        success: true,
        data: updatedContact
      });
    } catch (error: any) {
      console.error('❌ Error updating contact:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to update contact'
      });
    }
  }

  /**
   * Delete contacts (bulk delete by identifiers)
   * DELETE /api/v1/platform/chat/contacts
   * Body: { identifiers: string[] }
   * 
   * - Supports bulk deletion
   * - Deletes UserIdentity records and associated MemoryFact records
   * - Returns counts: deleted, failed, memoryFactsDeleted
   * - Idempotent: deleting non-existent contacts is not counted as failed
   */
  async deleteContacts(req: Request, res: Response): Promise<void> {
    try {
      const { identifiers } = req.body;

      if (!Array.isArray(identifiers) || identifiers.length === 0) {
        res.status(400).json({
          success: false,
          error: 'identifiers must be a non-empty array'
        });
        return;
      }

      // Validate each identifier
      for (const identifier of identifiers) {
        if (!identifier || typeof identifier !== 'string') {
          res.status(400).json({
            success: false,
            error: 'Each identifier must be a valid string'
          });
          return;
        }
      }

      // Extract agentCode from JWT token (tenant for Weaviate) - REQUIRED
      const agentCode = (req as any).user?.agentCode;

      if (!agentCode) {
        res.status(400).json({
          success: false,
          error: 'agentCode is required in JWT token'
        });
        return;
      }

      const result = await this.weaviateService.deleteUserContacts(identifiers, agentCode);

      res.json({
        success: true,
        data: {
          deleted: result.deleted,
          failed: result.failed,
          memoryFactsDeleted: result.memoryFactsDeleted,
          ...(result.errors && result.errors.length > 0 && { errors: result.errors })
        }
      });
    } catch (error: any) {
      console.error('❌ Error deleting contacts:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to delete contacts'
      });
    }
  }
}
