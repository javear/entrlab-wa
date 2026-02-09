import * as weaviateModule from 'weaviate-ts-client';
import axios from 'axios';
import * as crypto from 'crypto';
import { WPPConnectWhatsAppService } from './whatsapp.service';

// weaviate-ts-client exports default as an object with a client function
// Structure: weaviateModule.default.client is the function we need
const weaviateDefault = (weaviateModule as any).default || weaviateModule;
const weaviate = weaviateDefault.client || weaviateDefault;

/**
 * Weaviate Service
 * Handles queries to Weaviate for conversations and chat events
 */
export class WeaviateService {
  private client: any;
  private isInitialized: boolean = false;
  private weaviateUrl: string;
  private weaviateApiKey: string | null;
  private openAiApiKey: string | null;

  constructor(private whatsappService: WPPConnectWhatsAppService) {
    this.weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
    this.weaviateApiKey = process.env.WEAVIATE_API_KEY || null;
    this.openAiApiKey = process.env.OPENAI_API_KEY || null;
    this.initializeClient();
  }

  /**
   * Generate deterministic UUID for UserIdentity (same as external system)
   * Uses SHA256 hash of agentCode:identifier
   */
  private generateUserIdentityId(agentCode: string, identifier: string): string {
    const deterministicString = `${agentCode}:${identifier}`;
    const hash = crypto.createHash('sha256').update(deterministicString).digest('hex');
    const uuidString = [
      hash.substring(0, 8),
      hash.substring(8, 12),
      hash.substring(12, 16),
      hash.substring(16, 20),
      hash.substring(20, 32)
    ].join('-');
    return uuidString;
  }

