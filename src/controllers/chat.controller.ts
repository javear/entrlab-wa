import { Request, Response } from 'express';
import { WeaviateService } from '../services/weaviate.service';
import { WPPConnectWhatsAppService } from '../services/whatsapp.service';
import mongoose from 'mongoose';

// Import PlatformClientAgent model (reuse from platform.controller)
interface IPlatformClientAgent extends mongoose.Document {
  clientId: string;
  platform: 'wpp' | 'wa-official';
  ai_agent_code?: string;
  privateAgentAssignment?: Array<{
    userIdentifier: string;
    agentCode: string;
  }>;
}

let PlatformClientAgent: mongoose.Model<IPlatformClientAgent>;
try {
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
} catch (error) {
  // Model will be created by platform.controller
  PlatformClientAgent = mongoose.model<IPlatformClientAgent>('PlatformClientAgent');
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
          conversationId: conv._additional?.id || conv.conversation_id, // Use Weaviate _id as conversationId
          clientId: conv.client_id,
          platform: conv.platform,
          participantIds: conv.participant_ids || [],
          createdAt: conv.created_at,
          lastEventAt: conv.last_event_at,
          lastEventType: conv.last_event_type,
          lastEventContent: conv.last_event_content ? JSON.parse(conv.last_event_content) : null,
          lastSenderType: conv.last_sender_type,
          lastSenderId: conv.last_sender_id,
          lastSenderDisplayName: conv.last_sender_display_name,
          status: conv.status
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
   * Body: { content: string, messageType?: string }
   * 
   * This will publish a message event to the stream, which will be forwarded
   * to WPP or WA Official to reply to the user
   */
  async postChatMessage(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;
      const { content, messageType = 'text' } = req.body;

      if (!conversationId) {
        res.status(400).json({
          success: false,
          error: 'conversationId is required'
        });
        return;
      }

      if (!content || typeof content !== 'string') {
        res.status(400).json({
          success: false,
          error: 'content is required and must be a string'
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

      // Get conversation by Weaviate _id to extract clientId and userIdentifier
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
        // Note: Weaviate _id (conversationId) is included in metadata for reference,
        // but consumers use clientId and userIdentifier to send messages
        const entryId = await producer.publishOutgoingMessage({
          clientId,
          platform: platform, // 'wpp' or 'wa-official'
          userIdentifier,
          agentCode: finalAgentCode, // Use finalAgentCode (may be overridden by private assignment)
          messageId,
          messageType: messageType || 'text',
          content,
          metadata: {
            source: 'api',
            postedBy: jwtUser.agentCode || 'system',
            sender: senderInfo, // Include sender information from JWT
            conversationId: conversationId, // Weaviate _id for reference/tracking
            timestamp: new Date().toISOString()
          }
        });

        console.log(`✅ Published outgoing message to stream: ${entryId} (conversationId: ${conversationId})`);

        // Return success response immediately
        // The message will be sent by the consumer (WPP/WA-Official)
        res.status(201).json({
          success: true,
          message: 'Chat message published to stream - will be sent by consumer',
          data: {
            conversationId,
            messageId,
            content,
            messageType,
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
}