  /**
   * Direct GraphQL query method that matches the pattern from the other system
   * Ensures tenant is passed in query, URL, and headers
   * Uses our existing WEAVIATE_URL and WEAVIATE_API_KEY
   */
  private async directGraphQLQuery(query: string, tenant: string): Promise<any> {
    // Construct full URL properly (handle both full URLs and hostname:port formats)
    let baseUrl: string;
    if (this.weaviateUrl.startsWith('http://') || this.weaviateUrl.startsWith('https://')) {
      baseUrl = this.weaviateUrl.replace(/\/$/, ''); // Remove trailing slash
    } else {
      // Handle hostname:port format
      const parts = this.weaviateUrl.split(':');
      const host = parts[0] || '';
      const portStr = parts.length > 1 ? parts[1] : undefined;
      const port = portStr ? parseInt(portStr) : 8080;
      const scheme = this.weaviateUrl.includes('railway') || 
                    this.weaviateUrl.includes('.up.') || 
                    this.weaviateUrl.includes('.app') ||
                    this.weaviateUrl.includes('heroku') ||
                    this.weaviateUrl.includes('.cloud') ? 'https' : 'http';
      baseUrl = `${scheme}://${host}${port !== 8080 && port !== 443 ? `:${port}` : ''}`;
    }
    
    const headers: any = {
      'Content-Type': 'application/json',
    };
    
    if (this.weaviateApiKey) {
      headers['Authorization'] = `Bearer ${this.weaviateApiKey}`;
    }
    
    if (this.openAiApiKey) {
      headers['X-OpenAI-Api-Key'] = this.openAiApiKey;
    }
    
    // Add tenant header (like the other system)
    headers['X-Weaviate-Tenant'] = tenant;
    
    const url = `${baseUrl}/v1/graphql?tenant=${encodeURIComponent(tenant)}`;
    
    try {
      const response = await axios.post(url, { query }, { headers });
      
      if (response.data.errors && response.data.errors.length > 0) {
        console.error(`❌ [Contacts] GraphQL errors:`, response.data.errors);
        throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
      }
      
      return response.data;
    } catch (error: any) {
      if (error.response) {
        throw new Error(`Weaviate query failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Initialize Weaviate client
   */
  private initializeClient() {
    try {
      const weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
      const weaviateApiKey = process.env.WEAVIATE_API_KEY || null;
      const openAiApiKey = process.env.OPENAI_API_KEY || null;

      let scheme = 'http';
      let host = '';
      let port = 8080;

      // Handle URL parsing
      if (weaviateUrl.startsWith('http://') || weaviateUrl.startsWith('https://')) {
        const url = new URL(weaviateUrl);
        scheme = url.protocol === 'https:' ? 'https' : 'http';
        host = url.hostname;
        port = url.port ? parseInt(url.port) : (scheme === 'https' ? 443 : 8080);
      } else {
        const parts = weaviateUrl.split(':');
        host = parts[0] || '';
        if (parts.length > 1 && parts[1]) {
          port = parseInt(parts[1]) || 8080;
        } else {
          if (weaviateUrl.includes('railway') || 
              weaviateUrl.includes('.up.') || 
              weaviateUrl.includes('.app') ||
              weaviateUrl.includes('heroku') ||
              weaviateUrl.includes('.cloud')) {
            scheme = 'https';
            port = 443;
          }
        }
      }

      const clientConfig: any = {
        scheme,
        host,
      };

      if ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) {
        clientConfig.port = port;
      }

      if (weaviateApiKey || openAiApiKey) {
        clientConfig.headers = {};
        if (weaviateApiKey) {
          clientConfig.headers['Authorization'] = `Bearer ${weaviateApiKey}`;
        }
        if (openAiApiKey) {
          clientConfig.headers['X-OpenAI-Api-Key'] = openAiApiKey;
        }
      }

      // weaviate is the client function from weaviate-ts-client
      this.client = weaviate(clientConfig);
      this.isInitialized = true;
      console.log('✅ Weaviate service initialized');
    } catch (error) {
      console.error('❌ Error initializing Weaviate service:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Get agent code for a user identifier
   * This determines the tenant for Weaviate queries
   */
  private async getAgentCodeForUser(userIdentifier: string, clientId?: string): Promise<string | null> {
    try {
      if (!clientId) {
        return null;
      }

      // Get client info to find agent assignment
      const clientInfo = this.whatsappService.getClient(clientId);
      if (!clientInfo) {
        return null;
      }

      // Check for private agent assignment first
      // This would require querying PlatformClientAgent from MongoDB
      // For now, use the client's ai_agent_code
      // TODO: Query MongoDB for privateAgentAssignment
      return clientInfo.ai_agent_code || null;
    } catch (error) {
      console.error('❌ Error getting agent code for user:', error);
      return null;
    }
  }

  /**
   * Get conversations for a user
   * @param userIdentifier - User identifier (phone number)
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of conversations sorted by last_event_at (newest first)
   */
  async getUserConversations(
    userIdentifier: string,
    limit: number = 20,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    conversations: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      const conversations: any[] = [];
      
      // Query only the specified tenant (agentCode from JWT)
      // participant_ids should be filterable after schema migration
      try {
        const result = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at last_event_type last_event_content last_sender_type last_sender_id last_sender_display_name status last_attention last_read_at last_broadcast_id last_broadcast_at last_broadcast_content is_broadcasted _additional { id }')
          .withWhere({
            path: ['participant_ids'],
            operator: 'ContainsAny',
            valueStringArray: [userIdentifier]
          })
          .withLimit(limit + offset) // Get more to handle offset
          .withSort([{
            path: ['last_event_at'],
            order: 'desc'
          }])
          .do();
        
        if (result.data?.Get?.Conversation) {
          conversations.push(...result.data.Get.Conversation);
        }
      } catch (error: any) {
        // Check if the error is about the schema not existing
        if (error.message?.includes('Cannot query field') || 
            error.message?.includes('GetObjectsObj') ||
            error.response?.errors?.some((e: any) => e.message?.includes('Cannot query field'))) {
          console.warn(`⚠️ Conversation schema does not exist yet. It will be created automatically when the weaviate-consumer service processes messages.`);
          // Return empty result - schema will be created when messages are processed
          return {
            conversations: [],
            total: 0,
            hasMore: false
          };
        }
        // If the error is about participant_ids not being filterable, provide helpful message
        if (error.message?.includes('participant_ids') && error.message?.includes('inverted index')) {
          console.error('❌ participant_ids is not filterable. Please run the migration script:');
          console.error('   node scripts/migrate-participant-ids-index.js --force');
          throw new Error('participant_ids property is not filterable. Please run migration script to fix the schema.');
        }
        console.warn(`⚠️ Error querying tenant ${agentCode}:`, error);
        // Return empty result if tenant doesn't exist
      }
      
      // Sort by last_event_at (newest first) and apply pagination
      conversations.sort((a, b) => {
        const dateA = new Date(a.last_event_at || a.created_at || 0).getTime();
        const dateB = new Date(b.last_event_at || b.created_at || 0).getTime();
        return dateB - dateA;
      });
      
      const total = conversations.length;
      const paginatedConversations = conversations.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        conversations: paginatedConversations,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting user conversations:', error);
      throw error;
    }
  }

  /**
   * Get all conversations for an agentCode (tenant)
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of all conversations for the tenant, sorted by last_event_at (newest first)
   */
  async getAllConversations(
    limit: number = 20,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    conversations: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      const conversations: any[] = [];
      
      // Query all conversations for the specified tenant (agentCode from JWT)
      // No userIdentifier filter - get all conversations for this tenant
      try {
        const result = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at last_event_type last_event_content last_sender_type last_sender_id last_sender_display_name status last_attention last_read_at last_broadcast_id last_broadcast_at last_broadcast_content is_broadcasted _additional { id }')
          .withLimit(limit + offset) // Get more to handle offset
          .withSort([{
            path: ['last_event_at'],
            order: 'desc'
          }])
          .do();
        
        if (result.data?.Get?.Conversation) {
          conversations.push(...result.data.Get.Conversation);
        }
      } catch (error: any) {
        // Check if the error is about the schema not existing
        if (error.message?.includes('Cannot query field') || 
            error.message?.includes('GetObjectsObj') ||
            error.response?.errors?.some((e: any) => e.message?.includes('Cannot query field'))) {
          console.warn(`⚠️ Conversation schema does not exist yet. It will be created automatically when the weaviate-consumer service processes messages.`);
          // Return empty result - schema will be created when messages are processed
          return {
            conversations: [],
            total: 0,
            hasMore: false
          };
        }
        
        // Check if the error is about tenant not found
        const errorMessage = error.message || '';
        const errorResponse = error.response?.data?.errors || [];
        const hasTenantNotFound = errorMessage.includes('tenant not found') ||
          errorResponse.some((e: any) => e.message?.includes('tenant not found'));
        
        if (hasTenantNotFound) {
          console.warn(`⚠️ Tenant "${agentCode}" not found in Weaviate. Returning empty result.`);
          // Return empty result - tenant doesn't exist yet
          return {
            conversations: [],
            total: 0,
            hasMore: false
          };
        }
        
        console.warn(`⚠️ Error querying tenant ${agentCode}:`, error);
        // Re-throw other errors to be handled by outer catch
        throw error;
      }
      
      // Sort by last_event_at (newest first) and apply pagination
      conversations.sort((a, b) => {
        const dateA = new Date(a.last_event_at || a.created_at || 0).getTime();
        const dateB = new Date(b.last_event_at || b.created_at || 0).getTime();
        return dateB - dateA;
      });
      
      const total = conversations.length;
      const paginatedConversations = conversations.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        conversations: paginatedConversations,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting all conversations:', error);
      throw error;
    }
  }

  /**
   * Get conversation by hashed_id (universal ID across services) with fallback to Weaviate _id
   * @param conversationId - Hashed room ID (agentCode:clientId:userIdentifier) or Weaviate _id (UUID)
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Conversation object with clientId and userIdentifier
   */
  async getConversationById(
    conversationId: string,
    agentCode: string
  ): Promise<{
    conversation_id: string;
    hashed_id: string;
    client_id: string;
    participant_ids: string[];
    [key: string]: any;
  } | null> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      // First, try to find by hashed_id (universal ID across services)
      try {
        const hashedIdResult = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at status last_attention _additional { id }')
          .withWhere({
            path: ['hashed_id'],
            operator: 'Equal',
            valueString: conversationId
          })
          .withLimit(1)
          .do();
        
        if (hashedIdResult.data?.Get?.Conversation && hashedIdResult.data.Get.Conversation.length > 0) {
          const conversation = hashedIdResult.data.Get.Conversation[0];
          
          return {
            conversation_id: conversation.conversation_id,
            hashed_id: conversation.hashed_id,
            client_id: conversation.client_id,
            participant_ids: conversation.participant_ids || [],
            platform: conversation.platform,
            created_at: conversation.created_at,
            last_event_at: conversation.last_event_at,
            status: conversation.status
          };
        }
      } catch (hashedIdError: any) {
        // Check if the error is about tenant not found
        const errorMessage = hashedIdError.message || '';
        const errorResponse = hashedIdError.response?.data?.errors || [];
        const hasTenantNotFound = errorMessage.includes('tenant not found') ||
          errorResponse.some((e: any) => e.message?.includes('tenant not found'));
        
        if (hasTenantNotFound) {
          console.warn(`⚠️ Tenant "${agentCode}" not found in Weaviate. Returning null.`);
          return null;
        }
        
        console.warn('⚠️ GraphQL query by hashed_id failed:', hashedIdError);
      }

      // Fallback: If not found by hashed_id, try Weaviate _id (UUID format)
      // Check if conversationId looks like a UUID (Weaviate _id format)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(conversationId)) {
        try {
          // Query all conversations and find by _id
          const allResult = await this.client.graphql
            .get()
            .withClassName('Conversation')
            .withTenant(agentCode)
            .withFields('conversation_id hashed_id client_id platform participant_ids created_at last_event_at status last_attention _additional { id }')
            .withLimit(1000) // Get a reasonable number to search through
            .do();
          
          if (allResult.data?.Get?.Conversation) {
            // Find the conversation with matching _id
            const conversation = allResult.data.Get.Conversation.find(
              (conv: any) => conv._additional?.id === conversationId
            );
            
            if (conversation) {
              return {
                conversation_id: conversation.conversation_id,
                hashed_id: conversation.hashed_id,
                client_id: conversation.client_id,
                participant_ids: conversation.participant_ids || [],
                platform: conversation.platform,
                created_at: conversation.created_at,
                last_event_at: conversation.last_event_at,
                status: conversation.status
              };
            }
          }
        } catch (uuidError) {
          console.warn('⚠️ GraphQL query by _id failed:', uuidError);
        }
      }
      
      // If not found by either method, return null
      return null;
    } catch (error) {
      console.error('❌ Error getting conversation by id:', error);
      throw error;
    }
  }

  /**
   * Update last broadcast fields on a conversation (optional, when broadcastId present in send APIs)
   * @param agentCode - Tenant (agent code)
   * @param conversationId - conversation_id format (clientId:userIdentifier) or hashed_id
   * @param broadcastId - UUID of the broadcast
   * @param content - Message content as array of objects [{ type, text, ... }]
   */
  async updateConversationLastBroadcast(
    agentCode: string,
    conversationId: string,
    broadcastId: string,
    content: Array<{ type: string; text?: string; [key: string]: any }>
  ): Promise<void> {
    if (!this.isInitialized || !this.client) return;
    if (!agentCode || !broadcastId || !content?.length) return;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(broadcastId)) return;

    try {
      let convUuid: string | null = null;
      const isUuid = uuidRegex.test(conversationId);

      if (isUuid) {
        convUuid = conversationId;
      } else {
        const result = await this.client.graphql
          .get()
          .withClassName('Conversation')
          .withTenant(agentCode)
          .withFields('_additional { id }')
          .withWhere({
            path: ['hashed_id'],
            operator: 'Equal',
            valueString: conversationId
          })
          .withLimit(1)
          .do();
        convUuid = result?.data?.Get?.Conversation?.[0]?._additional?.id ?? null;
        if (!convUuid && conversationId.includes(':')) {
          const convIdResult = await this.client.graphql
            .get()
            .withClassName('Conversation')
            .withTenant(agentCode)
            .withFields('_additional { id }')
            .withWhere({
              path: ['conversation_id'],
              operator: 'Equal',
              valueString: conversationId
            })
            .withLimit(1)
            .do();
          convUuid = convIdResult?.data?.Get?.Conversation?.[0]?._additional?.id ?? null;
        }
      }
      if (!convUuid) return;

      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      const broadcastAt = new Date().toISOString();

      await this.client.data
        .merger()
        .withId(convUuid)
        .withClassName('Conversation')
        .withTenant(agentCode)
        .withProperties({
          last_broadcast_id: broadcastId,
          last_broadcast_at: broadcastAt,
          last_broadcast_content: contentStr,
          is_broadcasted: true
        })
        .do();
    } catch (error) {
      console.warn('⚠️ Failed to update conversation lastBroadcast:', error);
    }
  }

  /**
   * Get chat events for a conversation
   * @param conversationId - Hashed room ID (universal ID) or Weaviate _id (UUID) - will try hashed_id first, then fallback to _id
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of chat events sorted by sequence (newest first)
   */
  async getConversationChats(
    conversationId: string,
    limit: number = 50,
    offset: number = 0,
    agentCode: string // Required - no fallback
  ): Promise<{
    chats: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      // First, get the conversation to find the conversation_id
      // This will try hashed_id first, then fallback to Weaviate _id if not found
      const conversation = await this.getConversationById(conversationId, agentCode);
      
      if (!conversation) {
        return {
          chats: [],
          total: 0,
          hasMore: false
        };
      }

      // Use agentCode from JWT as tenant (required)
      const tenant = agentCode;
      
      // Query chat events using conversation_id from the conversation record
      const result = await this.client.graphql
        .get()
        .withClassName('ChatEvent')
        .withTenant(tenant)
        .withFields('conversation_id event_id event_type sender_type sender_id sender_display_name sender_avatar_url content sequence created_at visibility')
        .withWhere({
          path: ['conversation_id'],
          operator: 'Equal',
          valueString: conversation.conversation_id
        })
        .withLimit(limit + offset) // Get more to handle offset
        .withSort([{
          path: ['sequence'],
          order: 'desc' // Newest first
        }])
        .do();
      
      if (!result.data?.Get?.ChatEvent) {
        return {
          chats: [],
          total: 0,
          hasMore: false
        };
      }
      
      const allChats = result.data.Get.ChatEvent;
      const total = allChats.length;
      const paginatedChats = allChats.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        chats: paginatedChats,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting conversation chats:', error);
      throw error;
    }
  }

  /**
   * Get contacts (UserIdentity) for an agentCode (tenant)
   * When search query is provided, performs semantic search on MemoryFact and joins with UserIdentity
   * @param limit - Number of results to return
   * @param offset - Offset for pagination
   * @param searchQuery - Optional search query to filter by identifier, data fields, or semantic facts
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Array of contacts with parsed data field and matching facts
   */
  async getUserContacts(
    limit: number = 20,
    offset: number = 0,
    searchQuery: string | null = null,
    agentCode: string // Required - no fallback
  ): Promise<{
    contacts: any[];
    total: number;
    hasMore: boolean;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    try {
      let contacts: any[] = [];
      const userIdentifierSet = new Set<string>();
      const factsByUserIdentifier = new Map<string, any[]>();

      // If search query is provided, first search MemoryFact semantically
      if (searchQuery && searchQuery.trim() !== '') {
        const searchTerm = searchQuery.trim();
        console.log(`🔍 [Contacts Search] Starting search for query: "${searchTerm}" (agentCode: ${agentCode})`);
        
        // First, check if MemoryFact class exists and has data
        try {
          console.log(`🔍 [Contacts Search] Checking if MemoryFact class exists...`);
          const checkResult = await this.client.graphql
            .get()
            .withClassName('MemoryFact')
            .withTenant(agentCode)
            .withFields('_additional { id }')
            .withLimit(1)
            .do();
          
          const hasData = checkResult.data?.Get?.MemoryFact && checkResult.data.Get.MemoryFact.length > 0;
          console.log(`📊 [Contacts Search] MemoryFact class check: ${hasData ? 'Has data' : 'No data or class does not exist'}`);
        } catch (checkError: any) {
          console.warn(`⚠️ [Contacts Search] Cannot check MemoryFact class:`, checkError.message);
        }
        
        try {
          // Try hybrid search first (works better for vectorized classes)
          // Use higher alpha (0.7) for tighter semantic search - favors vector search over BM25
          // Minimum score threshold: 0.35 (stricter - filters out weak matches - higher = more relevant)
          const MIN_SCORE_THRESHOLD = 0.35;
          console.log(`🔍 [Contacts Search] Attempting hybrid search on MemoryFact (alpha: 0.7, min score: ${MIN_SCORE_THRESHOLD})...`);
          const memoryFactResult = await this.client.graphql
            .get()
            .withClassName('MemoryFact')
            .withTenant(agentCode)
            .withFields('user_identifier category fact confidence source created_at last_used _additional { id distance score }')
            .withHybrid({
              query: searchTerm,
              properties: ['fact'], // Search in the fact field which is vectorized
              alpha: 0.7, // Tighter: 70% vector search, 30% BM25 (more semantic, less keyword matching)
              vector: undefined // Let Weaviate generate the query vector
            })
            .withLimit(100) // Get enough facts to find all related users
            .do();

          console.log(`✅ [Contacts Search] MemoryFact query completed. Response:`, {
            hasData: !!memoryFactResult.data?.Get?.MemoryFact,
            count: memoryFactResult.data?.Get?.MemoryFact?.length || 0,
            errors: memoryFactResult.errors
          });

          if (memoryFactResult.data?.Get?.MemoryFact) {
            const facts = memoryFactResult.data.Get.MemoryFact;
            console.log(`📊 [Contacts Search] Found ${facts.length} matching facts (before relevance filter)`);
            
            // Group facts by user_identifier and collect user identifiers
            // First pass: collect all facts by user, filtering by minimum score
            const tempFactsByUser = new Map<string, any[]>();
            let filteredCount = 0;
            for (const fact of facts) {
              const userIdentifier = fact.user_identifier;
              const score = fact._additional?.score ? parseFloat(fact._additional.score) : 0;
              
              // Filter out facts below relevance threshold
              if (score < MIN_SCORE_THRESHOLD) {
                filteredCount++;
                continue;
              }
              
              if (userIdentifier) {
                userIdentifierSet.add(userIdentifier);
                
                if (!tempFactsByUser.has(userIdentifier)) {
                  tempFactsByUser.set(userIdentifier, []);
                }
                tempFactsByUser.get(userIdentifier)!.push({
                  category: fact.category,
                  fact: fact.fact,
                  confidence: fact.confidence,
                  source: fact.source,
                  created_at: fact.created_at,
                  last_used: fact.last_used,
                  distance: fact._additional?.distance,
                  score: score,
                  _id: fact._additional?.id
                });
              }
            }
            
            console.log(`📊 [Contacts Search] Filtered out ${filteredCount} facts below score threshold ${MIN_SCORE_THRESHOLD}`);
            console.log(`📊 [Contacts Search] ${tempFactsByUser.size} users have relevant facts (after filter)`);
            
            // Second pass: sort by score (higher is better) and take top 3 per user
            for (const [userIdentifier, userFacts] of tempFactsByUser.entries()) {
              // Sort by score descending (higher score = more relevant)
              const sortedFacts = userFacts.sort((a, b) => {
                // Higher score is better
                if (b.score !== a.score) {
                  return b.score - a.score;
                }
                // If scores are equal, prefer higher confidence
                return (b.confidence || 0) - (a.confidence || 0);
              });
              
              // Store only top 3 facts per user
              factsByUserIdentifier.set(userIdentifier, sortedFacts.slice(0, 3));
            }
            console.log(`👥 [Contacts Search] Found ${userIdentifierSet.size} unique user identifiers from MemoryFact (with relevance filter)`);
          } else {
            console.log(`⚠️ [Contacts Search] No MemoryFact data returned (schema may not exist or no facts found)`);
          }
        } catch (memoryFactError: any) {
          // MemoryFact schema might not exist yet, try withNearText as fallback
          console.warn(`⚠️ [Contacts Search] Hybrid search failed, trying withNearText fallback:`, memoryFactError.message);
          
          try {
            // Use higher certainty (0.6) for tighter semantic search - requires better semantic match
            // Maximum distance threshold: 0.25 (stricter - filters out weak semantic matches)
            const MAX_DISTANCE_THRESHOLD = 0.25;
            console.log(`🔍 [Contacts Search] Attempting withNearText search on MemoryFact (certainty: 0.6, max distance: ${MAX_DISTANCE_THRESHOLD})...`);
            const nearTextResult = await this.client.graphql
              .get()
              .withClassName('MemoryFact')
              .withTenant(agentCode)
              .withFields('user_identifier category fact confidence source created_at last_used _additional { id distance }')
              .withNearText({
                concepts: [searchTerm],
                certainty: 0.6 // Stricter: requires better semantic match (0.6 = more strict than 0.5)
                // Note: certainty ranges from 0.0 to 1.0, higher = more strict/relevant
              })
              .withLimit(100)
              .do();

            if (nearTextResult.data?.Get?.MemoryFact) {
              const facts = nearTextResult.data.Get.MemoryFact;
              console.log(`📊 [Contacts Search] Found ${facts.length} matching facts via withNearText (before distance filter)`);
              
              // First pass: collect all facts by user, filtering by maximum distance
              const tempFactsByUser = new Map<string, any[]>();
              let filteredCount = 0;
              for (const fact of facts) {
                const userIdentifier = fact.user_identifier;
                const distance = fact._additional?.distance !== null && fact._additional?.distance !== undefined 
                  ? parseFloat(fact._additional.distance) 
                  : Infinity;
                
                // Filter out facts above distance threshold (lower distance = more similar)
                if (distance > MAX_DISTANCE_THRESHOLD) {
                  filteredCount++;
                  continue;
                }
                
                if (userIdentifier) {
                  userIdentifierSet.add(userIdentifier);
                  
                  if (!tempFactsByUser.has(userIdentifier)) {
                    tempFactsByUser.set(userIdentifier, []);
                  }
                  tempFactsByUser.get(userIdentifier)!.push({
                    category: fact.category,
                    fact: fact.fact,
                    confidence: fact.confidence,
                    source: fact.source,
                    created_at: fact.created_at,
                    last_used: fact.last_used,
                    distance: distance,
                    _id: fact._additional?.id
                  });
                }
              }
              
              console.log(`📊 [Contacts Search] Filtered out ${filteredCount} facts above distance threshold ${MAX_DISTANCE_THRESHOLD}`);
              console.log(`📊 [Contacts Search] ${tempFactsByUser.size} users have relevant facts (after filter)`);
              
              // Second pass: sort by distance (lower is better for semantic similarity) and take top 3 per user
              for (const [userIdentifier, userFacts] of tempFactsByUser.entries()) {
                // Sort by distance ascending (lower distance = more similar = better)
                const sortedFacts = userFacts.sort((a, b) => {
                  const distanceA = a.distance !== null && a.distance !== undefined ? parseFloat(a.distance) : Infinity;
                  const distanceB = b.distance !== null && b.distance !== undefined ? parseFloat(b.distance) : Infinity;
                  // Lower distance is better
                  if (distanceA !== distanceB) {
                    return distanceA - distanceB;
                  }
                  // If distances are equal, prefer higher confidence
                  return (b.confidence || 0) - (a.confidence || 0);
                });
                
                // Store only top 3 facts per user
                factsByUserIdentifier.set(userIdentifier, sortedFacts.slice(0, 3));
              }
              console.log(`👥 [Contacts Search] Found ${userIdentifierSet.size} unique user identifiers from MemoryFact (withNearText, with distance filter)`);
            }
          } catch (nearTextError: any) {
            console.warn(`⚠️ [Contacts Search] withNearText also failed. MemoryFact schema may not exist:`, nearTextError.message);
            console.warn(`⚠️ [Contacts Search] Full error:`, {
              message: nearTextError.message,
              response: nearTextError.response?.data,
              errors: nearTextError.response?.errors
            });
          }
        }

        // Also search UserIdentity directly with BM25 for identifier/data matches (OR with MemoryFact)
        // This combines results: contacts match if they have relevant facts OR matching identity attributes
        // Minimum BM25 score threshold: 0.3 (stricter keyword matching)
        const MIN_BM25_SCORE_THRESHOLD = 0.3;
        try {
          console.log(`🔍 [Contacts Search] Searching UserIdentity directly by identifier/data (OR with MemoryFact, min score: ${MIN_BM25_SCORE_THRESHOLD})...`);
          const userIdentityQuery = this.client.graphql
            .get()
            .withClassName('UserIdentity')
            .withTenant(agentCode)
            .withFields('identifier data source last_updated _additional { id score }')
            .withBm25({
              query: searchTerm,
              properties: ['identifier', 'data'] // Only search in identifier and data fields
            })
            .withLimit(50); // Limit to avoid too many irrelevant results

          const userIdentityResult = await userIdentityQuery.do();
          
          console.log(`✅ [Contacts Search] UserIdentity direct search completed. Found:`, {
            count: userIdentityResult.data?.Get?.UserIdentity?.length || 0
          });
          
          if (userIdentityResult.data?.Get?.UserIdentity) {
            // Add identifiers from direct UserIdentity search (OR with MemoryFact results)
            // Filter by minimum BM25 score threshold
            const beforeCount = userIdentifierSet.size;
            let filteredCount = 0;
            for (const contact of userIdentityResult.data.Get.UserIdentity) {
              const score = contact._additional?.score ? parseFloat(contact._additional.score) : 0;
              
              // Filter out contacts below BM25 score threshold
              if (score < MIN_BM25_SCORE_THRESHOLD) {
                filteredCount++;
                continue;
              }
              
              if (contact.identifier) {
                userIdentifierSet.add(contact.identifier);
              }
            }
            console.log(`📊 [Contacts Search] Filtered out ${filteredCount} UserIdentity contacts below BM25 score threshold ${MIN_BM25_SCORE_THRESHOLD}`);
            console.log(`👥 [Contacts Search] Added ${userIdentifierSet.size - beforeCount} new identifiers from UserIdentity direct search (OR combination)`);
            console.log(`👥 [Contacts Search] Total unique identifiers (MemoryFact OR UserIdentity): ${userIdentifierSet.size}`);
          }
        } catch (userIdentityError: any) {
          console.warn(`⚠️ [Contacts Search] Error querying UserIdentity for direct search:`, userIdentityError.message);
        }

        // Now fetch UserIdentity records for all found user identifiers
        console.log(`📋 [Contacts Search] Total unique user identifiers found: ${userIdentifierSet.size}`);
        if (userIdentifierSet.size > 0) {
          try {
            const userIdentifiersArray = Array.from(userIdentifierSet);
            console.log(`🔍 [Contacts Search] Fetching UserIdentity records for ${userIdentifiersArray.length} identifiers...`);
            const userIdentityResult = await this.client.graphql
              .get()
              .withClassName('UserIdentity')
              .withTenant(agentCode)
              .withFields('identifier data source last_updated _additional { id }')
              .withWhere({
                path: ['identifier'],
                operator: 'ContainsAny',
                valueStringArray: userIdentifiersArray
              })
              .withLimit(userIdentifiersArray.length)
              .do();

            if (userIdentityResult.data?.Get?.UserIdentity) {
              contacts = userIdentityResult.data.Get.UserIdentity;
              console.log(`✅ [Contacts Search] Fetched ${contacts.length} UserIdentity records`);
            } else {
              console.log(`⚠️ [Contacts Search] No UserIdentity records returned for identifiers`);
            }
          } catch (error: any) {
            const errMsg = error.message || '';
            const errResp = error.response?.data?.errors || [];
            const tenantNotFound = errMsg.includes('tenant not found') ||
              errResp.some((e: any) => e.message?.includes('tenant not found'));
            if (tenantNotFound) {
              console.warn(`⚠️ Tenant "${agentCode}" not found in Weaviate. Returning empty contacts.`);
              return { contacts: [], total: 0, hasMore: false };
            }
            console.warn(`⚠️ [Contacts Search] Error fetching UserIdentity records:`, error.message);
            console.warn(`⚠️ [Contacts Search] Full error:`, {
              message: error.message,
              response: error.response?.data,
              errors: error.response?.errors
            });
          }
        } else {
          console.log(`⚠️ [Contacts Search] No user identifiers found, returning empty results`);
        }
      } else {
        // No search query - just get all UserIdentity records
        console.log(`🔍 [Contacts] Fetching all UserIdentity records (no search query)...`);
        try {
          const result = await this.client.graphql
            .get()
            .withClassName('UserIdentity')
            .withTenant(agentCode)
            .withFields('identifier data source last_updated _additional { id }')
            .withSort([{
              path: ['last_updated'],
              order: 'desc'
            }])
            .withLimit(limit + offset)
            .do();
          
          if (result.data?.Get?.UserIdentity) {
            contacts = result.data.Get.UserIdentity;
            console.log(`✅ [Contacts] Fetched ${contacts.length} UserIdentity records`);
            
            // Efficient single query: Fetch all MemoryFact records for all contacts in one batch query
            const allUserIdentifiers = contacts.map(c => c.identifier).filter(Boolean);
            
            if (allUserIdentifiers.length > 0) {
              try {
                // Build where clause using Or operator with multiple Equal conditions (efficient batch query)
                let whereClause = '';
                if (allUserIdentifiers.length === 1) {
                  // Single identifier - use simple Equal
                  whereClause = `where: {
            path: ["user_identifier"]
            operator: Equal
            valueString: "${allUserIdentifiers[0].replace(/"/g, '\\"')}"
          }`;
                } else {
                  // Multiple identifiers - use Or with Equal conditions (single query for all)
                  const equalConditions = allUserIdentifiers.map(id => `{
              path: ["user_identifier"]
              operator: Equal
              valueString: "${id.replace(/"/g, '\\"')}"
            }`).join(',\n            ');
                  
                  whereClause = `where: {
            operator: Or
            operands: [
              ${equalConditions}
            ]
          }`;
                }
                
                // Single efficient GraphQL query - gets all facts for all users at once
                const graphqlQuery = `
    {
      Get {
        MemoryFact(
          tenant: "${agentCode.replace(/"/g, '\\"')}"
          ${whereClause}
          limit: 1000
        ) {
          user_identifier
          category
          fact
          confidence
          source
          created_at
          last_used
          _additional {
            id
          }
        }
      }
    }
  `;
                
                const result = await this.directGraphQLQuery(graphqlQuery, agentCode);
                const factsResult = { data: result.data };
                
                if (factsResult.data?.Get?.MemoryFact) {
                  const allFacts = factsResult.data.Get.MemoryFact;
                  
                  // Group facts by user_identifier
                  for (const fact of allFacts) {
                    const userIdentifier = fact.user_identifier;
                    if (userIdentifier) {
                      if (!factsByUserIdentifier.has(userIdentifier)) {
                        factsByUserIdentifier.set(userIdentifier, []);
                      }
                      factsByUserIdentifier.get(userIdentifier)!.push({
                        category: fact.category,
                        fact: fact.fact,
                        confidence: fact.confidence,
                        source: fact.source,
                        created_at: fact.created_at,
                        last_used: fact.last_used,
                        _id: fact._additional?.id
                      });
                    }
                  }
                  
                  // Sort and get top 3 for each user (by last_used then confidence)
                  for (const [userIdentifier, userFacts] of factsByUserIdentifier.entries()) {
                    const sortedFacts = userFacts.sort((a, b) => {
                      const dateA = new Date(a.last_used || a.created_at || 0).getTime();
                      const dateB = new Date(b.last_used || b.created_at || 0).getTime();
                      if (dateB !== dateA) {
                        return dateB - dateA; // Most recent first
                      }
                      return (b.confidence || 0) - (a.confidence || 0); // Higher confidence first
                    });
                    
                    factsByUserIdentifier.set(userIdentifier, sortedFacts.slice(0, 3));
                  }
                }
              } catch (factsError: any) {
                // MemoryFact might not exist or query failed - that's okay, continue without facts
                console.warn(`⚠️ [Contacts] Could not fetch MemoryFact records:`, factsError.message);
              }
            }
          }
        } catch (error: any) {
          // Check if the error is about the schema not existing
          if (error.message?.includes('Cannot query field') || 
              error.message?.includes('GetObjectsObj') ||
              error.response?.errors?.some((e: any) => e.message?.includes('Cannot query field'))) {
            console.warn(`⚠️ UserIdentity schema does not exist yet. It will be created automatically when memory is stored.`);
            return {
              contacts: [],
              total: 0,
              hasMore: false
            };
          }
          // Check if the error is about tenant not found
          const errMsg = error.message || '';
          const errResp = error.response?.data?.errors || [];
          const tenantNotFound = errMsg.includes('tenant not found') ||
            errResp.some((e: any) => e.message?.includes('tenant not found'));
          if (tenantNotFound) {
            console.warn(`⚠️ Tenant "${agentCode}" not found in Weaviate. Returning empty contacts.`);
            return {
              contacts: [],
              total: 0,
              hasMore: false
            };
          }
          console.warn(`⚠️ Error querying UserIdentity for tenant ${agentCode}:`, error);
        }
      }
      
      // Parse data field and attach matching facts
      const hasSearchQuery = searchQuery && searchQuery.trim() !== '';
      const parsedContacts = contacts.map(contact => {
        let parsedData = {};
        try {
          if (contact.data && typeof contact.data === 'string') {
            parsedData = JSON.parse(contact.data);
          } else if (contact.data && typeof contact.data === 'object') {
            parsedData = contact.data;
          }
        } catch (parseError) {
          console.warn(`⚠️ Failed to parse data field for contact ${contact.identifier}:`, parseError);
          parsedData = {};
        }

        // Attach facts if available (from semantic search or top 3 facts)
        const userFacts = factsByUserIdentifier.get(contact.identifier) || [];

        return {
          identifier: contact.identifier,
          data: parsedData,
          source: contact.source,
          last_updated: contact.last_updated,
          _id: contact._additional?.id,
          // Include facts: matchingFacts when searching, topFacts when not searching
          ...(hasSearchQuery && userFacts.length > 0 
            ? { matchingFacts: userFacts }
            : !hasSearchQuery && userFacts.length > 0
            ? { topFacts: userFacts }
            : {})
        };
      });

      // Log final summary
      if (hasSearchQuery) {
        const contactsWithFacts = parsedContacts.filter(c => {
          return 'matchingFacts' in c && Array.isArray((c as any).matchingFacts) && (c as any).matchingFacts.length > 0;
        }).length;
        console.log(`📊 [Contacts Search] Final summary: ${parsedContacts.length} contacts, ${contactsWithFacts} with matching facts`);
      } else {
        const contactsWithFacts = parsedContacts.filter(c => {
          return 'topFacts' in c && Array.isArray((c as any).topFacts) && (c as any).topFacts.length > 0;
        }).length;
        console.log(`📊 [Contacts] Final summary: ${parsedContacts.length} contacts, ${contactsWithFacts} with top facts`);
      }
      
      // Sort by last_updated (newest first) and apply pagination
      parsedContacts.sort((a, b) => {
        const dateA = new Date(a.last_updated || 0).getTime();
        const dateB = new Date(b.last_updated || 0).getTime();
        return dateB - dateA;
      });
      
      const total = parsedContacts.length;
      const paginatedContacts = parsedContacts.slice(offset, offset + limit);
      const hasMore = offset + limit < total;
      
      return {
        contacts: paginatedContacts,
        total,
        hasMore
      };
    } catch (error) {
      console.error('❌ Error getting user contacts:', error);
      throw error;
    }
  }

  /**
   * Generate UUID v4 for MemoryFact (non-deterministic, each fact gets unique ID)
   */
  private generateMemoryFactId(): string {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for older Node.js versions
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Create UserIdentity contacts (bulk insert)
   * If upsert: false, skips contacts that already exist (by identifier)
   * If upsert: true, updates existing contacts instead of skipping
   * Also creates MemoryFact records if provided
   * For MemoryFact records, if upsert: true and similar fact exists (distance < 0.15), replaces it
   * @param contacts - Array of contact objects with identifier, data, source, and optional memoryFacts
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @param upsert - If true, update existing contacts instead of skipping. Default: false
   * @returns Object with success count, skipped count, failed count, updated count (if upsert), and memoryFacts stats
   */
  async createUserContacts(
    contacts: Array<{
      identifier: string;
      data?: any;
      source?: string;
      memoryFacts?: Array<{
        category?: string;
        fact: string;
        confidence?: number;
        source?: string;
      }>;
    }>,
    agentCode: string,
    upsert: boolean = false
  ): Promise<{
    success: number;
    skipped: number;
    failed: number;
    updated?: number;
    memoryFactsCreated: number;
    memoryFactsFailed: number;
    memoryFactsReplaced?: number;
    errors?: Array<{ identifier: string; error: string }>;
    memoryFactErrors?: Array<{ identifier: string; fact: string; error: string }>;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    let success = 0;
    let skipped = 0;
    let failed = 0;
    let updated = 0;
    let memoryFactsCreated = 0;
    let memoryFactsFailed = 0;
    let memoryFactsReplaced = 0;
    const errors: Array<{ identifier: string; error: string }> = [];
    const memoryFactErrors: Array<{ identifier: string; fact: string; error: string }> = [];

    // Check which identifiers already exist
    const identifiers = contacts.map(c => c.identifier).filter(Boolean);
    const existingIdentifiers = new Set<string>();

    if (identifiers.length > 0) {
      try {
        // Query existing UserIdentity records by identifier
        const whereConditions = identifiers.map(id => `{
          path: ["identifier"]
          operator: Equal
          valueString: "${id.replace(/"/g, '\\"')}"
        }`).join(',\n            ');

        const checkQuery = `
    {
      Get {
        UserIdentity(
          tenant: "${agentCode.replace(/"/g, '\\"')}"
          where: {
            operator: Or
            operands: [
              ${whereConditions}
            ]
          }
        ) {
          identifier
        }
      }
    }
  `;

        const checkResult = await this.directGraphQLQuery(checkQuery, agentCode);
        if (checkResult.data?.Get?.UserIdentity) {
          for (const existing of checkResult.data.Get.UserIdentity) {
            if (existing.identifier) {
              existingIdentifiers.add(existing.identifier);
            }
          }
        }
      } catch (checkError: any) {
        console.warn(`⚠️ [Contacts Create] Could not check existing contacts:`, checkError.message);
      }
    }

    // Create contacts that don't exist (using Weaviate client builder pattern)

    for (const contact of contacts) {
      if (!contact.identifier) {
        failed++;
        errors.push({ identifier: contact.identifier || 'unknown', error: 'identifier is required' });
        continue;
      }

      // Handle existing contacts based on upsert flag
      const isExisting = existingIdentifiers.has(contact.identifier);
      if (isExisting) {
        if (upsert) {
          // Update existing contact
          try {
            const dataString = typeof contact.data === 'string' 
              ? contact.data 
              : JSON.stringify(contact.data || {});
            
            const id = this.generateUserIdentityId(agentCode, contact.identifier);
            
            // Get existing contact to merge updates
            const existingContact = await this.client.data
              .getterById()
              .withId(id)
              .withClassName('UserIdentity')
              .withTenant(agentCode)
              .do();

            if (existingContact) {
              const updateProperties: any = {
                identifier: contact.identifier,
                data: dataString,
                source: contact.source !== undefined ? contact.source : (existingContact.properties?.source || 'api'),
                last_updated: new Date().toISOString()
              };

              await this.client.data
                .merger()
                .withId(id)
                .withClassName('UserIdentity')
                .withTenant(agentCode)
                .withProperties(updateProperties)
                .do();
              
              updated++;
              // Continue to process memoryFacts for updated contacts (fall through to memoryFacts processing)
            } else {
              skipped++;
              continue; // Skip memoryFacts if contact doesn't exist
            }
          } catch (updateError: any) {
            failed++;
            const errorMessage = updateError.response?.data?.error?.[0]?.message || updateError.message || 'Unknown error';
            errors.push({ identifier: contact.identifier, error: errorMessage });
            continue; // Skip memoryFacts if update failed
          }
        } else {
          // Skip if already exists (upsert: false)
          skipped++;
          continue; // Skip memoryFacts if contact exists and upsert is false
        }
      } else {
        // Create new contact if it doesn't exist
        try {
          const id = this.generateUserIdentityId(agentCode, contact.identifier);
          const dataString = typeof contact.data === 'string' 
            ? contact.data 
            : JSON.stringify(contact.data || {});

          // Use Weaviate client builder pattern (same as existing code)
          const builder = this.client.data
            .creator()
            .withClassName('UserIdentity')
            .withTenant(agentCode)
            .withId(id)
            .withProperties({
              identifier: contact.identifier,
              data: dataString,
              source: contact.source || 'api',
              last_updated: new Date().toISOString()
            });

          await builder.do();
          success++;
        } catch (error: any) {
          failed++;
          const errorMessage = error.response?.data?.error?.[0]?.message || error.message || 'Unknown error';
          
          // Check if error is because object already exists (409 or specific error)
          if (error.response?.status === 409 || errorMessage.includes('already exists')) {
            skipped++;
            failed--; // Don't count as failed if it's a duplicate
          } else {
            errors.push({ identifier: contact.identifier, error: errorMessage });
          }
          continue; // Skip memoryFacts if contact creation failed
        }
      }

      // Create MemoryFact records if provided (for both new and updated contacts)
      // This runs after contact is either created or updated
      if (contact.memoryFacts && Array.isArray(contact.memoryFacts) && contact.memoryFacts.length > 0) {
        console.log(`📝 [Contacts Create] Processing ${contact.memoryFacts.length} memoryFacts for contact ${contact.identifier} (upsert: ${upsert})`);
          for (const fact of contact.memoryFacts) {
            if (!fact.fact || typeof fact.fact !== 'string') {
              memoryFactsFailed++;
              memoryFactErrors.push({
                identifier: contact.identifier,
                fact: fact.fact || 'unknown',
                error: 'fact is required and must be a string'
              });
              continue;
            }

            try {
              // If upsert is true, check for similar facts (distance < 0.15 or high score) and replace them
              if (upsert) {
                const SIMILAR_FACT_DISTANCE_THRESHOLD = 0.15;
                const MIN_SIMILAR_SCORE = 0.3; // Minimum score for hybrid search to consider similar
                let foundSimilar = false;
                
                try {
                  console.log(`🔍 [Contacts Create] Searching for similar facts to "${fact.fact.substring(0, 50)}..." using hybrid search`);
                  // Use hybrid search to find both exact matches (BM25) and similar matches (vector)
                  const similarFactsResult = await this.client.graphql
                    .get()
                    .withClassName('MemoryFact')
                    .withTenant(agentCode)
                    .withFields('fact _additional { id distance score }')
                    .withWhere({
                      path: ['user_identifier'],
                      operator: 'Equal',
                      valueString: contact.identifier
                    })
                    .withHybrid({
                      query: fact.fact,
                      properties: ['fact'], // Search in the fact field
                      alpha: 0.5 // Balanced: 50% vector search, 50% BM25 (covers both exact and semantic matches)
                    })
                    .withLimit(10)
                    .do();

                  if (similarFactsResult.data?.Get?.MemoryFact) {
                    const similarFacts = similarFactsResult.data.Get.MemoryFact;
                    console.log(`📊 [Contacts Create] Found ${similarFacts.length} potentially similar facts via hybrid search`);

                    for (const similarFact of similarFacts) {
                      const distance = similarFact._additional?.distance;
                      const score = similarFact._additional?.score ? parseFloat(similarFact._additional.score) : 0;
                      const factText = similarFact.fact;
                      
                      // Check if it's similar enough: either low distance (semantic) or high score (keyword match)
                      const isSimilar = (distance !== null && distance !== undefined && parseFloat(distance) < SIMILAR_FACT_DISTANCE_THRESHOLD) ||
                                        (score >= MIN_SIMILAR_SCORE);
                      
                      console.log(`  - Fact: "${factText?.substring(0, 50)}..." distance: ${distance}, score: ${score}, isSimilar: ${isSimilar}`);
                      
                      if (isSimilar) {
                        // Replace the similar fact
                        const existingFactId = similarFact._additional?.id;
                        if (existingFactId) {
                          console.log(`🔄 [Contacts Create] Found similar fact (distance: ${distance}, score: ${score}) - replacing`);
                          await this.client.data
                            .merger()
                            .withId(existingFactId)
                            .withClassName('MemoryFact')
                            .withTenant(agentCode)
                            .withProperties({
                              user_identifier: contact.identifier,
                              category: fact.category || 'general',
                              fact: fact.fact,
                              confidence: fact.confidence !== undefined ? fact.confidence : 0.8,
                              source: fact.source || 'api',
                              last_used: new Date().toISOString()
                            })
                            .do();
                          
                          memoryFactsReplaced++;
                          foundSimilar = true;
                          break; // Only replace the first similar fact
                        }
                      }
                    }
                  } else {
                    console.log(`📊 [Contacts Create] No similar facts found via hybrid search`);
                  }
                } catch (similarSearchError: any) {
                  // If hybrid search fails, continue to create new fact
                  console.warn(`⚠️ [Contacts Create] Could not search for similar facts:`, similarSearchError.message);
                }

                if (foundSimilar) {
                  continue; // Skip creating a new fact since we replaced an existing one
                }
              }

              // Create new fact (if no similar fact was found/replaced)
              const factId = this.generateMemoryFactId();
              const factBuilder = this.client.data
                .creator()
                .withClassName('MemoryFact')
                .withTenant(agentCode)
                .withId(factId)
                .withProperties({
                  user_identifier: contact.identifier,
                  category: fact.category || 'general',
                  fact: fact.fact,
                  confidence: fact.confidence !== undefined ? fact.confidence : 0.8,
                  source: fact.source || 'api',
                  created_at: new Date().toISOString(),
                  last_used: new Date().toISOString()
                });

              await factBuilder.do();
              memoryFactsCreated++;
            } catch (factError: any) {
              memoryFactsFailed++;
              const factErrorMessage = factError.response?.data?.error?.[0]?.message || factError.message || 'Unknown error';
              memoryFactErrors.push({
                identifier: contact.identifier,
                fact: fact.fact,
                error: factErrorMessage
              });
            }
          }
        }
      }

    return {
      success,
      skipped,
      failed,
      updated: upsert ? updated : 0,
      memoryFactsCreated,
      memoryFactsFailed,
      memoryFactsReplaced: upsert ? memoryFactsReplaced : 0,
      ...(errors.length > 0 && { errors }),
      ...(memoryFactErrors.length > 0 && { memoryFactErrors })
    };
  }

  /**
   * Update UserIdentity contact (single update by identifier)
   * @param identifier - User identifier to update
   * @param updates - Object with data and/or source to update
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Updated contact object or null if not found
   */
  async updateUserContact(
    identifier: string,
    updates: {
      data?: any;
      source?: string;
    },
    agentCode: string
  ): Promise<any | null> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    if (!identifier) {
      throw new Error('identifier is required');
    }

    try {
      const id = this.generateUserIdentityId(agentCode, identifier);

      // First, get existing contact to merge updates (using Weaviate client)
      let existingContact: any = null;
      try {
        existingContact = await this.client.data
          .getterById()
          .withId(id)
          .withClassName('UserIdentity')
          .withTenant(agentCode)
          .do();
      } catch (getError: any) {
        if (getError.message?.includes('404') || getError.message?.includes('not found')) {
          return null; // Contact not found
        }
        throw getError;
      }

      if (!existingContact) {
        return null; // Contact not found
      }

      // Merge updates with existing data
      const existingData = existingContact.properties?.data;
      let dataString: string;
      
      if (updates.data !== undefined) {
        dataString = typeof updates.data === 'string' ? updates.data : JSON.stringify(updates.data);
      } else if (existingData) {
        dataString = typeof existingData === 'string' ? existingData : JSON.stringify(existingData);
      } else {
        dataString = '{}';
      }

      const updateProperties: any = {
        identifier: existingContact.properties?.identifier || identifier,
        data: dataString,
        source: updates.source !== undefined ? updates.source : (existingContact.properties?.source || 'api'),
        last_updated: new Date().toISOString()
      };

      // Update the contact using Weaviate client merger (same as existing code)
      await this.client.data
        .merger()
        .withId(id)
        .withClassName('UserIdentity')
        .withTenant(agentCode)
        .withProperties(updateProperties)
        .do();

      // Get updated contact to return
      const updated = await this.client.data
        .getterById()
        .withId(id)
        .withClassName('UserIdentity')
        .withTenant(agentCode)
        .do();

      // Parse data field
      let parsedData = {};
      if (updated.properties?.data) {
        try {
          parsedData = typeof updated.properties.data === 'string' 
            ? JSON.parse(updated.properties.data) 
            : updated.properties.data;
        } catch (parseError) {
          parsedData = {};
        }
      }

      return {
        identifier: updated.properties?.identifier || identifier,
        data: parsedData,
        source: updated.properties?.source,
        last_updated: updated.properties?.last_updated,
        _id: updated.id
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null; // Contact not found
      }
      throw new Error(`Failed to update contact: ${error.response?.data?.error?.[0]?.message || error.message}`);
    }
  }

  /**
   * Delete UserIdentity contacts (bulk delete by identifiers)
   * Also deletes associated MemoryFact records for each contact
   * @param identifiers - Array of user identifiers to delete
   * @param agentCode - Agent code from JWT (tenant for Weaviate) - REQUIRED
   * @returns Object with deleted count, failed count, and errors
   */
  async deleteUserContacts(
    identifiers: string[],
    agentCode: string
  ): Promise<{
    deleted: number;
    failed: number;
    memoryFactsDeleted: number;
    errors?: Array<{ identifier: string; error: string }>;
  }> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Weaviate service not initialized');
    }

    if (!agentCode) {
      throw new Error('agentCode is required');
    }

    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      throw new Error('identifiers must be a non-empty array');
    }

    let deleted = 0;
    let failed = 0;
    let memoryFactsDeleted = 0;
    const errors: Array<{ identifier: string; error: string }> = [];

    for (const identifier of identifiers) {
      if (!identifier || typeof identifier !== 'string') {
        failed++;
        errors.push({ identifier: identifier || 'unknown', error: 'identifier is required and must be a string' });
        continue;
      }

      try {
        const id = this.generateUserIdentityId(agentCode, identifier);

        // First, delete all MemoryFact records for this user
        try {
          // Get all MemoryFact records for this user
          const factsResult = await this.client.graphql
            .get()
            .withClassName('MemoryFact')
            .withTenant(agentCode)
            .withFields('_additional { id }')
            .withWhere({
              path: ['user_identifier'],
              operator: 'Equal',
              valueString: identifier
            })
            .withLimit(1000) // Get all facts (adjust if needed)
            .do();

          if (factsResult.data?.Get?.MemoryFact) {
            const facts = factsResult.data.Get.MemoryFact;
            console.log(`🗑️ [Contacts Delete] Found ${facts.length} MemoryFact records for ${identifier}`);

            // Delete each MemoryFact
            for (const fact of facts) {
              const factId = fact._additional?.id;
              if (factId) {
                try {
                  await this.client.data
                    .deleter()
                    .withId(factId)
                    .withClassName('MemoryFact')
                    .withTenant(agentCode)
                    .do();
                  memoryFactsDeleted++;
                } catch (factDeleteError: any) {
                  console.warn(`⚠️ [Contacts Delete] Could not delete MemoryFact ${factId}:`, factDeleteError.message);
                }
              }
            }
          }
        } catch (factsError: any) {
          console.warn(`⚠️ [Contacts Delete] Could not fetch/delete MemoryFact records for ${identifier}:`, factsError.message);
          // Continue to delete UserIdentity even if MemoryFact deletion fails
        }

        // Delete the UserIdentity contact
        await this.client.data
          .deleter()
          .withId(id)
          .withClassName('UserIdentity')
          .withTenant(agentCode)
          .do();

        deleted++;
        console.log(`✅ [Contacts Delete] Successfully deleted contact ${identifier}`);
      } catch (error: any) {
        failed++;
        const errorMessage = error.response?.data?.error?.[0]?.message || error.message || 'Unknown error';
        
        // Check if error is because object doesn't exist (404)
        if (error.response?.status === 404 || errorMessage.includes('not found') || errorMessage.includes('404')) {
          // Don't count as failed if it doesn't exist (idempotent delete)
          console.log(`ℹ️ [Contacts Delete] Contact ${identifier} not found (already deleted or never existed)`);
          deleted++; // Count as deleted for idempotency
          failed--; // Don't count as failed
        } else {
          errors.push({ identifier: identifier, error: errorMessage });
          console.error(`❌ [Contacts Delete] Failed to delete contact ${identifier}:`, errorMessage);
        }
      }
    }

    return {
      deleted,
      failed,
      memoryFactsDeleted,
      ...(errors.length > 0 && { errors })
    };
  }
}
